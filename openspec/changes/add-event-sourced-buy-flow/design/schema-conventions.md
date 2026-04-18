# Schema Conventions

## IDs

```text
checkout_intent_id:
  UUID

event_id:
  UUID

reservation_id:
  UUID

payment_id:
  UUID

order_id:
  UUID

product_id:
  TEXT, stable seed identifier

sku_id:
  TEXT, stable seed identifier
```

## Buyer Identity

```text
buyer_id:
  TEXT
```

MVP does not require a user table. `buyer_id` is an external or synthetic identity used for idempotency, benchmark users, and projections.

## Money

Money values use integer minor units.

```text
price_amount_minor:
  integer minor units

total_amount_minor:
  integer minor units

currency:
  ISO-like uppercase code, e.g. TWD, USD
```

Floating point money is not allowed.

Examples:

```text
USD 5.23 -> amount_minor = 523
TWD 120.00 -> amount_minor = 12000
JPY 500 -> amount_minor = 500
```

Money columns use `BIGINT` in PostgreSQL.

## Checkout Item JSON

`items` is JSONB in the first implementation.

Minimum item shape:

```json
{
  "sku_id": "sku_hot_001",
  "quantity": 1,
  "unit_price_amount_minor": 1000,
  "currency": "TWD"
}
```

Rules:

```text
sku_id is the purchasable unit and inventory boundary
product_id is not required in checkout item JSON because it is resolved through sku.product_id
quantity must be a positive integer
unit_price_amount_minor must be integer minor units
checkout item currency must match checkout/order currency
```

## Event Metadata JSON

Minimum metadata shape:

```json
{
  "request_id": "req_...",
  "trace_id": "trace_...",
  "source": "web",
  "actor_id": "buyer_..."
}
```

`metadata` is for observability and routing context, not business state.

## Reservation Identity

`reservation_id` identifies one attempt to reserve one SKU item for one checkout intent.

```text
checkout_intent_id + sku_id + reservation_id
```

It appears in reservation-related events:

```text
InventoryReservationRequested
InventoryReserved
InventoryReservationRejected
InventoryReservationReleased
```

There is no separate reservation table in the MVP. Reservation state is derived from events and projections.

## Foreign Key Policy

```text
event_store:
  no foreign keys to aggregate tables

catalog/projection tables:
  foreign keys are allowed when the relationship is direct and non-polymorphic
```

Rationale:

```text
event_store.aggregate_id is polymorphic:
  checkout_id
  sku_id
  payment_id
  order_id

Only some rows refer to sku.sku_id, so a direct FK from event_store.aggregate_id to sku is not correct.
```

Command handlers and aggregate roots validate that referenced catalog entities exist and are active before appending events.

## Validation Boundary

Schema conventions are enforced in TypeScript before durable event append:

```text
src/domain/schema-conventions.ts:
  UUID identifiers
  stable product_id / sku_id text identifiers
  uppercase currency codes
  positive integer quantities
  non-negative integer minor-unit money
  checkout item JSON shape
  event metadata JSON shape
  reservation identity payloads
```

API parsers validate incoming request shapes before creating commands. Domain event guards validate event payloads before PostgreSQL insert. The PostgreSQL event store validates `event_id`, aggregate identifier shape, and event metadata before inserting into `event_store`.

Tests cover the schema convention validators directly so convention drift is visible before database writes are involved.
