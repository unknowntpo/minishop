## Context

Minishop is not a full commerce platform in the first version. It is a controlled high-concurrency experiment for a small number of important products and SKUs. The main operation is a burst of users pressing Buy for the same SKU.

The system must avoid turning the Buy button into a synchronous inventory lock wait. Pressing Buy or checking out a cart creates a durable checkout event. Inventory reservation, payment, order confirmation, and failure compensation happen through later event processing.

Supporting design notes:

- [Architecture diagrams](design/architecture.md)
- [Event dictionary](design/events.md)
- [Command boundary](design/commands.md)
- [Storage schema](design/storage.md)
- [Schema conventions](design/schema-conventions.md)
- [State transitions](design/transitions.md)
- [Day 1 benchmark](design/benchmark.md)

## Goals / Non-Goals

**Goals:**

- Use event sourcing for the checkout, inventory, payment, and order lifecycle.
- Keep PostgreSQL as the durable source of truth.
- Keep Redis cache-only and out of durable inventory decisions.
- Start without Kafka, then add Kafka later to measure processing throughput improvements.
- Keep client reads on projections, not raw event replay.
- Keep the initial realtime UX on polling, not SSE or WebSocket.
- Define a repeatable Day 1 benchmark baseline for correctness and throughput measurement.

**Non-Goals:**

- Build a complete commerce platform.
- Add Kafka in the first implementation.
- Use Redis to decrement inventory.
- Use WebSocket or SSE in the first implementation.
- Integrate a real third-party payment provider in the first implementation.

## Decisions

### Use Node.js 24 LTS as the production runtime baseline

Node.js 24 LTS is the production runtime baseline. Bun is used for package management and scripts. Bun runtime can be tested later as a performance experiment, but it is not the baseline for correctness or load testing.

Alternative considered: Bun runtime as the primary production runtime. This was rejected for the first version to keep runtime compatibility from becoming a core uncertainty in the high-concurrency experiment.

### Use Drizzle for schema and migrations

Drizzle manages schema, migrations, and normal queries. Raw SQL through `pg` is allowed for hot paths such as event append, projection batches, and PostgreSQL advisory locks.

Alternative considered: Prisma. Prisma has stronger tooling for CRUD-heavy apps, but this project needs SQL control for event sourcing and high-throughput batch processing.

Alternative considered: Kysely. Kysely has strong SQL control, but its migration tooling is more minimal than Drizzle.

### Use PostgreSQL event store first

The first implementation writes events to PostgreSQL `event_store` before any downstream processing. PostgreSQL is the durable truth. Kafka is deferred until the PostgreSQL-only baseline is measured.

Alternative considered: Kafka-first ingress. This can increase ingress throughput, but it makes durability, replay, and exactly-once semantics harder for the first version.

### Model Checkout Intent separately from SKU inventory

`CheckoutIntentCreated` belongs to a `checkout` aggregate. It does not consume the SKU aggregate version. Inventory outcomes belong to the `sku` aggregate.

Direct Buy is represented as a checkout intent with one item. Cart checkout is represented as a checkout intent with multiple items. This keeps the ingress path from making all buyers of the same SKU compete for the same SKU stream version.

### Use SKU as the inventory aggregate

Product is a catalog/display aggregate. SKU is the purchasable unit and the inventory consistency boundary. Inventory reservation events use `aggregate_type = sku` and `aggregate_id = sku_id`.

This prevents one hot SKU from blocking unrelated SKUs under the same product.

### Use projections for reads

Client SSR, polling, and UI state read projection tables:

- `sku_inventory_projection`
- `checkout_intent_projection`
- `order_projection`

The event store remains the truth. Projections are read models and must be rebuildable.

### Start projection processing inside Next.js with DB coordination

The first version can expose an internal Next.js route or scheduled handler that processes event batches. The projection logic must live in shared modules so it can later move to an independent worker.

Multiple Next.js instances must coordinate with PostgreSQL transaction-level advisory locks, such as `pg_try_advisory_xact_lock`, and checkpoint rows.

### Use polling before SSE or WebSocket

The first client implementation uses polling for checkout intent status and remaining inventory. SSR provides initial product and inventory data. SSE or WebSocket can be added later for realtime UX, but lost realtime messages must never be required for correctness.

### Use reservation plus saga for payment

Inventory is reserved before payment is completed. Third-party payment calls are outside the database transaction. Payment failure or timeout is handled with compensation events that release the reservation and cancel the order.

### Use Aggregate Roots for local invariants

Each aggregate has a root object that validates commands before producing events. Saga coordinates across aggregate roots, but each aggregate root owns its local consistency rules.

## Risks / Trade-offs

- [Risk] PostgreSQL append throughput becomes the first bottleneck. -> Measure PostgreSQL-only baseline before adding Kafka.
- [Risk] Projection processing inside Next.js is not suitable for long-running production workers. -> Keep projection logic in shared modules and move it to an independent worker later.
- [Risk] Advisory lock misuse can leak session-level locks. -> Use transaction-level advisory locks and one DB client per transaction.
- [Risk] Polling creates extra read traffic. -> Read from projections and add Redis cache later if projection read load becomes noisy.
- [Risk] Payment provider callbacks can be duplicated or delayed. -> Use idempotency keys and compensation events.

## Migration Plan

1. Implement PostgreSQL event store, projection tables, and Drizzle migrations.
2. Implement `POST /api/checkout-intents` to append `CheckoutIntentCreated` and create the queued projection.
3. Implement projection processing through a Next.js internal route using PostgreSQL advisory lock coordination.
4. Implement polling APIs for checkout intent status and SKU inventory.
5. Add inventory reservation and payment compensation events.
6. Later, add Kafka through an outbox relay and measure throughput against the PostgreSQL-only baseline.

## Open Questions

- What exact load targets define success for the first benchmark: 1k, 5k, or 10k concurrent buy attempts?
- Which payment provider will be modeled first when real integration begins?
- Should waiting room behavior be FIFO, lottery, or rate-limited admission when added later?
