# Architecture Diagrams

## System

```text
Browser
   |
   | SSR product page
   | POST /api/checkout-intents
   | polling status/inventory
   v
+-------------------+
| Next.js           |
| Node.js 24 LTS    |
+-------------------+
   |          ^
   | write    | read
   v          |
+-------------------+        +-----------------------------+
| PostgreSQL        |        | Projection processor         |
| event_store       | <----- | Next.js internal route first |
| projections       | -----> | independent worker later     |
| checkpoints       |        +-----------------------------+
+-------------------+
   |
   | later phase
   v
+-------------------+
| Outbox relay      |
+-------------------+
   |
   v
+-------------------+
| Kafka             |
| deferred          |
+-------------------+

Redis is deferred and cache-only.
```

## Checkout Flow

```text
User clicks Buy or checks out cart
      |
      v
Create checkout_intent_id + idempotency_key
      |
      v
+------------------------------+
| Append CheckoutIntentCreated |
| aggregate_type = checkout    |
| aggregate_id = checkout_id   |
+------------------------------+
      |
      v
Return accepted, status = queued
      |
      v
Projection processor reads event_store
      |
      v
+------------------------------+
| Process SKU inventory        |
| aggregate_type = sku         |
| aggregate_id = sku_id        |
+------------------------------+
      |
      +--------------------+
      |                    |
      v                    v
InventoryReserved    InventoryReservationRejected
      |                    |
      v                    v
PaymentRequested     Intent rejected
```

## Multi-SKU Saga

```text
CheckoutIntentCreated
  items: sku_A, sku_B, sku_C
      |
      v
Checkout Saga
      |
      +--> request reservation for sku_A
      +--> request reservation for sku_B
      +--> request reservation for sku_C
      |
      +-------------------------+
      |                         |
      v                         v
All items reserved          Any item rejected
      |                         |
      v                         v
PaymentRequested       Release reserved items
      |                         |
      v                         v
OrderPendingPayment    CheckoutRejected
```

## Payment Compensation

```text
InventoryReserved
      |
      v
OrderPendingPayment
      |
      v
PaymentRequested
      |
      +------------------------+
      |                        |
      v                        v
PaymentSucceeded          PaymentFailed / Timeout
      |                        |
      v                        v
OrderConfirmed       InventoryReservationReleased
                               |
                               v
                         OrderCancelled
```
