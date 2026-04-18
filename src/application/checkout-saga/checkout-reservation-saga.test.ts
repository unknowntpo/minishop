import { describe, expect, it } from "vitest";

import {
  createInventoryReservationRequests,
  decideReservationOutcome,
} from "@/src/application/checkout-saga/checkout-reservation-saga";
import type { InventoryReserved } from "@/src/domain/events/domain-event";
import type { IdGenerator } from "@/src/ports/id-generator";

describe("checkout reservation saga", () => {
  it("creates one reservation request per SKU item using SKU aggregates", () => {
    const requests = createInventoryReservationRequests({
      checkoutIntentId: "checkout_1",
      idGenerator: new SequenceIdGenerator(["reservation_1", "reservation_2"]),
      items: [
        {
          sku_id: "sku_hot_001",
          quantity: 1,
          unit_price_amount_minor: 100000,
          currency: "TWD",
        },
        {
          sku_id: "sku_tee_001",
          quantity: 2,
          unit_price_amount_minor: 68000,
          currency: "TWD",
        },
      ],
    });

    expect(requests.map((request) => request.aggregateId)).toEqual(["sku_hot_001", "sku_tee_001"]);
    expect(requests.map((request) => request.event.payload.reservation_id)).toEqual([
      "reservation_1",
      "reservation_2",
    ]);
  });

  it("requests payment when every reservation succeeds", () => {
    const decision = decideReservationOutcome({
      checkoutIntentId: "checkout_1",
      paymentId: "payment_1",
      paymentIdempotencyKey: "payment_idem_1",
      totalAmountMinor: 236000,
      outcomes: [
        reserved("reservation_1", "sku_hot_001", 1),
        reserved("reservation_2", "sku_tee_001", 2),
      ],
    });

    expect(decision).toMatchObject({
      status: "ready_for_payment",
      event: {
        type: "PaymentRequested",
        payload: {
          amount: 236000,
        },
      },
    });
  });

  it("releases successful reservations when one SKU rejects", () => {
    const decision = decideReservationOutcome({
      checkoutIntentId: "checkout_1",
      paymentId: "payment_1",
      paymentIdempotencyKey: "payment_idem_1",
      totalAmountMinor: 236000,
      outcomes: [
        reserved("reservation_1", "sku_hot_001", 1),
        {
          type: "InventoryReservationRejected",
          version: 1,
          payload: {
            checkout_intent_id: "checkout_1",
            reservation_id: "reservation_2",
            sku_id: "sku_tee_001",
            quantity: 2,
            reason: "insufficient_inventory",
          },
        },
      ],
    });

    expect(decision).toMatchObject({
      status: "rejected",
      releaseEvents: [
        {
          type: "InventoryReservationReleased",
          payload: {
            reservation_id: "reservation_1",
            reason: "cart_reservation_failed",
          },
        },
      ],
    });
  });
});

function reserved(reservationId: string, skuId: string, quantity: number): InventoryReserved {
  return {
    type: "InventoryReserved",
    version: 1,
    payload: {
      checkout_intent_id: "checkout_1",
      reservation_id: reservationId,
      sku_id: skuId,
      quantity,
      expires_at: "2026-04-18T00:15:00.000Z",
    },
  };
}

class SequenceIdGenerator implements IdGenerator {
  private nextIndex = 0;

  constructor(private readonly values: string[]) {}

  randomUuid() {
    const value = this.values[this.nextIndex];
    this.nextIndex += 1;

    if (!value) {
      throw new Error("No id left in test sequence.");
    }

    return value;
  }
}
