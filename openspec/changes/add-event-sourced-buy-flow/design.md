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
- [Frontend UI/UX pattern](design/frontend-uiux.md)
- [Code architecture](design/code-architecture.md)
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

Node.js 24 LTS is the production runtime baseline. pnpm is used for package management and scripts. pnpm keeps dependencies in a shared content-addressable store while preserving `node_modules` compatibility for Next.js and Node.js tooling. Bun runtime can be tested later as a performance experiment, but it is not the baseline for correctness or load testing.

Alternative considered: Bun runtime as the primary production runtime. This was rejected for the first version to keep runtime compatibility from becoming a core uncertainty in the high-concurrency experiment.

Alternative considered: Bun as package manager and script runner. This was replaced with pnpm to reduce ambiguity between package management and runtime choice.

### Use Drizzle for schema and migrations

Drizzle manages schema, migrations, and normal queries. Raw SQL through `pg` is allowed for hot paths such as event append, projection batches, and PostgreSQL advisory locks.

Alternative considered: Prisma. Prisma has stronger tooling for CRUD-heavy apps, but this project needs SQL control for event sourcing and high-throughput batch processing.

Alternative considered: Kysely. Kysely has strong SQL control, but its migration tooling is more minimal than Drizzle.

### Use Docker Compose for local PostgreSQL

Local development should have a reproducible PostgreSQL setup through `docker-compose.yml`. The compose file runs PostgreSQL only; Next.js, pnpm, Drizzle, and tests still run directly on Node.js 24.

The default local connection string remains:

```text
postgres://postgres:postgres@localhost:5432/minishop
```

This keeps local setup predictable without turning Docker into the production deployment model. Developers may still use a native local PostgreSQL instance if it exposes the same `DATABASE_URL`.

### Use PostgreSQL event store first

The first implementation writes events to PostgreSQL `event_store` before any downstream processing. PostgreSQL is the durable truth. Kafka is deferred until the PostgreSQL-only baseline is measured.

Alternative considered: Kafka-first ingress. This can increase ingress throughput, but it makes durability, replay, and exactly-once semantics harder for the first version.

### Model Checkout Intent separately from SKU inventory

`CheckoutIntentCreated` belongs to a `checkout` aggregate. It does not consume the SKU aggregate version. Inventory outcomes belong to the `sku` aggregate.

Direct Buy is represented as a checkout intent with one item. Cart checkout is represented as a checkout intent with multiple items. Cart items may include SKUs from one or more products. Checkout items store `sku_id`; product display data is resolved through catalog tables. This keeps the ingress path from making all buyers of the same SKU compete for the same SKU stream version.

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

### Use Server Components only for read-only SSR

Next.js Server Components may render read-only product, SKU, and projection-backed initial inventory data. They must not be the write path for checkout commands in the MVP.

State-changing commands use API route handlers:

- `POST /api/checkout-intents`
- future payment callback endpoints
- internal projection processing endpoint

Polling reads also use API route handlers:

- `GET /api/checkout-intents/:id`
- `GET /api/skus/:skuId/inventory`

Server Actions are deferred for checkout writes. This keeps request validation, idempotency, auth checks, event append behavior, rate limiting, and benchmark instrumentation in explicit HTTP boundaries.

### Use request and trace IDs without exposing internals

API route handlers must not return raw server errors to the frontend. Environment variable names, database errors, SQL messages, stack traces, event internals, and infrastructure configuration stay in server logs.

Each API request should carry a request context with `request_id` and `trace_id`. Response headers may return `x-request-id` and `x-trace-id`; user-facing error bodies may return a `requestId` reference. This gives enough information to trace a failure without exposing implementation details to the buyer UI.

Checkout events should include request and trace identifiers in event metadata when available. These identifiers are observability context, not business state.

### Use lightweight Clean Architecture boundaries

Next.js is the delivery layer. Pages and API route handlers may call application use cases and wire infrastructure dependencies, but domain and application modules must not depend on Next.js, React, request objects, response objects, or route handlers.

The codebase uses a lightweight layer shape:

- `src/domain` for aggregate behavior, events, commands, value objects, and invariants.
- `src/application` for use cases such as checkout intent creation and projection processing.
- `src/ports` for interfaces such as event store, catalog repository, projection repository, clock, and ID generator.
- `src/infrastructure` for PostgreSQL, Drizzle, raw SQL event store, projection repository, and catalog repository implementations.
- `components` for UI components that consume props or presentation view models.
- `app` for Next.js routing, SSR entrypoints, and API route handlers.

This keeps the useful parts of Clean Architecture without forcing heavy boilerplate for a small high-concurrency experiment.

Alternative considered: place all logic under `app`. This was rejected because it would couple event sourcing and projection logic to Next.js routing and make a later worker extraction harder.

Alternative considered: full enterprise Clean Architecture naming with entities/use-cases/interface-adapters/frameworks. This was rejected as too heavy for the MVP.

### Use TypeScript-style API contracts and repository adapters

The project does not use Java-style DTO/DAO naming by default.

API request and response shapes are API contracts under presentation modules. UI-specific shapes are view models. Database access is expressed through repository ports and infrastructure adapters.

This keeps the code idiomatic for TypeScript while preserving the same boundary clarity that DTO/DAO naming provides in Java systems.

Development catalog seed data is not production data. Seed scripts must be explicit local development or benchmark fixture scripts.

### Use internal admin projection verification

The first implementation may include an internal admin page for local development and benchmark observation. This page can show catalog rows, SKU inventory projection counters, latest checkout projections, and projection checkpoint state.

The internal admin surface must stay separate from customer purchase UI. It is a verification tool for projection correctness and operational debugging, not a required step in checkout correctness.

### Add dependency graph checks before domain logic grows

The project should add an automated circular dependency and architecture boundary check before implementing most domain/application modules.

Decision: use `dependency-cruiser` for the first dependency guard because it can detect circular dependencies and validate layer rules. It complements Biome instead of replacing it.

Alternatives considered:

- `dpdm`: lightweight and TypeScript-friendly for circular dependency detection, but less focused on architecture boundary validation.
- `madge`: useful for dependency visualization, but not the preferred primary boundary guard.
- ESLint `import/no-cycle`: useful in ESLint stacks, but adding ESLint only for this rule would duplicate Biome responsibilities.

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
