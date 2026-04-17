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
  payload: order_id, checkout_intent_id, buyer_id, items[], total_amount

OrderCancelled
  aggregate: order
  meaning: pending order was cancelled after payment failure or timeout
  payload: order_id, checkout_intent_id, reason
```
