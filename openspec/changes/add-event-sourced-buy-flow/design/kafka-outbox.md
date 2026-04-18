# Deferred Kafka and Outbox Relay

Kafka is deferred until the PostgreSQL-only baseline is measured.

## Phase 1: PostgreSQL Only

```text
POST /api/checkout-intents
  -> append CheckoutIntentCreated to event_store
  -> projection processor reads event_store
  -> projections/checkpoints update in PostgreSQL
```

No Kafka topic, producer, consumer, or broker is required in this phase.

## Phase 2: Outbox Relay

When Kafka is introduced, it should be fed from PostgreSQL durability rather than replacing the initial event append.

```text
event_store
  -> outbox relay reads ordered rows after checkpoint
  -> publishes to Kafka topic
  -> records relay checkpoint
```

The relay must be idempotent. Re-publishing an already persisted event must not create a second durable domain event.

## Kafka Topic Direction

Initial topic shape:

```text
minishop.domain-events.v1
```

Message key:

```text
aggregate_type + ":" + aggregate_id
```

Message value:

```json
{
  "event_id": "...",
  "event_type": "...",
  "event_version": 1,
  "aggregate_type": "...",
  "aggregate_id": "...",
  "aggregate_version": 1,
  "payload": {},
  "metadata": {},
  "occurred_at": "..."
}
```

Kafka ordering can help worker throughput, but PostgreSQL `aggregate_version` remains the durable correctness guard.

## Non-Goals Before Baseline

```text
do not publish directly to Kafka from checkout API
do not use Kafka as source of truth
do not use Redis or Kafka to decide inventory availability
do not require Kafka for local demo or Day 1 benchmark
```
