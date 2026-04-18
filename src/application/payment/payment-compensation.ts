import type {
  InventoryReservationReleased,
  InventoryReserved,
  OrderCancelled,
  PaymentFailed,
} from "@/src/domain/events/domain-event";

export type PaymentFailureCompensationInput = {
  paymentId: string;
  checkoutIntentId: string;
  orderId: string;
  reason: string;
  reservations: InventoryReserved[];
};

export type PaymentFailureCompensationPlan = {
  paymentFailed: PaymentFailed;
  releaseEvents: InventoryReservationReleased[];
  orderCancelled: OrderCancelled;
};

export function planPaymentFailureCompensation(
  input: PaymentFailureCompensationInput,
): PaymentFailureCompensationPlan {
  return {
    paymentFailed: {
      type: "PaymentFailed",
      version: 1,
      payload: {
        payment_id: input.paymentId,
        checkout_intent_id: input.checkoutIntentId,
        reason: input.reason,
      },
    },
    releaseEvents: input.reservations.map((reservation) => ({
      type: "InventoryReservationReleased",
      version: 1,
      payload: {
        checkout_intent_id: input.checkoutIntentId,
        reservation_id: reservation.payload.reservation_id,
        sku_id: reservation.payload.sku_id,
        quantity: reservation.payload.quantity,
        reason: "payment_failed",
      },
    })),
    orderCancelled: {
      type: "OrderCancelled",
      version: 1,
      payload: {
        order_id: input.orderId,
        checkout_intent_id: input.checkoutIntentId,
        reason: input.reason,
      },
    },
  };
}
