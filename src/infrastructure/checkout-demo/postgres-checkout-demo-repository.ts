import type { Pool } from "pg";

import { assertCheckoutItems } from "@/src/domain/checkout/item";
import type {
  CheckoutDemoRepository,
  DemoCheckoutIntent,
} from "@/src/ports/checkout-demo-repository";

type CheckoutIntentRow = {
  checkout_intent_id: string;
  buyer_id: string;
  items: unknown;
};

type InventoryRow = {
  on_hand: number;
};

type QueuedCheckoutIntentRow = {
  checkout_intent_id: string;
};

export function createPostgresCheckoutDemoRepository(pool: Pool): CheckoutDemoRepository {
  return {
    async findCheckoutIntent(checkoutIntentId) {
      const result = await pool.query<CheckoutIntentRow>(
        `
          select checkout_intent_id, buyer_id, items
          from checkout_intent_projection
          where checkout_intent_id = $1
          limit 1
        `,
        [checkoutIntentId],
      );
      const row = result.rows[0];

      if (!row) {
        return null;
      }

      assertCheckoutItems(row.items);

      return {
        checkoutIntentId: row.checkout_intent_id,
        buyerId: row.buyer_id,
        items: row.items,
      } satisfies DemoCheckoutIntent;
    },

    async getSkuOnHand(skuId) {
      const result = await pool.query<InventoryRow>(
        `
          select on_hand
          from sku_inventory_projection
          where sku_id = $1
          limit 1
        `,
        [skuId],
      );

      return result.rows[0]?.on_hand ?? null;
    },

    async listQueuedCheckoutIntentIds(limit) {
      const result = await pool.query<QueuedCheckoutIntentRow>(
        `
          select checkout_intent_id
          from checkout_intent_projection
          where status = 'queued'
          order by updated_at asc, checkout_intent_id asc
          limit $1
        `,
        [limit],
      );

      return result.rows.map((row) => row.checkout_intent_id);
    },
  };
}
