import { describe, expect, it } from "vitest";

import { mapProductRow } from "@/src/infrastructure/catalog/catalog-row-mapper";

describe("mapProductRow", () => {
  it("maps catalog rows with projection-backed inventory into product view data", () => {
    expect(
      mapProductRow({
        product_id: "limited-runner",
        product_name: "Limited Runner",
        description: "One hot SKU.",
        sku_id: "sku_hot_001",
        sku_code: "hot-001",
        price_amount_minor: "100000",
        currency: "TWD",
        seckill_candidate: true,
        seckill_enabled: true,
        seckill_stock_limit: 50,
        seckill_default_stock: 80,
        on_hand: 100,
        reserved: 2,
        sold: 1,
        available: 97,
        inventory_aggregate_version: "3",
        inventory_last_event_id: "42",
        inventory_updated_at: new Date("2026-04-18T00:00:00.000Z"),
        attributes: {
          slug: "limited-runner",
          image:
            "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1400&q=80",
          image_alt: "Red running shoe",
          checkout_note: "one hot product · event-sourced checkout",
        },
      }),
    ).toEqual({
      slug: "limited-runner",
      name: "Limited Runner",
      skuId: "sku_hot_001",
      skuCode: "hot-001",
      summary: "One hot SKU.",
      checkoutNote: "one hot product · event-sourced checkout",
      priceAmountMinor: 100000,
      currency: "TWD",
      available: 97,
      seckill: {
        candidate: true,
        enabled: true,
        stockLimit: 50,
        defaultStock: 80,
      },
      inventory: {
        onHand: 100,
        reserved: 2,
        sold: 1,
        available: 97,
        aggregateVersion: 3,
        lastEventId: 42,
        updatedAt: "2026-04-18T00:00:00.000Z",
        projectionLagMs: expect.any(Number),
      },
      image: {
        src: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1400&q=80",
        alt: "Red running shoe",
      },
    });
  });

  it("falls back to safe display values when optional attributes or projection rows are absent", () => {
    expect(
      mapProductRow({
        product_id: "travel-cap",
        product_name: "Travel Cap",
        description: null,
        sku_id: "sku_cap_001",
        sku_code: "cap-001",
        price_amount_minor: 42000,
        currency: "TWD",
        seckill_candidate: false,
        seckill_enabled: false,
        seckill_stock_limit: null,
        seckill_default_stock: null,
        on_hand: null,
        reserved: null,
        sold: null,
        available: null,
        inventory_aggregate_version: null,
        inventory_last_event_id: null,
        inventory_updated_at: null,
        attributes: {},
      }),
    ).toMatchObject({
      slug: "travel-cap",
      summary: "Projection-backed checkout SKU.",
      checkoutNote: "projection-backed inventory",
      available: 0,
      inventory: {
        onHand: 0,
        reserved: 0,
        sold: 0,
        available: 0,
        aggregateVersion: 0,
        lastEventId: 0,
        updatedAt: null,
        projectionLagMs: null,
      },
      seckill: {
        candidate: false,
        enabled: false,
        stockLimit: null,
        defaultStock: null,
      },
      image: {
        alt: "Travel Cap",
      },
    });
  });
});
