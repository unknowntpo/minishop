## 1. Project Foundation

- [ ] 1.1 Implement Use Node.js 24 LTS as the production runtime baseline in project config and documentation
- [ ] 1.2 Implement Use Drizzle for schema and migrations with PostgreSQL connection setup
- [ ] 1.3 Add base Drizzle migrations for event_store schema, projection schema, and checkpoint tables

## 2. Event Store and Checkout Intent

- [ ] 2.1 Implement Event Store Durability with append-only PostgreSQL event storage
- [ ] 2.2 Implement Checkout Intent Creation API with idempotency handling
- [ ] 2.3 Implement Model Checkout Intent separately from SKU inventory as checkout aggregate metadata and aggregate fields
- [ ] 2.4 Implement Use PostgreSQL event store first by keeping Kafka out of the initial write path
- [ ] 2.5 Implement Event Dictionary types and validation for checkout, inventory, payment, and order events

## 3. Inventory and Payment Events

- [ ] 3.1 Implement SKU Inventory Aggregate event handling for SKU-level reservation streams
- [ ] 3.2 Implement Inventory Reservation Outcome processing for reserved and rejected results
- [ ] 3.3 Implement Use reservation plus saga for payment with payment requested, failed, and released events
- [ ] 3.4 Implement Payment Failure Compensation with idempotent release behavior
- [ ] 3.5 Implement Use SKU as the inventory aggregate in event stream and partition key conventions
- [ ] 3.6 Implement Multi-SKU Checkout Saga for all-or-nothing cart reservation
- [ ] 3.7 Implement Aggregate Root Invariants and Use Aggregate Roots for local invariants in SKU, checkout, order, and payment state transitions

## 4. Projections and Processing

- [ ] 4.1 Implement Use projections for reads with SKU inventory, checkout intent, and order projection tables
- [ ] 4.2 Implement Projection Read Models update handlers for each supported event type
- [ ] 4.3 Implement Start projection processing inside Next.js with DB coordination using transaction-level advisory locks
- [ ] 4.4 Implement Projection Processing Coordination with checkpoint updates and skipped concurrent runs
- [ ] 4.5 Implement projection aggregate_version and last_event_id tracking separately from projection_checkpoint worker progress

## 5. Client Read APIs

- [ ] 5.1 Implement Client Polling UX endpoints for checkout intent status and SKU inventory
- [ ] 5.2 Implement product page SSR using projection-backed initial product and inventory data
- [ ] 5.3 Implement Use polling before SSE or WebSocket in client state flow

## 6. Deferred Kafka Path

- [ ] 6.1 Document Deferred Kafka Integration as a later phase
- [ ] 6.2 Add placeholder design notes for PostgreSQL outbox relay without enabling Kafka

## 7. Verification

- [ ] 7.1 Add tests for Checkout Intent Creation idempotency
- [ ] 7.2 Add tests for SKU Inventory Aggregate reservation and rejection ordering
- [ ] 7.3 Add tests for Projection Processing Coordination under concurrent processor attempts
- [ ] 7.4 Add tests for Payment Failure Compensation duplicate callback handling
- [ ] 7.5 Add Day 1 Benchmark Baseline script and report output for one hot SKU with 1,000 concurrent buy attempts
