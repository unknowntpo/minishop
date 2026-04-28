package main

import (
	"bytes"
	"context"
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

type result struct {
	ok        bool
	status    int
	latencyMs float64
	err       string
}

func main() {
	target := flag.String("target", "http://127.0.0.1:3000", "base URL for go-backend")
	requests := flag.Int("requests", 10000, "total requests")
	concurrency := flag.Int("concurrency", 300, "concurrent workers")
	duration := flag.Duration("duration", 0, "duration for steady load; when set, requests is ignored")
	runID := flag.String("run-id", fmt.Sprintf("go-loadgen-%d", time.Now().UnixNano()), "run id for idempotency keys")
	flag.Parse()

	if *concurrency <= 0 || (*duration <= 0 && *requests <= 0) {
		fmt.Fprintln(os.Stderr, "concurrency must be positive; requests must be positive unless duration is set")
		os.Exit(2)
	}

	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        *concurrency * 2,
		MaxIdleConnsPerHost: *concurrency * 2,
		MaxConnsPerHost:     *concurrency,
		IdleConnTimeout:     90 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
	}

	resultLimit := *requests
	if *duration > 0 {
		resultLimit = 0
	}
	jobs := make(chan int)
	results := make([]result, resultLimit)
	var started int64
	var completed int64
	var accepted int64
	var failed int64

	start := time.Now()
	var wg sync.WaitGroup
	for worker := 0; worker < *concurrency; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				atomic.AddInt64(&started, 1)
				result := sendOne(client, *target, *runID, index)
				if *duration <= 0 {
					results[index] = result
				}
				if result.ok {
					atomic.AddInt64(&accepted, 1)
				} else {
					atomic.AddInt64(&failed, 1)
				}
				atomic.AddInt64(&completed, 1)
			}
		}()
	}

	if *duration > 0 {
		deadline := time.Now().Add(*duration)
		for index := 0; time.Now().Before(deadline); index++ {
			jobs <- index
		}
	} else {
		for index := 0; index < *requests; index++ {
			jobs <- index
		}
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(start)

	okCount := int(atomic.LoadInt64(&accepted))
	statusCounts := map[int]int{}
	errorCounts := map[string]int{}
	latencies := make([]float64, 0, len(results))
	for _, result := range results {
		statusCounts[result.status]++
		if result.ok {
			latencies = append(latencies, result.latencyMs)
			continue
		}
		errorCounts[result.err]++
	}
	sort.Float64s(latencies)

	fmt.Printf("target=%s\n", *target)
	fmt.Printf("requests=%d duration=%s concurrency=%d started=%d completed=%d accepted=%d errors=%d\n", *requests, duration.String(), *concurrency, started, completed, okCount, failed)
	fmt.Printf("duration_ms=%.3f rps=%.2f\n", float64(elapsed.Microseconds())/1000, float64(okCount)/elapsed.Seconds())
	if len(latencies) > 0 {
		fmt.Printf("latency_ms p50=%.3f p90=%.3f p95=%.3f p99=%.3f max=%.3f\n", percentile(latencies, 50), percentile(latencies, 90), percentile(latencies, 95), percentile(latencies, 99), percentile(latencies, 100))
		fmt.Printf("status_counts=%v\n", statusCounts)
	}
	if len(errorCounts) > 0 {
		fmt.Printf("error_counts=%v\n", errorCounts)
	}
}

func sendOne(client *http.Client, target string, runID string, index int) result {
	payload := fmt.Sprintf(`{"buyerId":"go_loadgen_buyer_%d","items":[{"skuId":"sku_hot_001","quantity":1,"unitPriceAmountMinor":1200,"currency":"TWD"}]}`, index)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, target+"/api/buy-intents", bytes.NewBufferString(payload))
	if err != nil {
		return result{err: err.Error()}
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("idempotency-key", fmt.Sprintf("%s-%d", runID, index))
	req.Header.Set("x-request-id", fmt.Sprintf("go-loadgen-request-%d", index))
	req.Header.Set("x-trace-id", fmt.Sprintf("go-loadgen-trace-%d", index))

	start := time.Now()
	resp, err := client.Do(req)
	latencyMs := float64(time.Since(start).Microseconds()) / 1000
	if err != nil {
		return result{latencyMs: latencyMs, err: err.Error()}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	return result{
		ok:        resp.StatusCode == http.StatusAccepted,
		status:    resp.StatusCode,
		latencyMs: latencyMs,
	}
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
