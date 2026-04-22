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

Operational note:

- seckill benchmark runs should always use the `benchmark-runner` container instead of the host Node runtime
- this avoids local Node ABI drift breaking native modules such as `@confluentinc/kafka-javascript`
- seckill benchmark runs should start `worker-seckill` with a fresh `KAFKA_SECKILL_APPLICATION_ID` and a fresh result-sink consumer group id
- this prevents Kafka Streams changelog restore and stale consumer offsets from contaminating a supposedly reset benchmark run

## Payload size estimate

The current seckill Kafka payloads are small enough that compression should be treated as a hypothesis to verify, not an assumed win.

Representative JSON payload sizes:

- request payload:
  - `~889 bytes` uncompressed
  - `~400 bytes` with `gzip`
  - compression ratio `~0.45`
- result payload:
  - `~1105 bytes` uncompressed
  - `~466 bytes` with `gzip`
  - compression ratio `~0.42`

Interpretation:

- the payloads are compressible
- but the absolute byte volume is still modest for this local benchmark topology
- this means compression may reduce broker/network bytes without improving end-to-end throughput

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

## Go producer baseline

The Go seckill ingress producer now uses `franz-go` as the baseline producer client.

This baseline decision should be separated into two questions:

- raw Kafka producer capability
- end-to-end seckill pipeline performance

For the raw Kafka producer question, a dedicated benchmark scenario `go-kafka-producer-raw` was added so the client libraries can be compared without HTTP, seckill routing, Kafka Streams retry/reroute, or result-sink persistence layered on top.

Recent raw benchmark sweep conditions:

- clients:
  - `sarama`
  - `franz-go`
  - `rust-rdkafka`
- message sizes:
  - `1024B`
  - `4096B`
- repeats:
  - `3`
- per run:
  - `messages=20000`
  - `concurrency=512`
  - `linger=5ms`
  - `compression=none`

Observed median results:

| client | messageBytes | throughput median (/s) | producer p95 median (ms) |
| --- | ---: | ---: | ---: |
| `franz-go` | `1024` | `47427.76` | `13.95` |
| `sarama` | `1024` | `45150.7` | `16.13` |
| `rust-rdkafka` | `1024` | `35656.67` | `13.29` |
| `franz-go` | `4096` | `32294.42` | `19.61` |
| `sarama` | `4096` | `26559.4` | `25.06` |
| `rust-rdkafka` | `4096` | `14299.23` | `41.95` |

Interpretation:

- `franz-go` is the current raw throughput winner at both tested payload sizes
- `sarama` is competitive, especially at smaller payloads, but still trails `franz-go` on median throughput
- `rust-rdkafka` completed cleanly and is useful as an additional cross-language reference point, but it is materially behind both Go clients in this local benchmark
- for producer baseline selection, throughput is the more important discriminator here, so `franz-go` remains the chosen producer baseline

## Earlier `franz-go` pipeline experiment

Before the raw producer benchmark existed, the Go seckill ingress producer had already been reimplemented with `franz-go` and compared with the original `segmentio/kafka-go` producer under the full seckill benchmark conditions:

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

- those earlier full-pipeline runs were dominated by downstream variance and were not clean enough to settle the producer-library question by themselves
- the newer `go-kafka-producer-raw` scenario is the better basis for choosing the producer baseline
- even after choosing `franz-go` as the producer baseline, the larger end-to-end bottleneck still appears lower in the stack:
  - `worker-seckill` retry / reroute
  - result-sink persistence

## Current ingress tuning comparison

The most useful apples-to-apples comparison uses the same downstream path:

- existing Kotlin `worker-seckill`
- Go `go-seckill-result-sink`
- same benchmark scenario:
  - `buy-intent-hot-seckill`
  - `steady_state`
  - `concurrency=200`
  - `bucket=4`
  - `maxProbe=4`

### Best observed Go ingress producer config

Using Go ingress with `franz-go`, a conservative linger / batch sweep produced the current best observed setting:

- `KAFKA_SECKILL_CLIENT_LINGER_MS = 50`
- `KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES = 5000`

Observed result:

- `queued/sec = 2805.4`
- `result topic throughput = 2796.28`
- `p95 = 193.36ms`

Interpretation:

- a longer producer linger clearly helps the Go ingress
- extremely large producer batch caps were not always beneficial
- the best observed shape so far is **longer linger + medium batch cap**

### Go ingress compression experiment

With the Go ingress producer fixed at:

- `KAFKA_SECKILL_CLIENT_LINGER_MS = 50`
- `KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES = 5000`

and with the Go result sink fixed at the current throughput-oriented fetch setting:

- `GO_SECKILL_RESULT_SINK_MAX_WAIT_MS = 100`

the benchmark was rerun through the `benchmark-runner` container for:

- `scenario=buy-intent-hot-seckill`
- `style=steady_state`
- `concurrency=200`
- `bucket=4`
- `maxProbe=4`
- `ingress=http`
- `path=seckill_only`

Codec sweep results:

| `KAFKA_SECKILL_CLIENT_COMPRESSION` | queued/sec | result topic throughput | p95 |
| --- | ---: | ---: | ---: |
| `none` | `1924.4` | `1928.27` | `168.59ms` |
| `snappy` | `2016.0` | `2013.28` | `154.5ms` |
| `lz4` | `1850.8` | `1850.22` | `180.65ms` |
| `zstd` | `1518.0` | `1517.21` | `225.63ms` |

Artifacts:

- `none`: `benchmark-results/buy-intent-hot-seckill/2026-04-22T01-53-25-246Z_bench_1776822789084.json`
- `snappy`: `benchmark-results/buy-intent-hot-seckill/2026-04-22T01-54-00-701Z_bench_1776822824616.json`
- `lz4`: `benchmark-results/buy-intent-hot-seckill/2026-04-22T01-54-34-495Z_bench_1776822858329.json`
- `zstd`: `benchmark-results/buy-intent-hot-seckill/2026-04-22T01-55-08-538Z_bench_1776822892363.json`

Interpretation:

- `snappy` was only slightly better than `none`
- the gap between `none` and `snappy` is small enough that it should be treated as benchmark noise until repeated
- `lz4` was worse than `none`
- `zstd` was materially worse on both throughput and p95

Conclusion:

- compression is **not** the next clear throughput lever for this workload
- keep the default Go ingress producer compression at `none`
- if compression is revisited later, `snappy` is the only codec from this sweep worth retesting

### Best observed Node ingress config under the same downstream path

Node ingress was compared in three shapes:

1. default
   - app batcher: `64 / 2ms`
   - Kafka producer: `1ms / 10000`
   - result:
     - `queued/sec = 831.6`
     - `result topic throughput = 796.67`
     - `p95 = 358.07ms`
2. producer-only tuning
   - app batcher: `64 / 2ms`
   - Kafka producer: `50ms / 5000`
   - result:
     - `queued/sec = 1009.2`
     - `result topic throughput = 978.5`
     - `p95 = 269.29ms`
3. app batcher + producer tuning
   - app batcher: `128 / 5ms`
   - Kafka producer: `50ms / 5000`
   - result:
     - `queued/sec = 899.6`
     - `result topic throughput = 883.52`
     - `p95 = 329.94ms`

Interpretation:

- Node ingress also benefits from tuning the Kafka producer linger / batch settings
- the best observed Node shape so far is:
  - keep the app-level batcher at its default `64 / 2ms`
  - tune the Kafka producer to `50ms / 5000`
- increasing the app-level batcher itself was not beneficial in this setup

### Best known comparison

Best observed Go ingress vs best observed Node ingress:

- Go ingress:
  - `queued/sec = 2805.4`
  - `result topic throughput = 2796.28`
  - `p95 = 193.36ms`
- Node ingress:
  - `queued/sec = 1009.2`
  - `result topic throughput = 978.5`
  - `p95 = 269.29ms`

Interpretation:

- under the same downstream path, the tuned Go ingress is currently about:
  - `2.78x` higher on queued throughput
  - `2.86x` higher on result throughput
  - materially better on p95 latency

## Go result sink tuning status

The Go result sink was originally hardcoded to:

- `MinBytes = 1`
- `MaxBytes = 10e6`
- `MaxWait = 250ms`
- `CommitInterval = 0`

This is a **consumer fetch configuration**, not a producer linger / batch configuration.

The service now accepts these envs so it can be benchmarked without code edits:

- `GO_SECKILL_RESULT_SINK_MIN_BYTES`
- `GO_SECKILL_RESULT_SINK_MAX_BYTES`
- `GO_SECKILL_RESULT_SINK_MAX_WAIT_MS`
- `GO_SECKILL_RESULT_SINK_COMMIT_INTERVAL_MS`

Important interpretation:

- comparing Node sink vs Go sink should focus on:
  - fetch wait
  - fetch byte thresholds
  - commit behavior
  - DB persist behavior
- it should **not** be framed as a producer linger / batch comparison, because both result sinks are Kafka consumers

## Go result sink `MaxWait` sweep

The next focused benchmark was run with the requested fixed ingress shape:

- ingress:
  - `KAFKA_SECKILL_CLIENT_LINGER_MS = 50`
  - `KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES = 5000`
- benchmark conditions:
  - `scenario=buy-intent-hot-seckill`
  - `style=steady_state`
  - `concurrency=200`
  - `bucket=4`
  - `maxProbe=4`
  - `ingress=http`
  - `path=seckill_only`
- sink sweep:
  - `GO_SECKILL_RESULT_SINK_MAX_WAIT_MS = 10 / 50 / 100 / 250`

Observed results:

| `GO_SECKILL_RESULT_SINK_MAX_WAIT_MS` | queued/sec | result topic throughput | p95 |
| --- | ---: | ---: | ---: |
| `10ms` | `779.07` | `779.13` | `321.97ms` |
| `50ms` | `789.73` | `789.83` | `349.76ms` |
| `100ms` | `761.87` | `761.95` | `341.22ms` |
| `250ms` | `775.13` | `775.20` | `314.64ms` |

Artifacts:

- `10ms`: `benchmark-results/remote-go-seckill-result-sink-maxwait/maxwait-10/buy-intent-hot-seckill/2026-04-22T01-58-06-314Z_go_sink_maxwait_10ms_20260422T015150Z.json`
- `50ms`: `benchmark-results/remote-go-seckill-result-sink-maxwait/maxwait-50/buy-intent-hot-seckill/2026-04-22T02-00-47-680Z_go_sink_maxwait_50ms_20260422T015927Z.json`
- `100ms`: `benchmark-results/remote-go-seckill-result-sink-maxwait/maxwait-100/buy-intent-hot-seckill/2026-04-22T02-02-31-496Z_go_sink_maxwait_100ms_20260422T020048Z.json`
- `250ms`: `benchmark-results/remote-go-seckill-result-sink-maxwait/maxwait-250/buy-intent-hot-seckill/2026-04-22T02-05-17-498Z_go_sink_maxwait_250ms_20260422T020232Z.json`

Interpretation:

- this isolated remote-compose rerun on `morefine` did **not** reproduce the earlier `2k+ /s` sweep numbers
- the four settings clustered tightly on throughput, within roughly `3.6%` from best to worst
- `50ms` was the best throughput setting in this rerun, but only by a small margin over `10ms` and `250ms`
- `250ms` produced the best p95 latency in this rerun
- `100ms` was the weakest throughput setting of the four in this rerun

Conclusion:

- for this rerun, there is no strong throughput winner; `10ms`, `50ms`, and `250ms` are effectively in the same band
- if forced to choose one setting from this rerun alone, `250ms` is the safest default because it stayed near the top throughput band while also giving the best p95
- because these results materially differ from the earlier local sweep, `GO_SECKILL_RESULT_SINK_MAX_WAIT_MS` should currently be treated as **sensitive to environment / run conditions**, not as a settled single-knob win

## Partition routing finding

The earlier low or unstable HTTP-path seckill throughput was materially affected by a partition-routing bug, not just by normal ingress-runtime cost.

What was wrong:

- the seckill design expected `bucket_id -> Kafka partition`
- but the Go producers were using `franz-go` without `ManualPartitioner()`
- this meant setting `record.Partition` did not actually force the intended partition
- at the same time, some services and benchmark paths were still defaulting to `16` buckets while the rebuilt request/result topics had been reduced to `4` partitions

Observed failure shape before the fix:

- Go HTTP benchmark sometimes returned large numbers of `HTTP 500`
- `go-backend` logs showed:
  - `invalid record partitioning choice of 14 from 4 available`
- request-topic traffic shape was visibly wrong or unstable, because the producer-side partition intent and actual broker-side partitioning were not aligned

Why this mattered for throughput:

- work was not consistently routed to the intended shard
- some requests failed at publish time
- some runs mixed `16-bucket` routing decisions with `4-partition` topics
- this depressed measured HTTP-path throughput and made the earlier results noisier than they should have been

Fix:

- add `kgo.RecordPartitioner(kgo.ManualPartitioner())` to the Go producers
- explicitly publish seckill requests to `partition = bucket_id`
- align the seckill bucket/topic defaults so benchmark, Go backend, Go ingress, worker, and sink all use the same `bucket=4` / `partitions=4` shape

Post-fix evidence:

- direct Kafka seckill topology benchmark (`10010` requests) now shows clean 4-way spread:
  - request topic:
    - `p0 = 2508`
    - `p1 = 2508`
    - `p2 = 2504`
    - `p3 = 2504`
  - result topic:
    - `p0 = 2521`
    - `p1 = 2521`
    - `p2 = 2518`
    - `p3 = 2518`
- the same direct Kafka topology run reached:
  - `queued/sec = 7496.95`
  - `result topic throughput = 7855.19`
  - `p95 = 70.34ms`
- after the fix, the Go HTTP benchmark no longer produced request-path 500s:
  - `accepted = 10010 / 10010`
  - `errors = 0`
  - `queued/sec = 1694.06`
  - `p95 = 287.25ms`

Interpretation:

- yes, the earlier lower HTTP throughput was materially caused by partition-routing misconfiguration
- the gap was not only "Go HTTP is slower than direct Kafka"
- part of the observed loss came from publishing to the wrong or invalid partition shape
- after the fix, the remaining gap between `direct_kafka` and `http` is a cleaner measurement of real HTTP/backend overhead rather than a routing bug

## Benchmark hygiene finding

The next misleading failure was not in Go HTTP ingress itself. It was in benchmark reset hygiene for the seckill Kafka path.

What went wrong:

- the benchmark began using fresh `KAFKA_SECKILL_APPLICATION_ID` values to avoid Kafka Streams changelog restore contamination
- but the benchmark reset still left `inventory.seckill.requested`, `inventory.seckill.result`, and `inventory.seckill.dlq` intact
- a fresh Kafka Streams app id on the same request topic replays the retained request history from the earliest offset

Observed failure shape:

- Go HTTP runs sometimes showed:
  - `accepted = 10010 / 10010`
  - `errors = 0`
  - `statusDistribution = failed: 10010`
- request-topic delta inflated to roughly `4x` the request count in bad runs
- consuming recent request-topic messages showed many terminal attempts such as:
  - `attempt = 3`
  - `bucket_id != primary_bucket_id`
- direct inspection of recent result payloads showed real worker outputs of:
  - `status = rejected`
  - `failureReason = seckill_out_of_stock`

Root cause:

- the worker was replaying old retained requests before the new benchmark run
- by the time the current HTTP burst arrived, the worker-side per-bucket state had already been driven toward exhaustion by replayed history
- this produced false benchmark failures that looked like Go HTTP or worker logic regressions, but were actually reset contamination

Fix:

- seckill benchmark orchestration must hard-reset the Kafka topics as well as the database state
- `run-seckill-benchmark-container.sh` now:
  - deletes and recreates:
    - `inventory.seckill.requested`
    - `inventory.seckill.result`
    - `inventory.seckill.dlq`
  - recreates `worker-seckill`
  - recreates the selected result sink
- this reset happens before the benchmark runner starts sending traffic

Interpretation:

- for the seckill path, "fresh app id" alone is not a safe reset
- if the topics are retained, a fresh consumer identity can make the benchmark less isolated, not more isolated
- correct benchmark hygiene here requires:
  - database reset
  - fresh Streams app id / fresh sink group id
  - fresh seckill topics

## Current clean Go HTTP benchmark

With:

- Go backend HTTP ingress
- `bucket=4`
- `maxProbe=4`
- `KAFKA_SECKILL_CLIENT_LINGER_MS = 50`
- `KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES = 5000`
- hard-reset seckill topics before the run
- fresh worker app id and fresh sink group id

the current clean HTTP-path seckill benchmark is:

- artifact:
  - `benchmark-results/buy-intent-hot-seckill/2026-04-22T15-36-28-422Z_go_http_clean_20260422T153612Z.json`
- result:
  - `accepted = 10010 / 10010`
  - `errors = 0`
  - `queued/sec = 1828.17`
  - `result topic throughput = 1833.66`
  - `p95 = 198.29ms`
  - `commandLifecycle.statusDistribution = created: 10010`
  - `request topic delta = 10016`
  - `result topic delta = 10328`

Interpretation:

- this is the first clean Go HTTP benchmark after both major benchmark-path defects were removed:
  - partition routing mismatch
  - replay contamination from retained seckill topics
- the remaining gap versus direct Kafka is now better interpreted as actual HTTP/backend overhead instead of benchmark corruption
- current reference comparison:
  - direct Kafka seckill topology:
    - `queued/sec = 7496.95`
    - `result topic throughput = 7855.19`
    - `p95 = 70.34ms`
  - clean Go HTTP path:
    - `queued/sec = 1828.17`
    - `result topic throughput = 1833.66`
    - `p95 = 198.29ms`

Blog note:

- a good short framing for a future blog post is:
  - "We thought the bottleneck was Go-vs-Node ingress runtime. The bigger bug was that our Kafka partition intent was not actually being enforced. Once `bucket -> partition` became explicit and the whole stack agreed on the same bucket count, the seckill topology spread evenly and the misleading HTTP-path failures disappeared."
