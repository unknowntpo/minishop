## Why

Minishop is a high-concurrency commerce experiment focused on validating the full buy operation under burst traffic. The system needs an event-sourced buy flow so pressing the Buy button does not synchronously wait on inventory row locks or third-party payment calls.

## What Changes

- Introduce an event-sourced checkout flow where direct Buy and cart checkout create a `CheckoutIntentCreated` event.
- Use PostgreSQL as the durable event store and projection store.
- Use SKU as the inventory consistency boundary, while product remains a catalog/display concept.
- Reserve inventory through a Saga so multi-SKU checkout can be coordinated without one large synchronous transaction.
- Add projection read models for inventory, checkout intent status, and orders.
- Start without Kafka; add Kafka later through an outbox relay when it becomes part of the formal processing path.
- Use polling for client status and remaining inventory updates in the initial client architecture.
- Use Node.js 24 LTS as the production runtime baseline, Bun as package manager/scripts, PostgreSQL, Redis cache-only later, and Drizzle for schema/migrations.

## Capabilities

### New Capabilities

- `event-sourced-buy-flow`: Defines checkout intents, inventory reservations, payment compensation, projections, and client polling for the high-concurrency Minishop flow.

### Modified Capabilities

None.

## Impact

- Adds architectural requirements for event storage, projections, inventory reservation, payment failure compensation, and polling APIs.
- Establishes PostgreSQL event store first, with Kafka deferred to a later scale-up phase.
- Establishes Drizzle plus raw SQL/pg for database access patterns.
