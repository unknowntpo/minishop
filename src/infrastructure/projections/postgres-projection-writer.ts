import type { PoolClient } from "pg";

import type { CheckoutItem } from "@/src/domain/checkout/item";
import type { DomainEvent } from "@/src/domain/events/domain-event";
import type { StoredEvent } from "@/src/ports/event-store";

export async function applyProjectionEvent(client: PoolClient, storedEvent: StoredEvent) {
  switch (storedEvent.event.type) {
    case "CheckoutIntentCreated":
      await applyCheckoutIntentCreated(client, storedEvent);
      return;
    case "InventoryReservationRequested":
      await updateCheckoutStatus(client, {
        checkoutIntentId: storedEvent.event.payload.checkout_intent_id,
        status: "reserving",
        lastEventId: storedEvent.id,
      });
      return;
    case "InventoryReserved":
      await applyInventoryReserved(client, storedEvent);
      return;
    case "InventoryReservationRejected":
      await applyInventoryReservationRejected(client, storedEvent);
      return;
    case "PaymentRequested":
      await applyPaymentRequested(client, storedEvent);
      return;
    case "PaymentSucceeded":
      await updateOrderPaymentStatus(client, {
        checkoutIntentId: storedEvent.event.payload.checkout_intent_id,
        paymentStatus: "succeeded",
        lastEventId: storedEvent.id,
      });
      return;
    case "PaymentFailed":
      await applyPaymentFailed(client, storedEvent);
      return;
    case "InventoryReservationReleased":
      await applyInventoryReservationReleased(client, storedEvent);
      return;
    case "OrderConfirmed":
      await applyOrderConfirmed(client, storedEvent);
      return;
    case "OrderCancelled":
      await applyOrderCancelled(client, storedEvent);
      return;
  }
}

async function applyCheckoutIntentCreated(client: PoolClient, storedEvent: StoredEvent) {
  const payload = (storedEvent.event as Extract<DomainEvent, { type: "CheckoutIntentCreated" }>)
    .payload;

  await client.query(
    `
      insert into checkout_intent_projection (
        checkout_intent_id,
        aggregate_version,
        last_event_id,
        buyer_id,
        status,
        items,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, 'queued', $5::jsonb, $6, $6)
      on conflict (checkout_intent_id)
      do update set
        aggregate_version = greatest(checkout_intent_projection.aggregate_version, excluded.aggregate_version),
        last_event_id = excluded.last_event_id,
        buyer_id = excluded.buyer_id,
        status = excluded.status,
        items = excluded.items,
        updated_at = excluded.updated_at
    `,
    [
      payload.checkout_intent_id,
      storedEvent.aggregateVersion,
      storedEvent.id,
      payload.buyer_id,
      JSON.stringify(payload.items),
      storedEvent.occurredAt,
    ],
  );
}

async function applyInventoryReserved(client: PoolClient, storedEvent: StoredEvent) {
  const payload = (storedEvent.event as Extract<DomainEvent, { type: "InventoryReserved" }>)
    .payload;

  await client.query(
    `
      update sku_inventory_projection
      set
        aggregate_version = $2,
        last_event_id = $3,
        reserved = reserved + $4,
        available = available - $4,
        updated_at = now()
      where sku_id = $1
    `,
    [payload.sku_id, storedEvent.aggregateVersion, storedEvent.id, payload.quantity],
  );

  await updateCheckoutStatus(client, {
    checkoutIntentId: payload.checkout_intent_id,
    status: "reserved",
    lastEventId: storedEvent.id,
  });
}

async function applyInventoryReservationRejected(client: PoolClient, storedEvent: StoredEvent) {
  const payload = (
    storedEvent.event as Extract<DomainEvent, { type: "InventoryReservationRejected" }>
  ).payload;

  await client.query(
    `
      update checkout_intent_projection
      set
        status = 'rejected',
        rejection_reason = $2,
        last_event_id = $3,
        updated_at = now()
      where checkout_intent_id = $1
    `,
    [payload.checkout_intent_id, payload.reason, storedEvent.id],
  );
}

async function applyPaymentRequested(client: PoolClient, storedEvent: StoredEvent) {
  const payload = (storedEvent.event as Extract<DomainEvent, { type: "PaymentRequested" }>).payload;

  await client.query(
    `
      update checkout_intent_projection
      set
        status = 'pending_payment',
        payment_id = $2,
        last_event_id = $3,
        updated_at = now()
      where checkout_intent_id = $1
    `,
    [payload.checkout_intent_id, payload.payment_id, storedEvent.id],
  );

  await updateOrderPaymentStatus(client, {
    checkoutIntentId: payload.checkout_intent_id,
    paymentStatus: "requested",
    lastEventId: storedEvent.id,
  });
}

async function applyPaymentFailed(client: PoolClient, storedEvent: StoredEvent) {
  const payload = (storedEvent.event as Extract<DomainEvent, { type: "PaymentFailed" }>).payload;

  await client.query(
    `
      update checkout_intent_projection
      set
        status = 'cancelled',
        cancellation_reason = $2,
        last_event_id = $3,
        updated_at = now()
      where checkout_intent_id = $1
    `,
    [payload.checkout_intent_id, payload.reason, storedEvent.id],
  );

  await updateOrderPaymentStatus(client, {
    checkoutIntentId: payload.checkout_intent_id,
    paymentStatus: "failed",
    lastEventId: storedEvent.id,
  });
}

async function applyInventoryReservationReleased(client: PoolClient, storedEvent: StoredEvent) {
  const payload = (
    storedEvent.event as Extract<DomainEvent, { type: "InventoryReservationReleased" }>
  ).payload;

  await client.query(
    `
      update sku_inventory_projection
      set
        aggregate_version = $2,
        last_event_id = $3,
        reserved = reserved - $4,
        available = available + $4,
        updated_at = now()
      where sku_id = $1
    `,
    [payload.sku_id, storedEvent.aggregateVersion, storedEvent.id, payload.quantity],
  );
}

async function applyOrderConfirmed(client: PoolClient, storedEvent: StoredEvent) {
  const payload = (storedEvent.event as Extract<DomainEvent, { type: "OrderConfirmed" }>).payload;

  await client.query(
    `
      insert into order_projection (
        order_id,
        aggregate_version,
        last_event_id,
        checkout_intent_id,
        buyer_id,
        status,
        payment_status,
        items,
        total_amount_minor,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, 'confirmed', 'succeeded', $6::jsonb, $7, $8, $8)
      on conflict (order_id)
      do update set
        aggregate_version = excluded.aggregate_version,
        last_event_id = excluded.last_event_id,
        status = excluded.status,
        payment_status = excluded.payment_status,
        items = excluded.items,
        total_amount_minor = excluded.total_amount_minor,
        updated_at = excluded.updated_at
    `,
    [
      payload.order_id,
      storedEvent.aggregateVersion,
      storedEvent.id,
      payload.checkout_intent_id,
      payload.buyer_id,
      JSON.stringify(payload.items),
      payload.total_amount_minor,
      storedEvent.occurredAt,
    ],
  );

  await client.query(
    `
      update checkout_intent_projection
      set
        status = 'confirmed',
        order_id = $2,
        last_event_id = $3,
        updated_at = now()
      where checkout_intent_id = $1
    `,
    [payload.checkout_intent_id, payload.order_id, storedEvent.id],
  );

  await applySoldInventory(client, payload.items, storedEvent.id);
}

async function applyOrderCancelled(client: PoolClient, storedEvent: StoredEvent) {
  const payload = (storedEvent.event as Extract<DomainEvent, { type: "OrderCancelled" }>).payload;

  await client.query(
    `
      update order_projection
      set
        aggregate_version = $2,
        last_event_id = $3,
        status = 'cancelled',
        payment_status = 'failed',
        updated_at = now()
      where order_id = $1
    `,
    [payload.order_id, storedEvent.aggregateVersion, storedEvent.id],
  );

  await client.query(
    `
      update checkout_intent_projection
      set
        status = 'cancelled',
        cancellation_reason = $2,
        last_event_id = $3,
        updated_at = now()
      where checkout_intent_id = $1
    `,
    [payload.checkout_intent_id, payload.reason, storedEvent.id],
  );
}

async function updateCheckoutStatus(
  client: PoolClient,
  input: {
    checkoutIntentId: string;
    status: "reserving" | "reserved";
    lastEventId: number;
  },
) {
  await client.query(
    `
      update checkout_intent_projection
      set
        status = $2,
        last_event_id = $3,
        updated_at = now()
      where checkout_intent_id = $1
        and status not in ('rejected', 'cancelled', 'confirmed', 'expired')
    `,
    [input.checkoutIntentId, input.status, input.lastEventId],
  );
}

async function updateOrderPaymentStatus(
  client: PoolClient,
  input: {
    checkoutIntentId: string;
    paymentStatus: "requested" | "succeeded" | "failed";
    lastEventId: number;
  },
) {
  await client.query(
    `
      update order_projection
      set
        payment_status = $2,
        last_event_id = $3,
        updated_at = now()
      where checkout_intent_id = $1
    `,
    [input.checkoutIntentId, input.paymentStatus, input.lastEventId],
  );
}

async function applySoldInventory(client: PoolClient, items: CheckoutItem[], lastEventId: number) {
  for (const item of items) {
    await client.query(
      `
        update sku_inventory_projection
        set
          last_event_id = $2,
          reserved = reserved - $3,
          sold = sold + $3,
          updated_at = now()
        where sku_id = $1
      `,
      [item.sku_id, lastEventId, item.quantity],
    );
  }
}
