## Architecture

The Go ingress is a benchmark-only sibling to the existing Next.js API route.

```text
benchmark runner
  -> go-seckill-ingress /api/buy-intents
  -> inventory.seckill.requested
  -> worker-seckill
  -> inventory.seckill.result
  -> worker-seckill-result-sink
  -> command_status / event_store
```

The existing Next.js app remains the control-plane endpoint for:

- `/api/buy-intent-commands/:id`
- profiling endpoints
- any non-seckill routes

This allows the benchmark to isolate ingress runtime changes without changing the downstream compatibility path.

## Behavior

The Go service intentionally implements only the seckill-only subset:

- accepts exactly one item
- requires the SKU to be `seckill_enabled`
- rejects multi-item / mixed-cart / non-seckill requests with `400/422`
- returns the same success contract as the current API route:
  - `202`
  - `commandId`
  - `correlationId`
  - `status=accepted`

The request published to Kafka preserves the existing `SeckillBuyIntentRequest` schema and trace headers.

## Routing and cache

The Go service mirrors the existing routing logic:

- reads `sku.seckill_enabled`
- reads `sku.seckill_stock_limit`
- keeps a process-local TTL cache
- uses the same FNV-1a bucket selection and processing key format

## Benchmark integration

The benchmark runner now supports two URL groups:

- `BENCHMARK_APP_URL` / `BENCHMARK_APP_URLS`
  - the control app used for status/profiling/read-model calls
- `BENCHMARK_INGRESS_APP_URLS`
  - the ingress target(s) used only for `POST /api/buy-intents`

This separation is necessary for the Go benchmark because the Go service only owns the ingress path.

`BENCHMARK_INGRESS_HEALTH_PATH` makes ingress preflight generic, so non-Next.js services can expose a lightweight health endpoint such as `/healthz`.

## Tracing

The Go service:

- creates a server span for `/api/buy-intents`
- creates a producer span for Kafka publish
- injects `traceparent`, `tracestate`, and `baggage` into Kafka headers

This allows the existing `worker-seckill` and `worker-seckill-result-sink` services to continue the same trace.

## First benchmark result

Under the same steady-state settings:

- `bucket=4`
- `maxProbe=4`
- `concurrency=200`
- `warmup=2s`
- `measure=5s`
- `cooldown=2s`

Results:

- Next.js ingress:
  - `queued/sec = 1098.6`
  - `result topic throughput = 1086.02`
  - `p95 = 285.46ms`
- Go ingress:
  - `queued/sec = 2421.8`
  - `result topic throughput = 1142.81`
  - `p95 = 260.53ms`

Interpretation:

- The Go ingress materially increases admission throughput.
- Downstream result throughput moves only slightly, which implies the bottleneck shifts from ingress into the existing Kafka/worker/result path.
