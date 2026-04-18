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

## Script

Use an explicit slow script:

```text
pnpm benchmark:day1
```

The script should:

```text
send 1,000 checkout intent requests for sku_hot_001
use one unique idempotency key per simulated buyer
replay a duplicate idempotency key sample
call the internal projection processor after writes
record API p95 latency
record accepted/replayed/error counts
record event_store append throughput
record projection checkpoint lag
record checkout projection status distribution
record SKU inventory projection counters
```

The script is not part of `pnpm check`. It requires a running Next.js app and PostgreSQL database.

Until the async reservation worker is wired end-to-end, the status distribution may remain `queued`. The report must show that honestly instead of treating queued intents as terminal orders.
