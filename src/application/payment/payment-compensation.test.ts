import { describe, expect, it } from "vitest";

import { planPaymentFailureCompensation } from "@/src/application/payment/payment-compensation";

describe("planPaymentFailureCompensation", () => {
  it("emits payment failed, inventory releases, and order cancelled compensation events", () => {
    const plan = planPaymentFailureCompensation({
      paymentId: "payment_1",
      checkoutIntentId: "checkout_1",
      orderId: "order_1",
      reason: "card_declined",
      reservations: [
        {
          type: "InventoryReserved",
          version: 1,
          payload: {
            checkout_intent_id: "checkout_1",
            reservation_id: "reservation_1",
            sku_id: "sku_hot_001",
            quantity: 1,
            expires_at: "2026-04-18T00:15:00.000Z",
          },
        },
      ],
    });

    expect(plan.paymentFailed).toMatchObject({
      type: "PaymentFailed",
      payload: {
        reason: "card_declined",
      },
    });
    expect(plan.releaseEvents).toEqual([
      {
        type: "InventoryReservationReleased",
        version: 1,
        payload: {
          checkout_intent_id: "checkout_1",
          reservation_id: "reservation_1",
          sku_id: "sku_hot_001",
          quantity: 1,
          reason: "payment_failed",
        },
      },
    ]);
    expect(plan.orderCancelled).toMatchObject({
      type: "OrderCancelled",
      payload: {
        order_id: "order_1",
        reason: "card_declined",
      },
    });
  });
});
