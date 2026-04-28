---
name: minishop-homelab-swarm-benchmark
description: Run MiniShop Docker Swarm benchmarks on the HomeLab morefine libvirt/KVM environment, including VM lifecycle, stack deployment, seckill benchmark sweeps, artifact collection, and safe shutdown.
---

# MiniShop HomeLab Swarm Benchmark

Use this skill when the user wants to run MiniShop benchmark experiments on the HomeLab Swarm cluster.

## Guardrails

- Use the existing HomeLab workflow and the `homelab-swarm-benchmark` skill if it is available.
- Do not assume global SSH aliases. Use repo-local Justfile/scripts and inspect first.
- Prefer stopping/shutting down VMs over destroying them unless the user asks for destroy.
- Keep benchmark results tied to commit id, image tag, API replica count, concurrency, partitions, `maxProbe`, linger, batch size, and acks.

## Expected HomeLab Shape

Default benchmark VMs are usually:

- `bench-swarm-01a`: manager
- `bench-swarm-02`: worker
- `bench-swarm-03`: worker

Start by reading the local HomeLab commands:

```bash
just --list
rg -n "bench-swarm|swarm|morefine|artifact|stack" justfile scripts
```

Inspect before mutating:

```bash
ssh morefine 'virsh list --all'
ssh morefine 'kubectl get nodes 2>/dev/null || true'
```

## Deploy Stack

Prefer the repo's existing wrapper:

```bash
DOCKER_CONTEXT=morefine ./scripts/swarm-benchmark.sh stack-deploy
DOCKER_CONTEXT=morefine ./scripts/swarm-benchmark.sh stack-wait seckill
DOCKER_CONTEXT=morefine ./scripts/swarm-benchmark.sh stack-services
```

If using `just`, inspect `just --list` and use the repo-defined target instead of inventing a new one.

## Recommended Seckill Parameters

Use these as the comparable baseline unless the experiment is explicitly changing one:

```text
BENCHMARK_REQUESTS=10000
BENCHMARK_HTTP_CLIENT=go-http
BENCHMARK_SECKILL_BUCKET_COUNT=12
BENCHMARK_SECKILL_MAX_PROBE=1
KAFKA_SECKILL_CLIENT_LINGER_MS=20
KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES=500
KAFKA_SECKILL_CLIENT_REQUIRED_ACKS=all
```

First matrix:

| API replicas | concurrency |
|---:|---:|
| 1 | 200 |
| 2 | 300 |
| 2 | 400 |
| 4 | 600 |
| 4 | 800 |

Use the Go HTTP load generator. Do not use the old Node fetch path for capacity conclusions.

## Run Pattern

For each point:

1. Record `git rev-parse HEAD`.
2. Scale `benchmark-go-backend` to the API replica count.
3. Reset seckill topics and use unique Kafka Streams / result sink group ids.
4. Run full HTTP seckill benchmark with the selected concurrency.
5. Pull artifacts immediately.

Typical commands:

```bash
DOCKER_CONTEXT=morefine docker service scale minishop-benchmark_benchmark-go-backend=<API>

DOCKER_CONTEXT=morefine \
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

If the manager is drained and `runner-id` cannot find the runner, locate the runner task with:

```bash
DOCKER_CONTEXT=morefine docker service ps minishop-benchmark_benchmark-runner
```

Then execute benchmark commands on the worker that hosts the runner container.

## What To Watch

- `requestPath.acceptRequestsPerSecond`: HTTP accepted throughput.
- `requestPath.kafkaDurableAccepted`: backend Kafka callback success count.
- `requestPath.concurrency.maxInFlight`: confirms configured concurrency was actually reached.
- `acceptLatencyMs.p95/p99`: tells whether the point is over the knee.
- Redpanda request/result topic offset deltas: sanity check for durable work.
- `retryScheduledPerPrimary`: should stay near 0 when `maxProbe=1`.

## Shutdown

When done, stop the benchmark stack and shut down VMs if the user no longer needs them live:

```bash
DOCKER_CONTEXT=morefine ./scripts/swarm-benchmark.sh stack-rm
ssh morefine 'virsh shutdown bench-swarm-01a; virsh shutdown bench-swarm-02; virsh shutdown bench-swarm-03'
```
