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

## Published Data Contract

When Kafka is introduced, the published message is a long-lived contract
between Minishop producers and downstream consumers. The contract is broader
than JSON field shape.

Each published event contract must define:

```text
topic:
  Kafka topic name

meaning:
  business fact represented by the event

key:
  partition key and ordering scope

value schema:
  envelope shape and event payload shape

compatibility:
  backward, forward, full, or none

owner:
  service/team responsible for approving changes

retention:
  replay window expected by consumers

known consumers:
  projections, analytics, notifications, cache updaters, or external systems

change process:
  compatibility check, consumer notice, migration/deprecation plan

operations:
  DLQ behavior, monitoring, ACL, and sensitivity notes
```

The initial Kafka envelope should remain stable and include both transport and
domain version fields.

```json
{
  "envelope_version": 1,
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

`envelope_version` describes the Kafka transport wrapper. `event_version`
describes the domain payload for the specific `event_type`.

The message key is part of the contract. Changing it is breaking because it
changes partition ordering and any future compaction semantics.

```text
key = aggregate_type + ":" + aggregate_id
```

This preserves ordering for one aggregate stream, for example one SKU or one
checkout intent. Kafka does not provide global ordering across different
aggregates. Cross-aggregate correctness still belongs to the saga, event store,
projection logic, and PostgreSQL `aggregate_version` checks.

## Published Compatibility Policy

Before Kafka has independent consumers:

```text
backward compatibility is required
forward tolerance is preferred for additive fields
schema registry is deferred
```

When independent or external consumers exist:

```text
full compatibility should be considered for shared event contracts
schema compatibility checks should run in CI
owner approval and consumer notification are required for contract changes
```

Allowed compatible changes:

```text
add optional payload field
add payload field with explicit default
add metadata field
add new event type when consumers can ignore unknown event types
add enum/status value only when consumers have an unknown fallback
```

Breaking changes:

```text
rename, remove, or change the type of existing fields
change business meaning while keeping the same event_type
change units such as minor-unit money
change the Kafka message key
change retention below consumer replay needs
remove enum/status values without fallback and migration
```

Breaking changes require a migration plan instead of in-place replacement.

```text
1. define a v2 schema, new event type, or new topic
2. optionally dual-write old and new contracts
3. update consumers to support both versions
4. monitor consumer lag and usage
5. announce a deprecation window
6. stop old writes after consumers migrate
7. keep old data readable until retention or compliance requirements expire
```

Schema Registry can guard schema versioning and compatibility, but it does not
define event meaning, field semantics, ownership, DLQ behavior, idempotency, or
consumer correctness. Those remain design and operational responsibilities.

## Non-Goals Before Baseline

```text
do not publish directly to Kafka from checkout API
do not use Kafka as source of truth
do not use Redis or Kafka to decide inventory availability
do not require Kafka for local demo or checkout-postgres-baseline benchmark
```
