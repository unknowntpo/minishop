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

## Trace-guided bottleneck findings

Recent end-to-end traces for the Go seckill ingress show that ingress runtime is no longer the dominant cost.

Observed shape:

- `go-seckill-ingress`
  - request handling was on the order of `~50ms`
  - `buy_intent.lookup_seckill_sku` was `~10-20ms`
  - `buy_intent.publish_seckill_go` was `~30ms`
- `worker-seckill`
  - multiple `inventory.seckill.requested publish` spans appeared back-to-back at `~100ms` each
  - this indicates retry/reroute cycles inside the topology
- `worker-seckill-result-sink`
  - `pg-pool.connect` was still visible and non-trivial

Interpretation:

- reroute/retry in the Kafka Streams worker is now a larger contributor to tail latency than the Go ingress itself
- result-sink PG connection reuse also remains a meaningful cost
- next optimization work should prioritize:
  - reducing retry/reroute pressure
  - improving result-sink connection reuse
  - only then revisiting ingress publish tuning

## Bun + Next.js experiment

A local experiment attempted to run the existing Next.js app under Bun instead of Node to compare seckill HTTP ingress throughput.

Results:

- `bun --bun next start` initially failed because Next 16 startup touched `node:inspector.url()`, which Bun 1.0.23 does not implement
- after a local non-repo patch to guard the `inspector.url()` call, the server reported `Ready`
- however, the Bun-served app still timed out on both:
  - `GET /products`
  - `POST /api/buy-intents`

Conclusion:

- the current repository is not benchmark-ready on Bun
- no valid Bun benchmark artifact was produced
- Bun should currently be treated as an incompatible runtime experiment rather than a completed ingress comparison

## `franz-go` producer experiment

The Go seckill ingress producer was also reimplemented with `franz-go` to compare it with the original `segmentio/kafka-go` producer under the same benchmark conditions:

- `scenario=buy-intent-hot-seckill`
- `style=steady_state`
- `concurrency=200`
- `bucket=4`
- `maxProbe=4`
- `path=seckill_only`
- existing Kotlin `worker-seckill` unchanged
- existing Go result sink unchanged

Reference baseline (`kafka-go` producer, Go ingress + Go sink):

- `queued/sec = 2111.6`
- `result topic throughput = 2064.76`
- `p95 = 239.68ms`

Three `franz-go` reruns under the same conditions produced:

- run 1:
  - `queued/sec = 2132.6`
  - `result topic throughput = 2096.62`
  - `p95 = 271.98ms`
- run 2:
  - `queued/sec = 1208.2`
  - `result topic throughput = 1187.32`
  - `p95 = 373.95ms`
- run 3:
  - `queued/sec = 2489.4`
  - `result topic throughput = 2469.52`
  - `p95 = 199.18ms`

Interpretation:

- `franz-go` did not show a stable, repeatable throughput win in this setup
- observed variance was larger than the mean difference from the `kafka-go` baseline
- the median `franz-go` run was effectively at parity with the prior Go ingress baseline
- this reinforces the earlier trace-guided conclusion that ingress producer choice is no longer the dominant bottleneck; retry / reroute in `worker-seckill` remains the larger limiter
