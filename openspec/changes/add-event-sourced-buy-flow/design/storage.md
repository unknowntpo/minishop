# Storage Schema

```text
event_store
  id BIGSERIAL PRIMARY KEY
  event_id UUID UNIQUE
  event_type TEXT
  event_version INT
  aggregate_type TEXT
  aggregate_id TEXT
  aggregate_version BIGINT
  payload JSONB
  metadata JSONB
  idempotency_key TEXT NULL
  occurred_at TIMESTAMPTZ

  unique: event_id
  unique: aggregate_type, aggregate_id, aggregate_version
  partial unique: idempotency_key where not null
  index: aggregate_type, aggregate_id, aggregate_version
  index: event_type, id

  event_type values:
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

product
  product_id TEXT PRIMARY KEY
  name TEXT
  description TEXT NULL
  status TEXT
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

sku
  sku_id TEXT PRIMARY KEY
  product_id TEXT REFERENCES product(product_id)
  sku_code TEXT UNIQUE
  name TEXT
  price_amount_minor BIGINT
  currency TEXT
  status TEXT
  attributes JSONB
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

checkout_intent_projection
  checkout_intent_id UUID PRIMARY KEY
  aggregate_version BIGINT
  last_event_id BIGINT
  buyer_id TEXT
  status TEXT
  items JSONB
  payment_id UUID NULL
  order_id UUID NULL
  rejection_reason TEXT NULL
  cancellation_reason TEXT NULL
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

  status values:
    queued
    reserving
    reserved
    pending_payment
    confirmed
    rejected
    cancelled
    expired

sku_inventory_projection
  sku_id TEXT PRIMARY KEY
  aggregate_version BIGINT
  last_event_id BIGINT
  on_hand INT
  reserved INT
  sold INT
  available INT
  updated_at TIMESTAMPTZ

order_projection
  order_id UUID PRIMARY KEY
  aggregate_version BIGINT
  last_event_id BIGINT
  checkout_intent_id UUID
  buyer_id TEXT
  status TEXT
  payment_status TEXT
  items JSONB
  total_amount_minor BIGINT
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

  status values:
    pending_payment
    confirmed
    cancelled

  payment_status values:
    not_requested
    requested
    succeeded
    failed
    timeout

projection_checkpoint
  projection_name TEXT PRIMARY KEY
  last_event_id BIGINT
  updated_at TIMESTAMPTZ
```

`items` remains JSONB in the first implementation. Item-level projection tables can be added later if analytics or per-item querying becomes important.

Projection rows and projection checkpoints have different purposes:

```text
projection row aggregate_version:
  aggregate-local version represented by that row

projection row last_event_id:
  global event_store id that last updated that row

projection_checkpoint last_event_id:
  global event_store id processed by a projection worker
```

The event store is a single table for all domain events, so each projection worker needs a checkpoint to resume scanning from the next global event id.

Catalog tables use singular names. `product` and `sku` are seed/static tables in the first implementation. Catalog metadata is not event sourced in the MVP; inventory remains event sourced by SKU.

Projection status columns are stored as constrained text in the first implementation. They must be validated by application code and database checks or enum types in migrations.

`event_store.event_type` is also stored as constrained text in the first implementation. TypeScript must expose an exhaustive event type union, and PostgreSQL must enforce allowed values with a check constraint.
