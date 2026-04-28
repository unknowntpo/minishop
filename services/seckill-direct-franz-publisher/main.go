package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

type publishInput struct {
	Brokers              []string `json:"brokers"`
	ClientID             string   `json:"clientId"`
	Topic                string   `json:"topic"`
	RunID                string   `json:"runId"`
	Total                int      `json:"total"`
	DurationMs           int      `json:"durationMs"`
	StartIndex           int      `json:"startIndex"`
	CollectResults       bool     `json:"collectResults"`
	DirectKafkaBatchSize int      `json:"directKafkaBatchSize"`
	SkuID                string   `json:"skuId"`
	UnitPriceAmountMinor int      `json:"unitPriceAmountMinor"`
	Currency             string   `json:"currency"`
	BuyerPrefix          string   `json:"buyerPrefix"`
	RequestedBuyClicks   int      `json:"requestedBuyClicks"`
	SeckillBucketCount   int      `json:"seckillBucketCount"`
	SeckillMaxProbe      int      `json:"seckillMaxProbe"`
	LingerMs             int      `json:"lingerMs"`
	MaxBufferedRecords   int      `json:"maxBufferedRecords"`
	RequiredAcks         string   `json:"requiredAcks"`
}

type publishOutput struct {
	Results   []acceptResult `json:"results"`
	NextIndex int            `json:"nextIndex"`
	Accepted  int            `json:"accepted"`
	Errors    int64          `json:"errors"`
}

type acceptResult struct {
	OK                 bool    `json:"ok"`
	Status             int     `json:"status"`
	LatencyMs          float64 `json:"latencyMs"`
	RequestStartedAtMs float64 `json:"requestStartedAtMs"`
	CommandID          string  `json:"commandId"`
	AcceptedAtMs       float64 `json:"acceptedAtMs"`
	Error              string  `json:"error,omitempty"`
}

type seckillRequest struct {
	SkuID             string         `json:"sku_id"`
	Quantity          int            `json:"quantity"`
	SeckillStockLimit int            `json:"seckill_stock_limit"`
	BucketCount       int            `json:"bucket_count"`
	PrimaryBucketID   int            `json:"primary_bucket_id"`
	BucketID          int            `json:"bucket_id"`
	Attempt           int            `json:"attempt"`
	MaxProbe          int            `json:"max_probe"`
	ProcessingKey     string         `json:"processing_key"`
	Command           seckillCommand `json:"command"`
}

type seckillCommand struct {
	CommandID      string          `json:"command_id"`
	CorrelationID  string          `json:"correlation_id"`
	BuyerID        string          `json:"buyer_id"`
	Items          []commandItem   `json:"items"`
	IdempotencyKey string          `json:"idempotency_key"`
	Metadata       commandMetadata `json:"metadata"`
	IssuedAt       string          `json:"issued_at"`
}

type commandItem struct {
	SkuID                string `json:"sku_id"`
	Quantity             int    `json:"quantity"`
	UnitPriceAmountMinor int    `json:"unit_price_amount_minor"`
	Currency             string `json:"currency"`
}

type commandMetadata struct {
	RequestID string `json:"request_id"`
	TraceID   string `json:"trace_id"`
	Source    string `json:"source"`
	ActorID   string `json:"actor_id"`
}

type pendingRecord struct {
	Index              int
	CommandID          string
	RequestStartedAtMs float64
	Started            time.Time
	Record             *kgo.Record
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}

	var input publishInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return fmt.Errorf("decode publish input: %w", err)
	}
	normalizeInput(&input)
	if err := validateInput(input); err != nil {
		return err
	}

	client, err := kgo.NewClient(
		kgo.SeedBrokers(input.Brokers...),
		kgo.ClientID(input.ClientID),
		kgo.RequiredAcks(requiredAcks(input.RequiredAcks)),
		kgo.RecordPartitioner(kgo.ManualPartitioner()),
		kgo.ProducerLinger(time.Duration(input.LingerMs)*time.Millisecond),
		kgo.MaxBufferedRecords(input.MaxBufferedRecords),
	)
	if err != nil {
		return fmt.Errorf("create franz-go client: %w", err)
	}
	defer client.Close()

	ctx := context.Background()
	if err := client.Ping(ctx); err != nil {
		return fmt.Errorf("ping broker: %w", err)
	}

	output, err := publish(ctx, client, input)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		return fmt.Errorf("encode output: %w", err)
	}
	fmt.Println(string(encoded))
	return nil
}

func normalizeInput(input *publishInput) {
	if input.ClientID == "" {
		input.ClientID = "seckill-direct-franz-publisher"
	}
	if input.DirectKafkaBatchSize <= 0 {
		input.DirectKafkaBatchSize = 500
	}
	if input.UnitPriceAmountMinor <= 0 {
		input.UnitPriceAmountMinor = 1200
	}
	if input.Currency == "" {
		input.Currency = "TWD"
	}
	if input.BuyerPrefix == "" {
		input.BuyerPrefix = "benchmark_buyer"
	}
	if input.SeckillBucketCount <= 0 {
		input.SeckillBucketCount = 4
	}
	if input.SeckillMaxProbe <= 0 {
		input.SeckillMaxProbe = 1
	}
	if input.MaxBufferedRecords <= 0 {
		input.MaxBufferedRecords = 10000
	}
}

func validateInput(input publishInput) error {
	if len(input.Brokers) == 0 {
		return errors.New("brokers is required")
	}
	if input.Topic == "" {
		return errors.New("topic is required")
	}
	if input.RunID == "" {
		return errors.New("runId is required")
	}
	if input.SkuID == "" {
		return errors.New("skuId is required")
	}
	if input.Total <= 0 && input.DurationMs <= 0 {
		return errors.New("total or durationMs is required")
	}
	if input.LingerMs < 0 {
		return errors.New("lingerMs must be non-negative")
	}
	return nil
}

func publish(ctx context.Context, client *kgo.Client, input publishInput) (publishOutput, error) {
	results := make([]acceptResult, 0, max(0, input.Total))
	nextIndex := input.StartIndex
	deadline := time.Time{}
	if input.DurationMs > 0 {
		deadline = time.Now().Add(time.Duration(input.DurationMs) * time.Millisecond)
	}

	var accepted int
	var errorCount int64
	for {
		if input.Total > 0 && accepted >= input.Total {
			break
		}
		if !deadline.IsZero() && time.Now().After(deadline) {
			break
		}

		batchSize := input.DirectKafkaBatchSize
		if input.Total > 0 && accepted+batchSize > input.Total {
			batchSize = input.Total - accepted
		}
		if batchSize <= 0 {
			break
		}

		batch, err := buildBatch(input, nextIndex, batchSize)
		if err != nil {
			return publishOutput{}, err
		}
		nextIndex += len(batch)

		batchResults, batchErrors := produceBatch(ctx, client, batch, input.CollectResults)
		errorCount += batchErrors
		if batchErrors > 0 {
			return publishOutput{}, fmt.Errorf("franz-go publish failed for %d record(s)", batchErrors)
		}
		accepted += len(batch)
		results = append(results, batchResults...)
	}

	return publishOutput{
		Results:   results,
		NextIndex: nextIndex,
		Accepted:  accepted,
		Errors:    errorCount,
	}, nil
}

func buildBatch(input publishInput, startIndex int, size int) ([]pendingRecord, error) {
	requestStartedAtMs := unixMillisFloat(time.Now())
	started := time.Now()
	batch := make([]pendingRecord, 0, size)

	for offset := 0; offset < size; offset++ {
		index := startIndex + offset
		request, err := buildRequest(input, index)
		if err != nil {
			return nil, err
		}
		payload, err := json.Marshal(request)
		if err != nil {
			return nil, fmt.Errorf("marshal request: %w", err)
		}
		batch = append(batch, pendingRecord{
			Index:              index,
			CommandID:          request.Command.CommandID,
			RequestStartedAtMs: requestStartedAtMs,
			Started:            started,
			Record: &kgo.Record{
				Topic:     input.Topic,
				Partition: int32(request.BucketID),
				Key:       []byte(request.ProcessingKey),
				Value:     payload,
			},
		})
	}

	return batch, nil
}

func produceBatch(
	ctx context.Context,
	client *kgo.Client,
	batch []pendingRecord,
	collectResults bool,
) ([]acceptResult, int64) {
	results := make([]acceptResult, len(batch))
	var wg sync.WaitGroup
	var errorsCount int64

	wg.Add(len(batch))
	for index, pending := range batch {
		index := index
		pending := pending
		client.Produce(ctx, pending.Record, func(_ *kgo.Record, err error) {
			acceptedAt := time.Now()
			if err != nil {
				atomic.AddInt64(&errorsCount, 1)
			}
			if collectResults {
				result := acceptResult{
					OK:                 err == nil,
					Status:             202,
					LatencyMs:          float64(acceptedAt.Sub(pending.Started).Microseconds()) / 1000,
					RequestStartedAtMs: pending.RequestStartedAtMs,
					CommandID:          pending.CommandID,
					AcceptedAtMs:       unixMillisFloat(acceptedAt),
				}
				if err != nil {
					result.OK = false
					result.Status = 0
					result.Error = err.Error()
				}
				results[index] = result
			}
			wg.Done()
		})
	}
	wg.Wait()

	if !collectResults {
		results = nil
	}
	return results, errorsCount
}

func buildRequest(input publishInput, index int) (seckillRequest, error) {
	commandID, err := uuid()
	if err != nil {
		return seckillRequest{}, err
	}
	correlationID, err := uuid()
	if err != nil {
		return seckillRequest{}, err
	}
	requestID, err := uuid()
	if err != nil {
		return seckillRequest{}, err
	}
	traceID, err := uuid()
	if err != nil {
		return seckillRequest{}, err
	}

	stableKey := fmt.Sprintf("%s-%d", input.RunID, index)
	bucketID := int(fnv1a32(stableKey) % uint32(input.SeckillBucketCount))
	processingKey := buildProcessingKey(input.SkuID, bucketID)
	buyerID := fmt.Sprintf("%s_%d", input.BuyerPrefix, index)
	stockLimit := input.RequestedBuyClicks
	if stockLimit <= 0 {
		stockLimit = input.Total
	}

	return seckillRequest{
		SkuID:             input.SkuID,
		Quantity:          1,
		SeckillStockLimit: stockLimit,
		BucketCount:       input.SeckillBucketCount,
		PrimaryBucketID:   bucketID,
		BucketID:          bucketID,
		Attempt:           0,
		MaxProbe:          input.SeckillMaxProbe,
		ProcessingKey:     processingKey,
		Command: seckillCommand{
			CommandID:     commandID,
			CorrelationID: correlationID,
			BuyerID:       buyerID,
			Items: []commandItem{
				{
					SkuID:                input.SkuID,
					Quantity:             1,
					UnitPriceAmountMinor: input.UnitPriceAmountMinor,
					Currency:             input.Currency,
				},
			},
			IdempotencyKey: stableKey,
			Metadata: commandMetadata{
				RequestID: requestID,
				TraceID:   traceID,
				Source:    "benchmark",
				ActorID:   buyerID,
			},
			IssuedAt: time.Now().UTC().Format(time.RFC3339Nano),
		},
	}, nil
}

func buildProcessingKey(skuID string, bucketID int) string {
	return fmt.Sprintf("%s#%02d", skuID, bucketID)
}

func fnv1a32(value string) uint32 {
	var hash uint32 = 0x811c9dc5
	for _, b := range []byte(value) {
		hash ^= uint32(b)
		hash *= 0x01000193
	}
	return hash
}

func uuid() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate uuid: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(b[:])
	return fmt.Sprintf(
		"%s-%s-%s-%s-%s",
		encoded[0:8],
		encoded[8:12],
		encoded[12:16],
		encoded[16:20],
		encoded[20:32],
	), nil
}

func unixMillisFloat(t time.Time) float64 {
	return float64(t.UnixNano()) / float64(time.Millisecond)
}

func requiredAcks(value string) kgo.Acks {
	switch value {
	case "none":
		return kgo.NoAck()
	case "leader":
		return kgo.LeaderAck()
	default:
		return kgo.AllISRAcks()
	}
}
