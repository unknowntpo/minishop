## Context

The seckill path has two different scaling concerns:

- accepting commands through `go-backend`
- processing commands through Kafka Streams workers

The full API path should use `go-backend` as the only HTTP entrypoint. The removed standalone ingress concept should not be reintroduced for scale-out. More HTTP capacity should come from scaling `go-backend` replicas and keeping the Kafka producer path asynchronous.

Kafka Streams capacity is governed by topic partition count, task assignment, state-store ownership, and consumer group rebalancing. This is similar to Redis Cluster only at a high level. The safer mapping is:

- Redis hash slot: stable routing domain for key ownership
- seckill bucket: business-level inventory shard for a hot SKU
- Kafka partition: processing parallelism and log ordering boundary
- Kafka Streams task: runtime owner of one or more input partitions
- worker instance: process that owns assigned tasks during a consumer group generation

## Goals / Non-Goals

**Goals**

- Keep `go-backend` as the only seckill full-API ingress
- Increase seckill processing capacity by scaling Kafka Streams worker instances where partitions already exist
- Keep stateful Kafka Streams workers single-owner per task
- Make bucket, partition, and routing epoch semantics explicit
- Preserve benchmark isolation when changing partition or bucket counts
- Define the metrics needed before autoscaling

**Non-Goals**

- Transparently migrate bucket ownership in the first implementation
- Treat Kafka partition increase as a zero-risk online autoscale action
- Repartition existing seckill traffic without a routing epoch
- Make the stateful worker highly available in the first Swarm benchmark topology
- Replace Kafka Streams task assignment with a custom Redis-like slot manager

## Decisions

### `go-backend` remains the only full-API ingress

The seckill full API path should be:

```text
client -> go-backend -> Kafka request topic -> Kafka Streams worker -> result topic -> result sink -> PostgreSQL/read model
```

The direct Kafka benchmark path remains a benchmark-only ingress path:

```text
benchmark-runner -> Kafka request topic -> Kafka Streams worker -> result topic
```

The benchmark stack may still expose both paths, but production-style HTTP ingress should not route through a separate `go-seckill-ingress` service.

### Partition count is the first scaling ceiling

Kafka Streams cannot run more active processing tasks for an input topic than there are input partitions. Adding more worker replicas only helps until every active partition has an owner.

For example:

```text
request topic partitions = 8
worker replicas          = 1 -> one process owns 8 tasks
worker replicas          = 4 -> each process owns about 2 tasks
worker replicas          = 8 -> each process owns about 1 task
worker replicas          = 12 -> 4 replicas are idle for this topic
```

Therefore the first scalable default should be to create enough partitions up front for the expected benchmark and near-term production ceiling.

### Bucket count and partition count are separate knobs

Bucket count controls hot-SKU inventory sharding and fallback probing. Partition count controls parallel processing.

They can be equal for simple reasoning, but they should not be treated as the same concept:

- Increasing partitions can increase processing parallelism.
- Increasing buckets can reduce per-bucket inventory contention and change retry/probe behavior.
- Increasing buckets changes routing semantics and may affect correctness unless old and new routing are separated by epoch.

### Dynamic partition increase is a controlled operation

Kafka allows increasing topic partitions, but doing it mid-run changes key-to-partition mapping for the default partitioner and triggers consumer-group rebalance.

For the current seckill design, changing partition count during a benchmark or hot sale is risky because:

- existing keys may map differently after partition increase unless partition assignment is explicit
- Kafka Streams tasks rebalance and restore state
- local state stores may move between workers
- benchmark comparability is broken if partition count changes during the measurement window

The first implementation should treat partition count changes as a drain-and-roll operation:

1. Stop accepting new benchmark traffic or switch to a new isolated run id.
2. Wait for request topic lag to drain.
3. Stop worker/result-sink group or move to fresh group ids.
4. Increase or recreate request/result/DLQ topics with the target partition count.
5. Restart workers with matching config.
6. Run readiness checks and only then start benchmark traffic.

### Online scaling should first mean worker replicas, not partition mutation

The safe first dynamic operation is:

```text
docker service scale benchmark-worker-seckill=N
```

or its production equivalent, as long as:

- topic partitions are already greater than or equal to the desired active task count
- worker state directory is not shared across replicas
- each replica has its own local state directory
- Kafka Streams handles task assignment and state restore
- readiness waits for consumer group stability before benchmark traffic starts

In Swarm benchmark mode, stateful workers should remain pinned to the worker role. For single-node benchmark correctness, one replica is acceptable. For multi-worker scale tests, the topology must provide separate worker nodes or safe per-replica local state paths.

The benchmark stack uses container-local Kafka Streams state for the seckill worker. It intentionally does not mount one shared named volume into all worker replicas, because two Kafka Streams processes must not write the same local state directory. State recovery should come from Kafka changelog topics during benchmark runs.

### Bucket-count changes require routing epochs

Changing `bucket_count` is not just a capacity operation. It changes the business key space for a hot SKU.

A safe design needs routing metadata:

```json
{
  "sku_id": "sku_hot_001",
  "routing_epoch": 3,
  "bucket_count": 128,
  "partition_count": 128,
  "max_probe": 4,
  "effective_from": "2026-04-24T00:00:00Z"
}
```

Each request should carry the routing epoch used by `go-backend`. The worker should process according to that epoch. This allows old and new epochs to coexist during a transition.

Without routing epochs, a bucket-count change can cause:

- old messages to be interpreted under new bucket rules
- duplicate or missing capacity accounting
- mixed fallback paths
- hard-to-debug benchmark artifacts

### Avoid bucket migration in the first version

Redis-like slot migration is powerful but expensive. It needs:

- source and destination ownership state
- handoff protocol
- in-flight message draining
- dedupe across old/new owners
- metrics and rollback

The first Minishop seckill scaling version should avoid this. Use enough buckets/partitions up front, then scale worker replicas. Add epoch-based bucket-count changes later only when benchmark data shows bucket contention remains the bottleneck.

### Rebalance mode matters, but does not remove the need for planning

Kafka's newer cooperative/async rebalance protocols reduce stop-the-world behavior, but they do not make state movement free.

Even with cooperative rebalance:

- some tasks pause
- state restore can consume IO and network
- partition ownership changes affect warm caches
- benchmark latency can spike during transition

The benchmark dashboard should mark any run that includes a rebalance window as a separate scenario, not compare it directly to steady-state runs.

## Proposed Rollout

### Phase 1: Fixed high partition ceiling

- Pick a benchmark partition ceiling, for example 32 or 64.
- Create request/result/DLQ topics with that partition count before the run.
- Keep bucket count equal to partition count for the first matrix.
- Scale worker replicas from 1 to N.
- Measure throughput, p95/p99, result topic lag, retry ratio, and task assignment.

### Phase 2: Worker replica scaling command

Add benchmark control commands that:

- scale `benchmark-worker-seckill`
- wait for service tasks to reach `Running`
- wait for Kafka consumer group stability
- wait for topic lag to stop growing
- then run the benchmark

This validates runtime scale-out without changing routing semantics.

### Phase 3: Bucket/partition matrix

Run controlled benchmark matrix:

```text
partitions: 4, 8, 16, 32, 64
worker replicas: 1, 2, 4, 8
ingress: full-api, direct-kafka
style: burst, steady-state
```

The decision target is to find:

- where direct Kafka stops scaling
- where full API stops scaling
- whether bottleneck is HTTP ingress, Kafka broker, worker task count, result sink, or DB

### Phase 4: Routing epoch design

Only after fixed partition scaling is understood, implement routing epochs for bucket-count transitions.

This should include:

- routing config source of truth
- config cache invalidation in `go-backend`
- message schema version and routing epoch
- worker support for old/new epochs
- benchmark artifacts that record epoch and bucket count

## Observability Requirements

Minimum metrics before autoscaling:

- request topic produce rate
- request topic lag by partition
- result topic produce rate
- result topic lag by partition
- worker assigned task count
- worker rebalance count and duration
- per-bucket primary request count
- per-bucket retry count
- retry per primary
- result per primary
- result sink DB write latency
- go-backend HTTP p95/p99 and Kafka delivery ack p95/p99

## ASCII Model

```text
                         full API path
                         ─────────────
client / benchmark
       |
       v
  go-backend replicas
       |
       | async produce
       v
+-------------------------- Kafka request topic --------------------------+
| p0 | p1 | p2 | p3 | ... | p31 |  partition = processing/task boundary |
+------------------------------------------------------------------------+
       |                Kafka Streams consumer group
       v
+----------------+   +----------------+   +----------------+
| worker replica |   | worker replica |   | worker replica |
| owns tasks     |   | owns tasks     |   | owns tasks     |
| local state    |   | local state    |   | local state    |
+----------------+   +----------------+   +----------------+
       |
       v
+-------------------------- Kafka result topic ---------------------------+
| result outcomes; consumed by result sink and benchmark collector        |
+------------------------------------------------------------------------+
       |
       v
result sink -> PostgreSQL/read model

direct Kafka benchmark path:
benchmark-runner ───────────────> Kafka request topic

scale first:
increase worker replicas up to partition count

controlled maintenance later:
increase partition/bucket count with drain + new routing epoch
```

## Open Questions

- What partition ceiling should be the default for local Swarm benchmark: 16, 32, or 64?
- Should benchmark stack support multi-replica stateful workers on one node, or require multiple worker nodes for realistic scaling?
- Should bucket count always equal partition count in benchmark scenarios, or should matrix runs test them independently?
- Should routing config live in PostgreSQL, Kafka compacted topic, or static env for the first epoch implementation?
