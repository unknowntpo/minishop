package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type inputConfig struct {
	TargetURLs           []string `json:"targetUrls"`
	Requests             int      `json:"requests"`
	Concurrency          int      `json:"concurrency"`
	RunID                string   `json:"runId"`
	SkuID                string   `json:"skuId"`
	BuyerPrefix          string   `json:"buyerPrefix"`
	UnitPriceAmountMinor int      `json:"unitPriceAmountMinor"`
	Currency             string   `json:"currency"`
	CollectResults       bool     `json:"collectResults"`
}

type output struct {
	Results    []acceptResult `json:"results"`
	Accepted   int            `json:"accepted"`
	Errors     int            `json:"errors"`
	DurationMs float64        `json:"durationMs"`
	RPS        float64        `json:"rps"`
}

type acceptResult struct {
	OK                 bool    `json:"ok"`
	Status             int     `json:"status"`
	LatencyMs          float64 `json:"latencyMs"`
	RequestStartedAtMs float64 `json:"requestStartedAtMs,omitempty"`
	CommandID          string  `json:"commandId,omitempty"`
	Error              string  `json:"error,omitempty"`
	AcceptedAtMs       float64 `json:"acceptedAtMs,omitempty"`
}

type acceptResponse struct {
	CommandID string `json:"commandId"`
}

func main() {
	if len(os.Args) > 1 {
		runCLI()
		return
	}
	if err := runJSON(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runJSON() error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}
	var input inputConfig
	if err := json.Unmarshal(raw, &input); err != nil {
		return fmt.Errorf("decode input: %w", err)
	}
	normalizeInput(&input)
	out, err := run(input)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return fmt.Errorf("encode output: %w", err)
	}
	fmt.Println(string(encoded))
	return nil
}

func runCLI() {
	target := flag.String("target", "http://127.0.0.1:3000", "base URL for go-backend")
	requests := flag.Int("requests", 10000, "total requests")
	concurrency := flag.Int("concurrency", 300, "concurrent workers")
	runID := flag.String("run-id", fmt.Sprintf("go-loadgen-%d", time.Now().UnixNano()), "run id for idempotency keys")
	flag.Parse()

	input := inputConfig{
		TargetURLs:           []string{*target},
		Requests:             *requests,
		Concurrency:          *concurrency,
		RunID:                *runID,
		SkuID:                "sku_hot_001",
		BuyerPrefix:          "go_loadgen_buyer",
		UnitPriceAmountMinor: 1200,
		Currency:             "TWD",
		CollectResults:       true,
	}
	normalizeInput(&input)
	out, err := run(input)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	latencies := make([]float64, 0, len(out.Results))
	statusCounts := map[int]int{}
	errorCounts := map[string]int{}
	for _, result := range out.Results {
		statusCounts[result.Status]++
		if result.OK {
			latencies = append(latencies, result.LatencyMs)
		} else {
			errorCounts[result.Error]++
		}
	}
	sort.Float64s(latencies)
	fmt.Printf("target=%s\n", input.TargetURLs[0])
	fmt.Printf("requests=%d concurrency=%d accepted=%d errors=%d\n", input.Requests, input.Concurrency, out.Accepted, out.Errors)
	fmt.Printf("duration_ms=%.3f rps=%.2f\n", out.DurationMs, out.RPS)
	if len(latencies) > 0 {
		fmt.Printf("latency_ms p50=%.3f p90=%.3f p95=%.3f p99=%.3f max=%.3f\n", percentile(latencies, 50), percentile(latencies, 90), percentile(latencies, 95), percentile(latencies, 99), percentile(latencies, 100))
		fmt.Printf("status_counts=%v\n", statusCounts)
	}
	if len(errorCounts) > 0 {
		fmt.Printf("error_counts=%v\n", errorCounts)
	}
}

func normalizeInput(input *inputConfig) {
	if len(input.TargetURLs) == 0 {
		input.TargetURLs = []string{"http://127.0.0.1:3000"}
	}
	if input.Requests <= 0 {
		input.Requests = 10000
	}
	if input.Concurrency <= 0 {
		input.Concurrency = 300
	}
	if input.RunID == "" {
		input.RunID = fmt.Sprintf("go-http-%d", time.Now().UnixNano())
	}
	if input.SkuID == "" {
		input.SkuID = "sku_hot_001"
	}
	if input.BuyerPrefix == "" {
		input.BuyerPrefix = "benchmark_buyer"
	}
	if input.UnitPriceAmountMinor <= 0 {
		input.UnitPriceAmountMinor = 1200
	}
	if input.Currency == "" {
		input.Currency = "TWD"
	}
}

func run(input inputConfig) (output, error) {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        input.Concurrency * 2,
		MaxIdleConnsPerHost: input.Concurrency * 2,
		MaxConnsPerHost:     input.Concurrency,
		IdleConnTimeout:     90 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
	}

	jobs := make(chan int)
	results := make([]acceptResult, input.Requests)
	var accepted int64
	var failed int64

	start := time.Now()
	var wg sync.WaitGroup
	for worker := 0; worker < input.Concurrency; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				result := sendOne(client, input, index)
				results[index] = result
				if result.OK {
					atomic.AddInt64(&accepted, 1)
				} else {
					atomic.AddInt64(&failed, 1)
				}
			}
		}()
	}

	for index := 0; index < input.Requests; index++ {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(start)

	if !input.CollectResults {
		results = nil
	}
	acceptedCount := int(atomic.LoadInt64(&accepted))
	return output{
		Results:    results,
		Accepted:   acceptedCount,
		Errors:     int(atomic.LoadInt64(&failed)),
		DurationMs: float64(elapsed.Microseconds()) / 1000,
		RPS:        float64(acceptedCount) / elapsed.Seconds(),
	}, nil
}

func sendOne(client *http.Client, input inputConfig, index int) acceptResult {
	startedAt := time.Now()
	target := input.TargetURLs[index%len(input.TargetURLs)]
	payload := fmt.Sprintf(`{"buyerId":"%s_%d","items":[{"skuId":"%s","quantity":1,"unitPriceAmountMinor":%d,"currency":"%s"}]}`, input.BuyerPrefix, index, input.SkuID, input.UnitPriceAmountMinor, input.Currency)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, target+"/api/buy-intents", bytes.NewBufferString(payload))
	if err != nil {
		return acceptResult{Status: 0, LatencyMs: 0, Error: err.Error(), RequestStartedAtMs: unixMillisFloat(startedAt)}
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("idempotency-key", fmt.Sprintf("%s-%d", input.RunID, index))
	req.Header.Set("x-request-id", fmt.Sprintf("%s-request-%d", input.RunID, index))
	req.Header.Set("x-trace-id", fmt.Sprintf("%s-trace-%d", input.RunID, index))

	resp, err := client.Do(req)
	acceptedAt := time.Now()
	latencyMs := float64(acceptedAt.Sub(startedAt).Microseconds()) / 1000
	if err != nil {
		return acceptResult{Status: 0, LatencyMs: latencyMs, Error: err.Error(), RequestStartedAtMs: unixMillisFloat(startedAt)}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusAccepted {
		return acceptResult{
			Status:             resp.StatusCode,
			LatencyMs:          latencyMs,
			Error:              fmt.Sprintf("HTTP %d", resp.StatusCode),
			RequestStartedAtMs: unixMillisFloat(startedAt),
		}
	}

	var decoded acceptResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return acceptResult{
			Status:             resp.StatusCode,
			LatencyMs:          latencyMs,
			Error:              "decode_response: " + err.Error(),
			RequestStartedAtMs: unixMillisFloat(startedAt),
		}
	}
	return acceptResult{
		OK:                 true,
		Status:             resp.StatusCode,
		LatencyMs:          latencyMs,
		RequestStartedAtMs: unixMillisFloat(startedAt),
		CommandID:          decoded.CommandID,
		AcceptedAtMs:       unixMillisFloat(acceptedAt),
	}
}

func unixMillisFloat(t time.Time) float64 {
	return float64(t.UnixNano()) / 1e6
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	if p <= 0 {
		return sorted[0]
	}
	if p >= 100 {
		return sorted[len(sorted)-1]
	}
	index := int((p / 100) * float64(len(sorted)-1))
	return sorted[index]
}
