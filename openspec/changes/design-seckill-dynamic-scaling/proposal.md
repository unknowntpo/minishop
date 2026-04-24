## Why

The seckill path now uses `go-backend` as the single full-API ingress and publishes seckill commands into Kafka asynchronously. Benchmark results show that direct Kafka ingress can sustain much higher throughput than the full HTTP API path, while the Kafka Streams worker still needs a clear scale-out model for higher traffic.

The next architecture question is how to increase seckill processing capacity without breaking inventory correctness, state-store ownership, or benchmark repeatability.

## What Changes

- Define the relationship between seckill buckets, Kafka partitions, Kafka Streams tasks, and worker instances
- Define a first practical scale-out model based on pre-created partitions plus consumer scaling
- Define why dynamically increasing partitions is a controlled maintenance operation, not a transparent online autoscale primitive
- Define when bucket-count changes require a new routing epoch and migration protocol
- Define observability and benchmark gates required before implementing automatic scaling

## Capabilities

### New Capabilities

- `seckill-dynamic-scaling`: Operate seckill processing capacity through partitioned Kafka topics, Kafka Streams worker scaling, and explicit routing epochs

### Modified Capabilities

- `event-sourced-buy-flow`: Seckill command processing gains a documented scaling model distinct from the non-seckill checkout command path

## Impact

- Affected specs: `event-sourced-buy-flow`
- Affected code: future seckill topic provisioning, worker deployment, benchmark scripts, metrics, routing metadata, and operational runbooks
- Affected systems: `go-backend`, Kafka/Redpanda topics, Kafka Streams worker, result sink, Swarm benchmark stack, benchmark dashboard
