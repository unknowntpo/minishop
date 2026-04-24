## 1. Ingress Consolidation Verification

- [x] 1.1 Verify benchmark seckill full API path targets `benchmark-go-backend:3000`
- [x] 1.2 Verify e2e seckill path targets `go-backend:3000`
- [x] 1.3 Verify no `go-seckill-ingress` service, Dockerfile, or source directory remains in this worktree
- [x] 1.4 Ensure benchmark worker replicas do not share one Kafka Streams state volume

## 2. Scaling Model

- [x] 2.1 Define bucket, partition, task, and worker responsibilities
- [x] 2.2 Define worker replica scaling as the first dynamic operation
- [x] 2.3 Define partition increase as a controlled drain-and-roll operation
- [x] 2.4 Define bucket-count changes as routing-epoch changes
- [x] 2.5 Define why Redis-like bucket migration is out of scope for the first version

## 3. Benchmark Follow-Up

- [x] 3.1 Add Justfile/helper command to scale `benchmark-worker-seckill`
- [x] 3.2 Add readiness helper for Kafka consumer group stability after worker scaling
- [ ] 3.3 Add benchmark matrix for partitions x worker replicas x ingress path
- [ ] 3.4 Record partition count, bucket count, worker replica count, and routing epoch in artifacts
- [ ] 3.5 Add dashboard panels for retry ratio, result per primary, lag by partition, and delivery ack latency

## 4. Future Implementation

- [ ] 4.1 Add routing epoch to seckill request schema
- [ ] 4.2 Add routing config source of truth
- [ ] 4.3 Add worker support for epoch-aware routing metadata
- [ ] 4.4 Add controlled topic repartition runbook
- [ ] 4.5 Decide whether bucket count and partition count remain coupled for production defaults
