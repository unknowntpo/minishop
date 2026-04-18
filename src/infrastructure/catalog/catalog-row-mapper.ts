import type { Product } from "@/src/domain/catalog/product";

export type CatalogProductRow = {
  product_id: string;
  product_name: string;
  description: string | null;
  sku_id: string;
  sku_code: string;
  price_amount_minor: string | number;
  currency: string;
  on_hand: number | null;
  reserved: number | null;
  sold: number | null;
  available: number | null;
  inventory_aggregate_version: string | number | null;
  inventory_last_event_id: string | number | null;
  inventory_updated_at: Date | null;
  attributes: unknown;
};

export function mapProductRow(row: CatalogProductRow): Product {
  const attributes = isRecord(row.attributes) ? row.attributes : {};
  const slug = stringAttribute(attributes, "slug") ?? row.product_id;
  const imageSrc = stringAttribute(attributes, "image") ?? fallbackImageUrl;
  const imageAlt = stringAttribute(attributes, "image_alt") ?? row.product_name;

  return {
    slug,
    name: row.product_name,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    summary: row.description ?? "Projection-backed checkout SKU.",
    checkoutNote: stringAttribute(attributes, "checkout_note") ?? "projection-backed inventory",
    priceAmountMinor: Number(row.price_amount_minor),
    currency: row.currency,
    available: row.available ?? 0,
    inventory: {
      onHand: row.on_hand ?? 0,
      reserved: row.reserved ?? 0,
      sold: row.sold ?? 0,
      available: row.available ?? 0,
      aggregateVersion:
        row.inventory_aggregate_version === null ? 0 : Number(row.inventory_aggregate_version),
      lastEventId: row.inventory_last_event_id === null ? 0 : Number(row.inventory_last_event_id),
      updatedAt: row.inventory_updated_at?.toISOString() ?? null,
      projectionLagMs: row.inventory_updated_at
        ? Date.now() - row.inventory_updated_at.getTime()
        : null,
    },
    image: {
      src: imageSrc,
      alt: imageAlt,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAttribute(attributes: Record<string, unknown>, key: string) {
  const value = attributes[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const fallbackImageUrl =
  "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=1400&q=80";
