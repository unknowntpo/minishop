# Command Boundary

Commands represent requests to do work. Events represent facts that already happened.

## Commands

```text
CreateCheckoutIntent
  target: checkout
  emits: CheckoutIntentCreated

RequestInventoryReservation
  target: sku
  emits: InventoryReservationRequested

ReserveInventory
  target: sku
  emits: InventoryReserved or InventoryReservationRejected

RequestPayment
  target: payment
  emits: PaymentRequested

RecordPaymentSucceeded
  target: payment
  emits: PaymentSucceeded

RecordPaymentFailed
  target: payment
  emits: PaymentFailed

ReleaseInventoryReservation
  target: sku
  emits: InventoryReservationReleased

ConfirmOrder
  target: order
  emits: OrderConfirmed

CancelOrder
  target: order
  emits: OrderCancelled
```

## Rules

```text
Command:
  imperative
  can fail validation
  not stored as durable truth by default

Event:
  past tense fact
  appended after validation
  stored in event_store
  drives projections and downstream processing
```

`InventoryReservationRequested` is modeled as an event because the checkout saga has durably asked inventory to reserve a SKU. The actual reservation outcome is `InventoryReserved` or `InventoryReservationRejected`.
