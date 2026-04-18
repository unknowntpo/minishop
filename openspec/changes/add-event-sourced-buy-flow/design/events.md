# Event Dictionary

```text
CheckoutIntentCreated
  aggregate: checkout
  meaning: user submitted a direct Buy or cart checkout request
  payload: checkout_intent_id, buyer_id, items[], idempotency_key

InventoryReservationRequested
  aggregate: sku
  meaning: checkout saga asks a SKU aggregate to try reserving inventory
  payload: checkout_intent_id, reservation_id, sku_id, quantity

InventoryReserved
  aggregate: sku
  meaning: SKU inventory was reserved for a checkout item
  payload: checkout_intent_id, reservation_id, sku_id, quantity, expires_at

InventoryReservationRejected
  aggregate: sku
  meaning: SKU inventory could not be reserved
  payload: checkout_intent_id, reservation_id, sku_id, quantity, reason

PaymentRequested
  aggregate: payment
  meaning: checkout has all required reservations and payment should start
  payload: payment_id, checkout_intent_id, amount, idempotency_key

PaymentSucceeded
  aggregate: payment
  meaning: payment provider confirmed successful payment
  payload: payment_id, checkout_intent_id, provider_reference

PaymentFailed
  aggregate: payment
  meaning: payment provider failed, rejected, or timed out the payment
  payload: payment_id, checkout_intent_id, reason

InventoryReservationReleased
  aggregate: sku
  meaning: previously reserved inventory was released by compensation or timeout
  payload: checkout_intent_id, reservation_id, sku_id, quantity, reason

OrderConfirmed
  aggregate: order
  meaning: checkout completed successfully and became a confirmed order
  payload: order_id, checkout_intent_id, buyer_id, items[], total_amount_minor

OrderCancelled
  aggregate: order
  meaning: pending order was cancelled after payment failure or timeout
  payload: order_id, checkout_intent_id, reason
```

## Event Type Constraints

Supported event type values:

```text
CheckoutIntentCreated
InventoryReservationRequested
InventoryReserved
InventoryReservationRejected
PaymentRequested
PaymentSucceeded
PaymentFailed
InventoryReservationReleased
OrderConfirmed
OrderCancelled
```

The implementation must define these values as a TypeScript string union or equivalent constant object. The database must constrain `event_store.event_type` with a check constraint in the first implementation.

PostgreSQL enum types are optional later. A check constraint is preferred during early design because event type changes are easier to migrate.

## Event Schema Evolution

Stored events are durable business facts. Once an event is appended to
`event_store`, the row must remain replayable by future application versions.
Application code may evolve, but old event rows must not require in-place
rewrites to remain readable.

Event schema compatibility is handled by `event_type` plus `event_version`.

```text
event_type:
  stable business fact name

event_version:
  payload shape version for that fact
```

Use a new `event_version` when the business fact remains the same but the
payload shape evolves.

Examples:

```text
CheckoutIntentCreated v1:
  checkout_intent_id, buyer_id, items[], idempotency_key

CheckoutIntentCreated v2:
  checkout_intent_id, buyer_id, items[], idempotency_key, sales_channel
```

Use a new `event_type` when the business meaning changes. Do not reuse an old
event type for a different fact.

Examples:

```text
safe version change:
  add optional sales_channel to CheckoutIntentCreated

new event type required:
  CheckoutIntentPriced
  CheckoutIntentValidated
```

## Compatibility Policy

Stored event readers must support backward compatibility:

```text
new code can read old event versions
old events can be replayed from event_store
missing optional fields are filled with explicit defaults
```

Stored event readers should be forward tolerant for additive changes:

```text
unknown extra payload fields do not fail replay
unknown extra metadata fields do not fail replay
```

Breaking changes are not allowed in-place:

```text
rename a payload field
remove a field that existing readers require
change a field type
change a field unit, e.g. minor-unit money to decimal money
change a field meaning, e.g. occurred_at from event time to ingestion time
reuse an event type for a different business fact
remove or redefine an existing enum/status value without a fallback
```

Command validation and event replay validation have different strictness.

```text
commands:
  strict request validation
  invalid input can be rejected

stored events:
  tolerant replay validation
  old durable facts must remain readable
```

When a current domain reader needs a newer payload shape, use an upcaster in
the event decoding path rather than rewriting historical rows.

```text
CheckoutIntentCreated v1
  -> upcast with sales_channel = "web"
  -> current CheckoutIntentCreated domain shape
```

Schema compatibility is not enough by itself. Field semantics, units, enum
meaning, aggregate ordering, and replay expectations are part of the event
contract and must be documented with event changes.
