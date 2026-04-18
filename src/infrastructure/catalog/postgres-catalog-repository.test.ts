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
        available: 97,
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
        available: null,
        attributes: {},
      }),
    ).toMatchObject({
      slug: "travel-cap",
      summary: "Projection-backed checkout SKU.",
      checkoutNote: "projection-backed inventory",
      available: 0,
      image: {
        alt: "Travel Cap",
      },
    });
  });
});
