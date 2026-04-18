## 1. Project Foundation

- [x] 1.1 Implement Use Node.js 24 LTS as the production runtime baseline in project config and documentation
- [x] 1.2 Implement Use Drizzle for schema and migrations with PostgreSQL connection setup
- [x] 1.3 Implement Use lightweight Clean Architecture boundaries with app, components, domain, application, ports, infrastructure, and presentation modules
- [x] 1.4 Implement Add dependency graph checks before domain logic grows using dependency-cruiser circular dependency and architecture boundary rules
- [x] 1.5 Implement Use TypeScript-style API contracts and repository adapters instead of Java-style DTO/DAO naming
- [x] 1.6 Add base Drizzle migrations for event_store schema, projection schema, and checkpoint tables
- [x] 1.7 Add Catalog Tables migrations for singular product and sku seed tables with explicit non-production seed script
- [x] 1.8 Add Schema Conventions validation for IDs, money minor units, checkout item JSON, event metadata, reservation identity, and FK policy
- [x] 1.9 Implement Use Docker Compose for local PostgreSQL with db:up, db:down, and db:logs scripts

## 2. Event Store and Checkout Intent

- [x] 2.1 Implement Event Store Durability with append-only PostgreSQL event storage
- [x] 2.2 Implement Checkout Intent Creation API with idempotency handling
- [x] 2.3 Implement Model Checkout Intent separately from SKU inventory as checkout aggregate metadata and aggregate fields
- [x] 2.4 Implement Use PostgreSQL event store first by keeping Kafka out of the initial write path
- [x] 2.5 Implement Event Dictionary types and validation for checkout, inventory, payment, and order events
- [x] 2.6 Implement constrained event_type values in TypeScript and PostgreSQL check constraints
- [x] 2.7 Implement Command Boundary types for checkout, inventory, payment, and order command handlers

## 3. Inventory and Payment Events

- [x] 3.1 Implement SKU Inventory Aggregate event handling for SKU-level reservation streams
- [x] 3.2 Implement Inventory Reservation Outcome processing for reserved and rejected results
- [x] 3.3 Implement Use reservation plus saga for payment with payment requested, failed, and released events
- [x] 3.4 Implement Payment Failure Compensation with idempotent release behavior
- [x] 3.5 Implement Use SKU as the inventory aggregate in event stream and partition key conventions
- [x] 3.6 Implement Multi-SKU Checkout Saga for all-or-nothing cart reservation
- [x] 3.7 Implement Aggregate Root Invariants and Use Aggregate Roots for local invariants in SKU, checkout, order, and payment state transitions

## 4. Projections and Processing

- [x] 4.1 Implement Use projections for reads with SKU inventory, checkout intent, and order projection tables
- [x] 4.2 Implement Projection Read Models update handlers for each supported event type
- [x] 4.3 Implement Start projection processing inside Next.js with DB coordination using transaction-level advisory locks
- [x] 4.4 Implement Projection Processing Coordination with checkpoint updates and skipped concurrent runs
- [x] 4.5 Implement projection aggregate_version and last_event_id tracking separately from projection_checkpoint worker progress
- [x] 4.6 Implement constrained checkout intent, order, and payment status values in projection schema and application validation
- [x] 4.7 Implement checkout intent, order, payment, and inventory counter state transition validation

## 5. Client Read APIs

- [x] 5.1 Implement Client Polling UX endpoints for checkout intent status and SKU inventory
- [x] 5.2 Implement product page SSR using projection-backed initial product and inventory data
- [x] 5.3 Implement Use polling before SSE or WebSocket in client state flow
- [x] 5.4 Implement product page UI using the frontend UI/UX pattern for direct Buy, status polling, and projection-backed inventory display
- [x] 5.5 Implement non-production benchmark operator strip for SKU counters, projection event ids, and projection lag hints
- [x] 5.6 Implement Use Server Components only for read-only SSR and keep checkout writes in API route handlers
- [x] 5.7 Implement product catalog browsing preview for Limited Runner, Everyday Tee, and Travel Cap SKU pages
- [x] 5.8 Implement Use request and trace IDs without exposing internals in API error responses and frontend error display
- [x] 5.9 Implement Use internal admin projection verification page for products, SKUs, inventory projections, checkout projections, and checkpoints

## 6. Deferred Kafka Path

- [x] 6.1 Document Deferred Kafka Integration as a later phase
- [x] 6.2 Add placeholder design notes for PostgreSQL outbox relay without enabling Kafka

## 7. Verification

- [x] 7.1 Add tests for Checkout Intent Creation idempotency
- [x] 7.2 Add tests for SKU Inventory Aggregate reservation and rejection ordering
- [x] 7.3 Add tests for Projection Processing Coordination under concurrent processor attempts
- [x] 7.4 Add tests for Payment Failure Compensation duplicate callback handling
- [x] 7.5 Add Checkout Benchmark Baseline and Checkout PostgreSQL Baseline Benchmark report output for one hot SKU with 1,000 concurrent buy attempts
- [x] 7.6 Add Defer Playwright end-to-end tests to an explicit slow path with product page Buy, checkout polling, projection processing, and internal admin verification
- [x] 7.7 Add Benchmark Result Dashboard for local checkout-postgres-baseline artifacts and bottleneck trends
- [x] 7.8 Add dev-only isolated benchmark reset path for local PostgreSQL before clean checkout-postgres-baseline runs
