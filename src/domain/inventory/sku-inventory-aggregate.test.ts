import { describe, expect, it } from "vitest";

import type { InventoryReserved } from "@/src/domain/events/domain-event";
import {
  createSkuInventoryState,
  releaseInventoryReservation,
  replaySkuInventoryEvents,
  reserveInventory,
} from "@/src/domain/inventory/sku-inventory-aggregate";

describe("sku inventory aggregate", () => {
  it("reserves inventory when available and rejects when insufficient", () => {
    const initial = createSkuInventoryState({ skuId: "sku_hot_001", onHand: 1 });
    const reserved = reserveInventory(
      initial,
      {
        checkout_intent_id: "checkout_1",
        reservation_id: "reservation_1",
        sku_id: "sku_hot_001",
        quantity: 1,
      },
      new Date("2026-04-18T00:15:00.000Z"),
    );

    expect(reserved.type).toBe("InventoryReserved");

    const afterReserve = replaySkuInventoryEvents(initial, [reserved]);
    expect(afterReserve).toMatchObject({
      reserved: 1,
      sold: 0,
      available: 0,
      aggregateVersion: 1,
    });

    const rejected = reserveInventory(
      afterReserve,
      {
        checkout_intent_id: "checkout_2",
        reservation_id: "reservation_2",
        sku_id: "sku_hot_001",
        quantity: 1,
      },
      new Date("2026-04-18T00:15:00.000Z"),
    );

    expect(rejected).toMatchObject({
      type: "InventoryReservationRejected",
      payload: {
        reason: "insufficient_inventory",
      },
    });
  });

  it("releases a reservation once and ignores duplicate release requests", () => {
    const initial = createSkuInventoryState({ skuId: "sku_hot_001", onHand: 1 });
    const reserved = reserveInventory(
      initial,
      {
        checkout_intent_id: "checkout_1",
        reservation_id: "reservation_1",
        sku_id: "sku_hot_001",
        quantity: 1,
      },
      new Date("2026-04-18T00:15:00.000Z"),
    ) as InventoryReserved;
    const afterReserve = replaySkuInventoryEvents(initial, [reserved]);

    const release = releaseInventoryReservation(afterReserve, {
      checkout_intent_id: "checkout_1",
      reservation_id: "reservation_1",
      sku_id: "sku_hot_001",
      quantity: 1,
      reason: "payment_failed",
    });

    expect(release?.type).toBe("InventoryReservationReleased");

    const afterRelease = replaySkuInventoryEvents(afterReserve, release ? [release] : []);
    expect(afterRelease).toMatchObject({
      reserved: 0,
      available: 1,
    });
    expect(
      releaseInventoryReservation(afterRelease, {
        checkout_intent_id: "checkout_1",
        reservation_id: "reservation_1",
        sku_id: "sku_hot_001",
        quantity: 1,
        reason: "payment_failed",
      }),
    ).toBeNull();
  });
});
