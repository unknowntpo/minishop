import { handleReserveInventory } from "@/src/application/inventory/reserve-inventory";
import type { CheckoutItem } from "@/src/domain/checkout/item";
import type {
  DomainEvent,
  InventoryReservationReleased,
  OrderConfirmed,
  PaymentRequested,
} from "@/src/domain/events/domain-event";
import type { EventMetadata } from "@/src/domain/events/event-metadata";
import type { CheckoutDemoRepository } from "@/src/ports/checkout-demo-repository";
import type { Clock } from "@/src/ports/clock";
import type { EventStore } from "@/src/ports/event-store";
import type { IdGenerator } from "@/src/ports/id-generator";

export type CompleteDemoCheckoutInput = {
  checkoutIntentId: string;
  metadata: EventMetadata;
};

export type CompleteDemoCheckoutDeps = {
  checkoutDemoRepository: CheckoutDemoRepository;
  eventStore: EventStore;
  idGenerator: IdGenerator;
  clock: Clock;
};

export type CompleteDemoCheckoutResult = {
  checkoutIntentId: string;
  status: "confirmed" | "rejected";
  orderId?: string;
  paymentId?: string;
  reason?: string;
};

export async function completeDemoCheckout(
  input: CompleteDemoCheckoutInput,
  deps: CompleteDemoCheckoutDeps,
): Promise<CompleteDemoCheckoutResult> {
  const checkout = await deps.checkoutDemoRepository.findCheckoutIntent(input.checkoutIntentId);

  if (!checkout) {
    throw new Error("checkout intent projection is required before demo completion.");
  }

  const outcomes = [];

  for (const [index, item] of checkout.items.entries()) {
    const onHand = await deps.checkoutDemoRepository.getSkuOnHand(item.sku_id);

    if (onHand === null) {
      throw new Error(`SKU inventory projection ${item.sku_id} is required.`);
    }

    const result = await handleReserveInventory(
      {
        checkoutIntentId: checkout.checkoutIntentId,
        reservationId: deps.idGenerator.randomUuid(),
        skuId: item.sku_id,
        quantity: item.quantity,
        onHand,
        metadata: input.metadata,
        idempotencyKey: `demo-reserve:${checkout.checkoutIntentId}:${index}`,
      },
      {
        eventStore: deps.eventStore,
        idGenerator: deps.idGenerator,
        clock: deps.clock,
      },
    );

    outcomes.push(result.event);
  }

  const rejected = outcomes.find((event) => event.type === "InventoryReservationRejected");

  if (rejected) {
    for (const event of outcomes) {
      if (event.type === "InventoryReserved") {
        await appendReleaseEvent(
          {
            type: "InventoryReservationReleased",
            version: 1,
            payload: {
              checkout_intent_id: checkout.checkoutIntentId,
              reservation_id: event.payload.reservation_id,
              sku_id: event.payload.sku_id,
              quantity: event.payload.quantity,
              reason: "cart_reservation_failed",
            },
          },
          deps,
          input.metadata,
        );
      }
    }

    return {
      checkoutIntentId: checkout.checkoutIntentId,
      status: "rejected",
      reason: rejected.payload.reason,
    };
  }

  const paymentId = deps.idGenerator.randomUuid();
  const orderId = deps.idGenerator.randomUuid();
  const totalAmountMinor = totalAmount(checkout.items);

  await appendPaymentRequested(
    {
      type: "PaymentRequested",
      version: 1,
      payload: {
        payment_id: paymentId,
        checkout_intent_id: checkout.checkoutIntentId,
        amount: totalAmountMinor,
        idempotency_key: `demo-payment:${checkout.checkoutIntentId}`,
      },
    },
    deps,
    input.metadata,
  );

  const order = await appendOrderConfirmed(
    {
      type: "OrderConfirmed",
      version: 1,
      payload: {
        order_id: orderId,
        checkout_intent_id: checkout.checkoutIntentId,
        buyer_id: checkout.buyerId,
        items: checkout.items,
        total_amount_minor: totalAmountMinor,
      },
    },
    deps,
    input.metadata,
  );

  return {
    checkoutIntentId: checkout.checkoutIntentId,
    status: "confirmed",
    paymentId,
    orderId: order.event.payload.order_id,
  };
}

async function appendReleaseEvent(
  event: InventoryReservationReleased,
  deps: CompleteDemoCheckoutDeps,
  metadata: EventMetadata,
) {
  const priorEvents = await deps.eventStore.readAggregateEvents("sku", event.payload.sku_id);

  await appendEvent(event, {
    aggregateType: "sku",
    aggregateId: event.payload.sku_id,
    aggregateVersion: priorEvents.length + 1,
    idempotencyKey: `demo-release:${event.payload.checkout_intent_id}:${event.payload.reservation_id}`,
    deps,
    metadata,
  });
}

async function appendPaymentRequested(
  event: PaymentRequested,
  deps: CompleteDemoCheckoutDeps,
  metadata: EventMetadata,
) {
  await appendEvent(event, {
    aggregateType: "payment",
    aggregateId: event.payload.payment_id,
    aggregateVersion: 1,
    idempotencyKey: event.payload.idempotency_key,
    deps,
    metadata,
  });
}

async function appendOrderConfirmed(
  event: OrderConfirmed,
  deps: CompleteDemoCheckoutDeps,
  metadata: EventMetadata,
) {
  return appendEvent(event, {
    aggregateType: "order",
    aggregateId: event.payload.order_id,
    aggregateVersion: 1,
    idempotencyKey: `demo-order:${event.payload.checkout_intent_id}`,
    deps,
    metadata,
  });
}

async function appendEvent<TEvent extends DomainEvent>(
  event: TEvent,
  input: {
    aggregateType: "sku" | "payment" | "order";
    aggregateId: string;
    aggregateVersion: number;
    idempotencyKey: string;
    deps: CompleteDemoCheckoutDeps;
    metadata: EventMetadata;
  },
) {
  return input.deps.eventStore.append({
    eventId: input.deps.idGenerator.randomUuid(),
    event,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    metadata: input.metadata,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.deps.clock.now(),
  });
}

function totalAmount(items: CheckoutItem[]) {
  return items.reduce((sum, item) => sum + item.unit_price_amount_minor * item.quantity, 0);
}
