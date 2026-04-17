# State Transitions

## Checkout Intent

```text
queued
  -> reserving

reserving
  -> reserved
  -> rejected

reserved
  -> pending_payment

pending_payment
  -> confirmed
  -> cancelled
  -> expired
```

Terminal checkout states:

```text
confirmed
rejected
cancelled
expired
```

## Order

```text
pending_payment
  -> confirmed
  -> cancelled
```

Terminal order states:

```text
confirmed
cancelled
```

## Payment

```text
not_requested
  -> requested

requested
  -> succeeded
  -> failed
  -> timeout
```

Terminal payment states:

```text
succeeded
failed
timeout
```

## Inventory Counters

```text
InventoryReserved:
  reserved += quantity
  available -= quantity

InventoryReservationReleased:
  reserved -= quantity
  available += quantity

OrderConfirmed:
  reserved -= quantity
  sold += quantity
```

Inventory counters must never become negative. `available` must equal `on_hand - reserved - sold`.
