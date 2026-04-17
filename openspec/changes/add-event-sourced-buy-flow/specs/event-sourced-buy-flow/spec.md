## ADDED Requirements

### Requirement: Checkout Intent Creation

The system SHALL create a durable checkout intent when a user presses the Buy button or checks out a cart. The checkout intent event SHALL use `aggregate_type = checkout` and `aggregate_id = checkout_intent_id`. Creating a checkout intent SHALL NOT synchronously reserve or decrement SKU inventory.

#### Scenario: User presses Buy

- **WHEN** a user presses Buy for a SKU
- **THEN** the system SHALL append `CheckoutIntentCreated` with one item to the event store and return an accepted queued response with `checkout_intent_id`

#### Scenario: User checks out cart

- **WHEN** a user checks out a cart containing multiple SKUs
- **THEN** the system SHALL append `CheckoutIntentCreated` with an item list to the event store and return an accepted queued response with `checkout_intent_id`

#### Scenario: Repeated client submission

- **WHEN** the same client operation is retried with the same idempotency key
- **THEN** the system SHALL return the existing checkout intent result without appending a duplicate `CheckoutIntentCreated` event

### Requirement: SKU Inventory Aggregate

The system SHALL use SKU as the inventory consistency boundary. Inventory reservation events SHALL use `aggregate_type = sku` and `aggregate_id = sku_id`. Product SHALL remain a catalog and display concept and SHALL NOT be the inventory reservation aggregate.

#### Scenario: Two SKUs under one product receive checkout intents

- **WHEN** users checkout two different SKUs under the same product
- **THEN** the system SHALL process each SKU inventory stream independently

### Requirement: Event Store Durability

The system SHALL store domain events in PostgreSQL as the durable source of truth. The event store SHALL be append-only for domain facts. Kafka SHALL NOT be required for the initial implementation.

#### Scenario: Event is accepted

- **WHEN** the API accepts a checkout intent
- **THEN** the corresponding event SHALL be durable in PostgreSQL before the API reports acceptance

#### Scenario: Event store schema is created

- **WHEN** database migrations run
- **THEN** the system SHALL create `event_store` with `id`, `event_id`, `event_type`, `event_version`, `aggregate_type`, `aggregate_id`, `aggregate_version`, `payload`, `metadata`, `idempotency_key`, and `occurred_at`

#### Scenario: Event store uniqueness is enforced

- **WHEN** events are appended
- **THEN** the system SHALL enforce unique `event_id`, unique `(aggregate_type, aggregate_id, aggregate_version)`, and unique non-null `idempotency_key`

### Requirement: Event Dictionary

The system SHALL define the supported event types before implementation. Each event type SHALL have a clear aggregate, meaning, and minimum payload so commands, facts, and projection states are not confused.

#### Scenario: Checkout intent event is implemented

- **WHEN** `CheckoutIntentCreated` is appended
- **THEN** the event SHALL represent a submitted direct Buy or cart checkout request and include `checkout_intent_id`, `buyer_id`, `items`, and `idempotency_key`

#### Scenario: Inventory reservation events are implemented

- **WHEN** inventory processing appends reservation events
- **THEN** `InventoryReservationRequested`, `InventoryReserved`, `InventoryReservationRejected`, and `InventoryReservationReleased` SHALL use the SKU aggregate and include `checkout_intent_id`, `reservation_id`, `sku_id`, and `quantity`

#### Scenario: Payment events are implemented

- **WHEN** payment processing appends payment events
- **THEN** `PaymentRequested`, `PaymentSucceeded`, and `PaymentFailed` SHALL use the payment aggregate and include `payment_id` and `checkout_intent_id`

#### Scenario: Order events are implemented

- **WHEN** order processing appends order events
- **THEN** `OrderConfirmed` and `OrderCancelled` SHALL use the order aggregate and include `order_id` and `checkout_intent_id`

### Requirement: Projection Read Models

The system SHALL expose client and SSR reads through projection tables rather than replaying raw events per request. The system SHALL maintain projections for SKU inventory, checkout intent status, and order state.

#### Scenario: Projection schema is created

- **WHEN** database migrations run
- **THEN** the system SHALL create `checkout_intent_projection`, `sku_inventory_projection`, `order_projection`, and `projection_checkpoint`

#### Scenario: Checkout intent projection stores status

- **WHEN** a checkout intent projection row is written
- **THEN** the row SHALL include `checkout_intent_id`, `aggregate_version`, `last_event_id`, `buyer_id`, `status`, `items`, optional `payment_id`, optional `order_id`, optional rejection or cancellation reason, `created_at`, and `updated_at`

#### Scenario: SKU inventory projection stores inventory counters

- **WHEN** a SKU inventory projection row is written
- **THEN** the row SHALL include `sku_id`, `aggregate_version`, `last_event_id`, `on_hand`, `reserved`, `sold`, `available`, and `updated_at`

#### Scenario: Order projection stores order state

- **WHEN** an order projection row is written
- **THEN** the row SHALL include `order_id`, `aggregate_version`, `last_event_id`, `checkout_intent_id`, `buyer_id`, `status`, `payment_status`, `items`, `total_amount`, `created_at`, and `updated_at`

#### Scenario: Projection checkpoint stores progress

- **WHEN** a projection batch completes
- **THEN** the system SHALL update `projection_checkpoint` with `projection_name`, `last_event_id`, and `updated_at`

#### Scenario: Projection row records its source event

- **WHEN** an aggregate projection row is updated from an event
- **THEN** the row SHALL store the source event's `aggregate_version` and global `event_store.id` as `last_event_id`

#### Scenario: Worker resumes from checkpoint

- **WHEN** a projection worker restarts
- **THEN** the worker SHALL read `projection_checkpoint.last_event_id` and continue scanning the shared `event_store` from the next global event id

#### Scenario: Client polls checkout intent status

- **WHEN** the client requests the status for an intent
- **THEN** the API SHALL read `checkout_intent_projection` and return the current status

#### Scenario: Client polls remaining inventory

- **WHEN** the client requests remaining inventory for a SKU
- **THEN** the API SHALL read `sku_inventory_projection` and return the current available quantity

### Requirement: Projection Processing Coordination

The system SHALL ensure only one projection processor applies a projection batch at a time for a given projection. The initial implementation SHALL coordinate multiple Next.js instances using PostgreSQL transaction-level advisory locks and projection checkpoints.

#### Scenario: Multiple servers process projections

- **WHEN** two Next.js instances attempt to process the same projection batch at the same time
- **THEN** only one instance SHALL acquire the projection lock and update the checkpoint

### Requirement: Inventory Reservation Outcome

The system SHALL convert checkout intents into inventory outcomes asynchronously. A checkout intent SHALL eventually become reserved, rejected, cancelled, expired, or confirmed.

#### Scenario: Inventory is available

- **WHEN** a checkout item is processed and sufficient SKU inventory is available
- **THEN** the system SHALL append `InventoryReserved` and update the checkout intent projection to a reserved or pending payment state when all required items are reserved

#### Scenario: Inventory is unavailable

- **WHEN** a checkout item is processed and sufficient SKU inventory is unavailable
- **THEN** the system SHALL append `InventoryReservationRejected` and update the checkout intent projection to rejected after releasing any already reserved items

### Requirement: Multi-SKU Checkout Saga

The system SHALL coordinate multi-SKU checkout through a Saga. The Saga SHALL request reservations per SKU, SHALL proceed to payment only when all items are reserved, and SHALL release already reserved inventory when any required item is rejected.

#### Scenario: All cart items reserve successfully

- **WHEN** every item in a checkout intent is reserved
- **THEN** the system SHALL append a payment request event and move the checkout intent to pending payment

#### Scenario: One cart item fails reservation

- **WHEN** any item in a checkout intent is rejected
- **THEN** the system SHALL append release events for already reserved items and move the checkout intent to rejected

### Requirement: Aggregate Root Invariants

The system SHALL enforce local consistency rules through aggregate roots before appending state-changing events. SKU, checkout, order, and payment aggregates SHALL each own their local invariants.

#### Scenario: SKU reservation command is handled

- **WHEN** the system attempts to reserve SKU inventory
- **THEN** the SKU aggregate root SHALL validate available inventory and duplicate reservation rules before `InventoryReserved` is appended

#### Scenario: Checkout saga advances state

- **WHEN** reservation outcomes arrive for a checkout intent
- **THEN** the checkout aggregate root SHALL validate the next checkout state before payment or rejection events are appended

### Requirement: Payment Failure Compensation

The system SHALL handle payment failure or timeout through compensation events. The system SHALL NOT roll back committed events when payment fails.

#### Scenario: Payment fails after reservation

- **WHEN** payment fails after inventory has been reserved
- **THEN** the system SHALL append `PaymentFailed`, append `InventoryReservationReleased`, and update the order projection to cancelled

#### Scenario: Payment callback is duplicated

- **WHEN** the same payment failure callback is received more than once
- **THEN** the system SHALL apply compensation at most once for the affected reservation

### Requirement: Client Polling UX

The system SHALL use SSR for initial product and inventory data and polling for checkout intent status and remaining inventory updates in the first implementation. The system SHALL NOT require SSE or WebSocket for correctness.

#### Scenario: Product page loads

- **WHEN** the product page is server-rendered
- **THEN** the system SHALL include product, SKU, and initial inventory projection data

#### Scenario: User waits after pressing Buy

- **WHEN** the user has an accepted checkout intent
- **THEN** the client SHALL poll the checkout intent status endpoint until the intent reaches a terminal or payment state

### Requirement: Deferred Kafka Integration

The system SHALL start without Kafka in the initial implementation. When Kafka becomes part of the formal processing path, the system SHALL use an outbox relay to publish committed PostgreSQL events.

#### Scenario: Kafka is not enabled

- **WHEN** the system runs the initial implementation
- **THEN** projection and inventory processing SHALL operate from PostgreSQL events without Kafka

#### Scenario: Kafka is enabled later

- **WHEN** Kafka is added to the formal processing path
- **THEN** the system SHALL publish through an outbox relay rather than relying on direct API dual writes

### Requirement: Day 1 Benchmark Baseline

The system SHALL define a repeatable PostgreSQL-only benchmark for the first implementation. The benchmark SHALL measure correctness, API latency, event store append throughput, and projection lag.

#### Scenario: Hot SKU benchmark runs

- **WHEN** the benchmark submits 1,000 concurrent buy attempts for one hot SKU
- **THEN** the system SHALL record accepted intents per second, API p95 latency, event store append throughput, projection lag, and final reservation outcomes

#### Scenario: Benchmark verifies correctness

- **WHEN** the benchmark completes
- **THEN** the system SHALL verify that inventory is not oversold, duplicate idempotency keys do not create duplicate intents, and every accepted intent reaches a terminal or payment state
