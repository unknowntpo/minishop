import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { product, sku, skuInventoryProjection } from "@/db/schema";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for dev catalog seed.");
}

const catalogSeed = [
  {
    productId: "limited-runner",
    name: "Limited Runner",
    description: "One hot SKU for high-concurrency direct buy pressure.",
    skuId: "sku_hot_001",
    skuCode: "hot-001",
    priceAmountMinor: 100000,
    currency: "TWD",
    onHand: 100,
    attributes: {
      slug: "limited-runner",
      image:
        "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1400&q=80",
      image_alt: "Red running shoe",
      checkout_note: "one hot product · event-sourced checkout",
    },
  },
  {
    productId: "everyday-tee",
    name: "Everyday Tee",
    description: "A steady catalog SKU used to verify mixed-cart checkout behavior.",
    skuId: "sku_tee_001",
    skuCode: "tee-001",
    priceAmountMinor: 68000,
    currency: "TWD",
    onHand: 240,
    attributes: {
      slug: "everyday-tee",
      image:
        "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=1400&q=80",
      image_alt: "Folded neutral t-shirt",
      checkout_note: "catalog product · multi-SKU cart ready",
    },
  },
  {
    productId: "travel-cap",
    name: "Travel Cap",
    description: "A lightweight add-on SKU for cart checkout reservation progress.",
    skuId: "sku_cap_001",
    skuCode: "cap-001",
    priceAmountMinor: 42000,
    currency: "TWD",
    onHand: 160,
    attributes: {
      slug: "travel-cap",
      image:
        "https://images.unsplash.com/photo-1521369909029-2afed882baee?auto=format&fit=crop&w=1400&q=80",
      image_alt: "Casual travel cap",
      checkout_note: "add-on product · projection-backed inventory",
    },
  },
] as const;

function readOnHandOverrides() {
  const raw = process.env.SEED_DEV_CATALOG_ON_HAND_OVERRIDES?.trim();

  if (!raw) {
    return new Map<string, number>();
  }

  const overrides = new Map<string, number>();

  for (const entry of raw.split(",")) {
    const [skuIdRaw, onHandRaw] = entry.split(":").map((value) => value?.trim() ?? "");

    if (!skuIdRaw || !onHandRaw) {
      throw new Error(
        `Invalid SEED_DEV_CATALOG_ON_HAND_OVERRIDES entry "${entry}". Expected sku_id:on_hand.`,
      );
    }

    const onHand = Number.parseInt(onHandRaw, 10);

    if (!Number.isInteger(onHand) || onHand < 0) {
      throw new Error(
        `Invalid on_hand override for ${skuIdRaw}: "${onHandRaw}" must be a non-negative integer.`,
      );
    }

    overrides.set(skuIdRaw, onHand);
  }

  return overrides;
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});

const db = drizzle(pool);

async function seedDevCatalog() {
  const onHandOverrides = readOnHandOverrides();

  for (const item of catalogSeed) {
    const onHand = onHandOverrides.get(item.skuId) ?? item.onHand;

    await db
      .insert(product)
      .values({
        productId: item.productId,
        name: item.name,
        description: item.description,
        status: "active",
      })
      .onConflictDoUpdate({
        target: product.productId,
        set: {
          name: item.name,
          description: item.description,
          status: "active",
          updatedAt: new Date(),
        },
      });

    await db
      .insert(sku)
      .values({
        skuId: item.skuId,
        productId: item.productId,
        skuCode: item.skuCode,
        name: item.name,
        priceAmountMinor: item.priceAmountMinor,
        currency: item.currency,
        status: "active",
        attributes: item.attributes,
      })
      .onConflictDoUpdate({
        target: sku.skuId,
        set: {
          productId: item.productId,
          skuCode: item.skuCode,
          name: item.name,
          priceAmountMinor: item.priceAmountMinor,
          currency: item.currency,
          status: "active",
          attributes: item.attributes,
          updatedAt: new Date(),
        },
      });

    await db
      .insert(skuInventoryProjection)
      .values({
        skuId: item.skuId,
        aggregateVersion: 0,
        lastEventId: 0,
        onHand,
        reserved: 0,
        sold: 0,
        available: onHand,
      })
      .onConflictDoUpdate({
        target: skuInventoryProjection.skuId,
        set: {
          aggregateVersion: 0,
          lastEventId: 0,
          onHand,
          reserved: 0,
          sold: 0,
          available: onHand,
          updatedAt: new Date(),
        },
      });
  }
}

async function main() {
  await seedDevCatalog();
  console.log(`Seeded ${catalogSeed.length} development catalog products.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
