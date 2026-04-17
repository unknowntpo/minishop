# Day 1 Benchmark Standard

The first benchmark measures PostgreSQL-only behavior. Kafka, Redis cache, SSE, WebSocket, and real payment providers are excluded.

```text
Target scenario:
  1 hot product
  1 hot SKU
  1,000 concurrent Buy clicks
  quantity = 1 per intent
  fixed initial stock, such as 100 units

Success criteria:
  no oversell
  every accepted intent reaches terminal or payment state
  duplicate idempotency keys do not create duplicate intents
  API p95 latency for CheckoutIntentCreated is recorded
  event_store append throughput is recorded
  projection lag is recorded
```

The benchmark is allowed to pass without hitting a specific throughput number on Day 1. The required outcome is a repeatable baseline with correctness checks and measured latency/throughput numbers.
