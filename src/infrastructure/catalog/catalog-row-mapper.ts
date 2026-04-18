import type { Product } from "@/src/domain/catalog/product";

export type CatalogProductRow = {
  product_id: string;
  product_name: string;
  description: string | null;
  sku_id: string;
  sku_code: string;
  price_amount_minor: string | number;
  currency: string;
  available: number | null;
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
