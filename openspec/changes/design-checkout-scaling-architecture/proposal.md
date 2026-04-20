## Why

The current checkout path proves that PostgreSQL can sustain the baseline benchmark, but the architecture still couples client request latency directly to durable event insertion. We now want to design the next-stage checkout ingestion model for higher burst tolerance without losing the event store as the source of truth.

The key design question is no longer whether the system is event-driven. It is where the business fact boundary should remain, how commands should be buffered, and how clients should observe asynchronous completion.

## What Changes

- Define a queue-first checkout command ingestion architecture for high-burst traffic
- Keep PostgreSQL `event_store` as the durable business fact boundary
- Introduce `CommandAccepted` semantics and client polling contracts distinct from `CheckoutIntentCreated`
- Define the roles of Temporal, NATS JetStream command messaging, staging tables, merge workers, and outbox/event relay
- Define the worker model and control-plane boundaries for command ingest, merge, projection, and notification processing

## Capabilities

### New Capabilities

- `checkout-command-ingestion`: Accept checkout commands asynchronously with a durable command lifecycle and delayed business-fact establishment

### Modified Capabilities

- `event-sourced-buy-flow`: Checkout intent creation semantics expand from direct request-path append to a designed async command path while preserving PostgreSQL as source of truth

## Impact

- Affected specs: `event-sourced-buy-flow`
- Affected code: future ingress API contract, worker runtime, command status storage, NATS messaging integration, staging/merge path, polling API, observability/dashboard surfaces
- Affected systems: API layer, Temporal control plane, NATS JetStream command bus, PostgreSQL event store, optional downstream event streaming, read-model status endpoints
