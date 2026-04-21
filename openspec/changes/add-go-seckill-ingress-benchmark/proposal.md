## Why

- `direct_kafka` throughput is much higher than the current `http` ingress path.
- The current HTTP path mixes ingress runtime cost with PostgreSQL seckill lookup, producer publish, and app-layer admission behavior.
- We need a minimal A/B experiment that replaces only the seckill HTTP ingress runtime so we can test whether a Go ingress materially improves request admission throughput.

## What changes

- Add a dedicated `go-seckill-ingress` service that implements only `POST /api/buy-intents` for the seckill path.
- Keep the existing Kafka Streams worker, result sink, PostgreSQL compatibility bridge, and frontend polling contract unchanged.
- Allow the benchmark runner to send ingress traffic to the Go service while still using the existing Next.js app for status/profiling endpoints.
- Keep the benchmark scenario name as `buy-intent-hot-seckill` and distinguish runs with tags:
  - `impl=nextjs`
  - `impl=go`
  - `path=seckill_only`

## Out of scope

- Rewriting the normal checkout path
- Rewriting Kafka Streams workers
- Replacing the result sink / compatibility bridge
- Moving production traffic to Go
