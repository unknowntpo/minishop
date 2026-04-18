import type { CheckoutItem } from "@/src/domain/checkout/item";
import type {
  InventoryReservationRejected,
  InventoryReservationReleased,
  InventoryReservationRequested,
  InventoryReserved,
  PaymentRequested,
} from "@/src/domain/events/domain-event";
import type { IdGenerator } from "@/src/ports/id-generator";

export type ReservationRequestPlan = {
  event: InventoryReservationRequested;
  aggregateType: "sku";
  aggregateId: string;
};

export type ReservationOutcomeDecision =
  | {
      status: "ready_for_payment";
      event: PaymentRequested;
    }
  | {
      status: "rejected";
      releaseEvents: InventoryReservationReleased[];
      reason: string;
    };

export function createInventoryReservationRequests({
  checkoutIntentId,
  items,
  idGenerator,
}: {
  checkoutIntentId: string;
  items: CheckoutItem[];
  idGenerator: IdGenerator;
}): ReservationRequestPlan[] {
  return items.map((item) => ({
    aggregateType: "sku",
    aggregateId: item.sku_id,
    event: {
      type: "InventoryReservationRequested",
      version: 1,
      payload: {
        checkout_intent_id: checkoutIntentId,
        reservation_id: idGenerator.randomUuid(),
        sku_id: item.sku_id,
        quantity: item.quantity,
      },
    },
  }));
}

export function decideReservationOutcome({
  checkoutIntentId,
  outcomes,
  paymentId,
  paymentIdempotencyKey,
  totalAmountMinor,
}: {
  checkoutIntentId: string;
  outcomes: Array<InventoryReserved | InventoryReservationRejected>;
  paymentId: string;
  paymentIdempotencyKey: string;
  totalAmountMinor: number;
}): ReservationOutcomeDecision {
  const rejected = outcomes.find((event) => event.type === "InventoryReservationRejected");

  if (rejected) {
    return {
      status: "rejected",
      reason: rejected.payload.reason,
      releaseEvents: outcomes
        .filter((event): event is InventoryReserved => event.type === "InventoryReserved")
        .map((event) => ({
          type: "InventoryReservationReleased",
          version: 1,
          payload: {
            checkout_intent_id: checkoutIntentId,
            reservation_id: event.payload.reservation_id,
            sku_id: event.payload.sku_id,
            quantity: event.payload.quantity,
            reason: "cart_reservation_failed",
          },
        })),
    };
  }

  if (!Number.isInteger(totalAmountMinor) || totalAmountMinor < 0) {
    throw new Error("totalAmountMinor must be a non-negative integer.");
  }

  return {
    status: "ready_for_payment",
    event: {
      type: "PaymentRequested",
      version: 1,
      payload: {
        payment_id: paymentId,
        checkout_intent_id: checkoutIntentId,
        amount: totalAmountMinor,
        idempotency_key: paymentIdempotencyKey,
      },
    },
  };
}
