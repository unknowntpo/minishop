package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/IBM/sarama"
	"github.com/twmb/franz-go/pkg/kgo"
)

type config struct {
	brokers         []string
	client          string
	compression     string
	concurrency     int
	lingerMs        int
	messageBytes    int
	messages        int
	partitions      int32
	replication     int16
	resultsDir      string
	runID           string
	scenarioName    string
	topic           string
	topicPrefix     string
}

type benchmarkReport struct {
	SchemaVersion int    `json:"schemaVersion"`
	RunID         string `json:"runId"`
	ScenarioName  string `json:"scenarioName"`
	ScenarioTags  map[string]string `json:"scenarioTags"`
	StartedAt     string `json:"startedAt"`
	FinishedAt    string `json:"finishedAt"`
	Pass          bool   `json:"pass"`
	Environment   struct {
		Runtime string `json:"runtime"`
		Kafka   string `json:"kafka"`
	} `json:"environment"`
	RequestPath struct {
		Accepted        int     `json:"accepted"`
		Errors          int     `json:"errors"`
		P95LatencyMs    float64 `json:"p95LatencyMs"`
		RequestsPerSecond float64 `json:"requestsPerSecond"`
	} `json:"requestPath"`
	Failure *struct {
		Stage   string `json:"stage"`
		Message string `json:"message"`
	} `json:"failure,omitempty"`
	Diagnostics struct {
		Assertions []struct {
			Key      string `json:"key"`
			Label    string `json:"label"`
			Pass     bool   `json:"pass"`
			Severity string `json:"severity"`
			Message  string `json:"message,omitempty"`
		} `json:"assertions"`
	} `json:"diagnostics"`
	Measurements []struct {
		Key            string  `json:"key"`
		Label          string  `json:"label"`
		Unit           string  `json:"unit"`
		Value          float64 `json:"value"`
		Definition     string  `json:"definition,omitempty"`
		Calculation    string  `json:"calculation,omitempty"`
		Interpretation string  `json:"interpretation,omitempty"`
	} `json:"measurements"`
}

type result struct {
	latency time.Duration
	err     error
}

func main() {
	cfg := readConfig()
	startedAt := time.Now().UTC()
	if err := ensureTopic(cfg); err != nil {
		writeFailureArtifact(cfg, startedAt, fmt.Errorf("ensure topic: %w", err))
		fail(err)
	}

	latencies, errorCount, err := runBenchmark(cfg)
	if err != nil {
		writeFailureArtifact(cfg, startedAt, err)
		fail(err)
	}

	report := buildReport(cfg, startedAt, latencies, errorCount)
	artifactPath, err := writeArtifact(cfg, report)
	if err != nil {
		fail(fmt.Errorf("write artifact: %w", err))
	}

	fmt.Printf("artifact written to %s\n", artifactPath)
}

func readConfig() config {
	runID := envDefault("GO_KAFKA_BENCH_RUN_ID", fmt.Sprintf("go_kafka_raw_%s_%s", envDefault("GO_KAFKA_BENCH_CLIENT", "franz-go"), time.Now().UTC().Format("20060102T150405Z")))
	return config{
		brokers:      splitCSV(envDefault("GO_KAFKA_BENCH_BROKERS", envDefault("KAFKA_BROKERS", "localhost:19092"))),
		client:       envDefault("GO_KAFKA_BENCH_CLIENT", "franz-go"),
		compression:  envDefault("GO_KAFKA_BENCH_COMPRESSION", "none"),
		concurrency:  envInt("GO_KAFKA_BENCH_CONCURRENCY", 1024),
		lingerMs:     envInt("GO_KAFKA_BENCH_LINGER_MS", 5),
		messageBytes: envInt("GO_KAFKA_BENCH_MESSAGE_BYTES", 1024),
		messages:     envInt("GO_KAFKA_BENCH_MESSAGES", 50000),
		partitions:   int32(envInt("GO_KAFKA_BENCH_TOPIC_PARTITIONS", 12)),
		replication:  int16(envInt("GO_KAFKA_BENCH_TOPIC_REPLICATION", 1)),
		resultsDir:   envDefault("BENCHMARK_RESULTS_DIR", "benchmark-results"),
		runID:        runID,
		scenarioName: envDefault("BENCHMARK_SCENARIO_NAME", "go-kafka-producer-raw"),
		topic:        envDefault("GO_KAFKA_BENCH_TOPIC", ""),
		topicPrefix:  envDefault("GO_KAFKA_BENCH_TOPIC_PREFIX", "benchmark.go.kafka.client.raw"),
	}
}

func ensureTopic(cfg config) error {
	saramaCfg := sarama.NewConfig()
	saramaCfg.Version = sarama.V3_6_0_0
	admin, err := sarama.NewClusterAdmin(cfg.brokers, saramaCfg)
	if err != nil {
		return err
	}
	defer func() { _ = admin.Close() }()

	topic := topicName(cfg)
	err = admin.CreateTopic(topic, &sarama.TopicDetail{
		NumPartitions:     cfg.partitions,
		ReplicationFactor: cfg.replication,
	}, false)
	if err != nil && !errors.Is(err, sarama.ErrTopicAlreadyExists) {
		return err
	}
	return nil
}

func runBenchmark(cfg config) ([]time.Duration, int64, error) {
	switch cfg.client {
	case "franz-go":
		return runFranzBenchmark(cfg)
	case "sarama":
		return runSaramaBenchmark(cfg)
	default:
		return nil, 0, fmt.Errorf("unsupported GO_KAFKA_BENCH_CLIENT %q", cfg.client)
	}
}

func runFranzBenchmark(cfg config) ([]time.Duration, int64, error) {
	client, err := kgo.NewClient(
		kgo.SeedBrokers(cfg.brokers...),
		kgo.ClientID("go-kafka-client-bench-franz"),
		kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.ProducerLinger(time.Duration(cfg.lingerMs)*time.Millisecond),
		kgo.ProducerBatchCompression(franzCompression(cfg.compression)),
	)
	if err != nil {
		return nil, 0, err
	}
	defer client.Close()
	if err := client.Ping(context.Background()); err != nil {
		return nil, 0, err
	}

	return produceWithSemaphore(cfg, func(index int, done func(time.Duration, error)) {
		started := time.Now()
		client.Produce(context.Background(), &kgo.Record{
			Topic: topicName(cfg),
			Key:   []byte(fmt.Sprintf("franz-%d", index)),
			Value: payloadForIndex(cfg.messageBytes, index),
		}, func(_ *kgo.Record, err error) {
			done(time.Since(started), err)
		})
	})
}

func runSaramaBenchmark(cfg config) ([]time.Duration, int64, error) {
	saramaCfg := sarama.NewConfig()
	saramaCfg.Version = sarama.V3_6_0_0
	saramaCfg.Producer.RequiredAcks = sarama.WaitForAll
	saramaCfg.Producer.Return.Successes = true
	saramaCfg.Producer.Return.Errors = true
	saramaCfg.Producer.Timeout = 10 * time.Second
	saramaCfg.Producer.Flush.Frequency = time.Duration(cfg.lingerMs) * time.Millisecond
	saramaCfg.Producer.Compression = saramaCompression(cfg.compression)

	producer, err := sarama.NewAsyncProducer(cfg.brokers, saramaCfg)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = producer.Close() }()

	results := make(chan result, cfg.messages)
	semaphore := make(chan struct{}, cfg.concurrency)

	go func() {
		for msg := range producer.Successes() {
			started, _ := msg.Metadata.(time.Time)
			results <- result{latency: time.Since(started)}
			<-semaphore
		}
	}()
	go func() {
		for msgErr := range producer.Errors() {
			started, _ := msgErr.Msg.Metadata.(time.Time)
			results <- result{latency: time.Since(started), err: msgErr.Err}
			<-semaphore
		}
	}()

	for index := 0; index < cfg.messages; index++ {
		semaphore <- struct{}{}
		producer.Input() <- &sarama.ProducerMessage{
			Topic:    topicName(cfg),
			Key:      sarama.StringEncoder(fmt.Sprintf("sarama-%d", index)),
			Value:    sarama.ByteEncoder(payloadForIndex(cfg.messageBytes, index)),
			Metadata: time.Now(),
		}
	}

	latencies := make([]time.Duration, 0, cfg.messages)
	var errorCount int64
	for received := 0; received < cfg.messages; received++ {
		entry := <-results
		latencies = append(latencies, entry.latency)
		if entry.err != nil {
			errorCount++
		}
	}
	return latencies, errorCount, nil
}

func produceWithSemaphore(cfg config, submit func(index int, done func(time.Duration, error))) ([]time.Duration, int64, error) {
	results := make(chan result, cfg.messages)
	semaphore := make(chan struct{}, cfg.concurrency)
	var wg sync.WaitGroup

	for index := 0; index < cfg.messages; index++ {
		semaphore <- struct{}{}
		wg.Add(1)
		submit(index, func(latency time.Duration, err error) {
			results <- result{latency: latency, err: err}
			<-semaphore
			wg.Done()
		})
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	latencies := make([]time.Duration, 0, cfg.messages)
	var errorCount int64
	for entry := range results {
		latencies = append(latencies, entry.latency)
		if entry.err != nil {
			errorCount++
		}
	}
	return latencies, errorCount, nil
}

func buildReport(cfg config, startedAt time.Time, latencies []time.Duration, errorCount int64) benchmarkReport {
	finishedAt := time.Now().UTC()
	totalDuration := finishedAt.Sub(startedAt)
	accepted := len(latencies) - int(errorCount)
	if accepted < 0 {
		accepted = 0
	}
	p95 := percentileDuration(latencies, 95)
	throughput := float64(accepted) / math.Max(totalDuration.Seconds(), 0.001)
	bytesPerSecond := float64(accepted*cfg.messageBytes) / math.Max(totalDuration.Seconds(), 0.001)

	report := benchmarkReport{
		SchemaVersion: 2,
		RunID:         cfg.runID,
		ScenarioName:  cfg.scenarioName,
		ScenarioTags: map[string]string{
			"client":       cfg.client,
			"compression":  cfg.compression,
			"concurrency":  strconv.Itoa(cfg.concurrency),
			"lingerMs":     strconv.Itoa(cfg.lingerMs),
			"messageBytes": strconv.Itoa(cfg.messageBytes),
			"messages":     strconv.Itoa(cfg.messages),
		},
		StartedAt:  startedAt.Format(time.RFC3339),
		FinishedAt: finishedAt.Format(time.RFC3339),
		Pass:       errorCount == 0,
	}
	report.Environment.Runtime = "go"
	report.Environment.Kafka = strings.Join(cfg.brokers, ",")
	report.RequestPath.Accepted = accepted
	report.RequestPath.Errors = int(errorCount)
	report.RequestPath.P95LatencyMs = durationMs(p95)
	report.RequestPath.RequestsPerSecond = round2(throughput)

	if errorCount > 0 {
		report.Failure = &struct {
			Stage   string `json:"stage"`
			Message string `json:"message"`
		}{
			Stage:   "publish",
			Message: fmt.Sprintf("%d publish operations returned errors.", errorCount),
		}
	}

	report.Diagnostics.Assertions = append(report.Diagnostics.Assertions, struct {
		Key      string `json:"key"`
		Label    string `json:"label"`
		Pass     bool   `json:"pass"`
		Severity string `json:"severity"`
		Message  string `json:"message,omitempty"`
	}{
		Key:      "run.completed_successfully",
		Label:    "run completed successfully",
		Pass:     errorCount == 0,
		Severity: "error",
		Message:  fmt.Sprintf("accepted=%d errors=%d", accepted, errorCount),
	})

	report.Measurements = append(report.Measurements,
		measurement("produce_throughput", "produce throughput", "/s", round2(throughput),
			"Acknowledged Kafka produce throughput across the benchmark window.",
			"accepted publishes / total benchmark seconds",
			"Higher is better when error count remains zero."),
		measurement("producer_p95_latency", "producer p95 latency", "ms", durationMs(p95),
			"95th percentile producer acknowledgement latency.",
			"95th percentile of per-message publish-to-ack latency",
			"Lower is better. Spikes indicate producer queueing, broker backpressure, or batching overhead."),
		measurement("bytes_throughput", "bytes throughput", "B/s", round2(bytesPerSecond),
			"Acknowledged payload bytes per second.",
			"(accepted publishes * message bytes) / total benchmark seconds",
			"Useful to compare throughput when message size changes."),
		measurement("errors", "errors", "", float64(errorCount),
			"Publish operations that returned an error.",
			"count of produce callbacks / deliveries with err != nil",
			"Should remain at zero for valid throughput comparison."),
	)

	return report
}

func measurement(key string, label string, unit string, value float64, definition string, calculation string, interpretation string) struct {
	Key            string  `json:"key"`
	Label          string  `json:"label"`
	Unit           string  `json:"unit"`
	Value          float64 `json:"value"`
	Definition     string  `json:"definition,omitempty"`
	Calculation    string  `json:"calculation,omitempty"`
	Interpretation string  `json:"interpretation,omitempty"`
} {
	return struct {
		Key            string  `json:"key"`
		Label          string  `json:"label"`
		Unit           string  `json:"unit"`
		Value          float64 `json:"value"`
		Definition     string  `json:"definition,omitempty"`
		Calculation    string  `json:"calculation,omitempty"`
		Interpretation string  `json:"interpretation,omitempty"`
	}{
		Key:            key,
		Label:          label,
		Unit:           unit,
		Value:          value,
		Definition:     definition,
		Calculation:    calculation,
		Interpretation: interpretation,
	}
}

func writeArtifact(cfg config, report benchmarkReport) (string, error) {
	directory := filepath.Join(cfg.resultsDir, cfg.scenarioName)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", err
	}
	fileName := fmt.Sprintf("%s_%s.json", time.Now().UTC().Format("2006-01-02T15-04-05-000Z"), cfg.runID)
	target := filepath.Join(directory, fileName)
	body, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(target, append(body, '\n'), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

func writeFailureArtifact(cfg config, startedAt time.Time, benchmarkErr error) {
	report := benchmarkReport{
		SchemaVersion: 2,
		RunID:         cfg.runID,
		ScenarioName:  cfg.scenarioName,
		ScenarioTags: map[string]string{
			"client": cfg.client,
		},
		StartedAt:  startedAt.Format(time.RFC3339),
		FinishedAt: time.Now().UTC().Format(time.RFC3339),
		Pass:       false,
		Failure: &struct {
			Stage   string `json:"stage"`
			Message string `json:"message"`
		}{
			Stage:   "benchmark",
			Message: benchmarkErr.Error(),
		},
	}
	report.Diagnostics.Assertions = append(report.Diagnostics.Assertions, struct {
		Key      string `json:"key"`
		Label    string `json:"label"`
		Pass     bool   `json:"pass"`
		Severity string `json:"severity"`
		Message  string `json:"message,omitempty"`
	}{
		Key:      "run.completed_successfully",
		Label:    "run completed successfully",
		Pass:     false,
		Severity: "error",
		Message:  benchmarkErr.Error(),
	})
	_, _ = writeArtifact(cfg, report)
}

func topicName(cfg config) string {
	if cfg.topic != "" {
		return cfg.topic
	}
	return fmt.Sprintf("%s.%s", cfg.topicPrefix, cfg.client)
}

func payloadForIndex(size int, index int) []byte {
	if size < 16 {
		size = 16
	}
	prefix := fmt.Sprintf("msg-%08d-", index)
	if len(prefix) >= size {
		return []byte(prefix[:size])
	}
	body := make([]byte, size)
	copy(body, []byte(prefix))
	for i := len(prefix); i < size; i++ {
		body[i] = byte('a' + (i % 26))
	}
	return body
}

func percentileDuration(values []time.Duration, percentile float64) time.Duration {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	index := int(math.Ceil((percentile/100)*float64(len(sorted)))) - 1
	if index < 0 {
		index = 0
	}
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	return sorted[index]
}

func franzCompression(name string) kgo.CompressionCodec {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "gzip":
		return kgo.GzipCompression()
	case "snappy":
		return kgo.SnappyCompression()
	case "lz4":
		return kgo.Lz4Compression()
	case "zstd":
		return kgo.ZstdCompression()
	default:
		return kgo.NoCompression()
	}
}

func saramaCompression(name string) sarama.CompressionCodec {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "gzip":
		return sarama.CompressionGZIP
	case "snappy":
		return sarama.CompressionSnappy
	case "lz4":
		return sarama.CompressionLZ4
	case "zstd":
		return sarama.CompressionZSTD
	default:
		return sarama.CompressionNone
	}
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func envDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func envInt(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func durationMs(value time.Duration) float64 {
	return round2(float64(value) / float64(time.Millisecond))
}

func round2(value float64) float64 {
	return math.Round(value*100) / 100
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(1)
}
