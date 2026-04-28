---
name: minishop-orbstack-swarm-benchmark
description: Run fast local MiniShop Docker Swarm benchmark experiments with OrbStack, including stack deploy/reset, API/concurrency sweeps, Go HTTP load generator runs, and artifact review.
---

# MiniShop OrbStack Swarm Benchmark

Use this skill for quick local MiniShop benchmark experiments on OrbStack Docker Swarm.

## Guardrails

- OrbStack is for fast local iteration, not production truth.
- Always record commit id and Docker image/build state.
- Use Go HTTP load generator for full HTTP capacity numbers. Node fetch benchmark is useful only as a client-path comparison.
- Keep `maxProbe=1` when isolating HTTP/API/Kafka throughput; higher `maxProbe` intentionally amplifies Kafka messages.

## Setup

Use the OrbStack Docker context:

```bash
docker context use orbstack
docker info
```

Deploy and wait:

```bash
DOCKER_CONTEXT=orbstack ./scripts/swarm-benchmark.sh stack-deploy
DOCKER_CONTEXT=orbstack ./scripts/swarm-benchmark.sh stack-wait seckill
```

Initialize/reset checkout DB if `/api/products` returns 500:

```bash
DOCKER_CONTEXT=orbstack ./scripts/swarm-benchmark.sh run-checkout-reset
```

## Baseline Parameters

```text
BENCHMARK_REQUESTS=10000
BENCHMARK_HTTP_CLIENT=go-http
BENCHMARK_SECKILL_BUCKET_COUNT=12
BENCHMARK_SECKILL_MAX_PROBE=1
KAFKA_SECKILL_CLIENT_LINGER_MS=20
KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES=500
KAFKA_SECKILL_CLIENT_REQUIRED_ACKS=all
```

## Recommended Sweep

Start with proportional scaling:

| API replicas | concurrency |
|---:|---:|
| 1 | 200 |
| 2 | 400 |
| 4 | 800 |

Then find the knee around the best API count:

| API replicas | concurrency |
|---:|---:|
| 2 | 200 |
| 2 | 300 |
| 2 | 400 |
| 2 | 500 |
| 2 | 600 |

2026-04-28 local baseline:

| API replicas | concurrency | HTTP accepted RPS | p95 latency |
|---:|---:|---:|---:|
| 1 | 200 | `9,430/s` | `61.89ms` |
| 2 | 400 | `15,793/s` | `61.26ms` |
| 4 | 800 | `11,026/s` | `188.82ms` |
| 2 | 300 | `19,770/s` | `36.24ms` |

The local sweet spot was API=2 / concurrency=300, but this is OrbStack-specific.

## Run Command

```bash
DOCKER_CONTEXT=orbstack \
BENCHMARK_REQUESTS=10000 \
BENCHMARK_HTTP_CONCURRENCY=<CONCURRENCY> \
BENCHMARK_HTTP_CLIENT=go-http \
BENCHMARK_SECKILL_BUCKET_COUNT=12 \
BENCHMARK_SECKILL_MAX_PROBE=1 \
KAFKA_SECKILL_CLIENT_LINGER_MS=20 \
KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES=500 \
KAFKA_SECKILL_CLIENT_REQUIRED_ACKS=all \
./scripts/swarm-benchmark.sh run-seckill-full-api
```

Scale API:

```bash
DOCKER_CONTEXT=orbstack docker service scale minishop-benchmark_benchmark-go-backend=<API>
```

Pull artifact:

```bash
DOCKER_CONTEXT=orbstack ./scripts/swarm-benchmark.sh artifact-pull <RUN_ID>
```

## What To Check

- `requestPath.acceptRequestsPerSecond`
- `requestPath.kafkaDurableAccepted`
- `requestPath.concurrency.maxInFlight`
- `acceptLatencyMs.p95` and `acceptLatencyMs.p99`
- request/result topic offset deltas
- backend Prometheus delivery success/error counters

If API replicas do not improve throughput, compare:

```text
runner -> benchmark-go-backend:3000      # Swarm service VIP
runner -> single backend task IP:3000    # bypass service VIP
host   -> localhost:3300                 # published port/routing mesh
```

This separates backend capacity from OrbStack/Swarm networking behavior.

## Cleanup

```bash
DOCKER_CONTEXT=orbstack ./scripts/swarm-benchmark.sh stack-rm
```
