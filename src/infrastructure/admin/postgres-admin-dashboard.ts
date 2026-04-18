import "server-only";

import type { Pool } from "pg";

import type {
  AdminCheckoutRow,
  AdminCheckpointRow,
  AdminDashboardRepository,
  AdminProductRow,
} from "@/src/ports/admin-dashboard-repository";

type ProductResultRow = {
  product_id: string;
  product_name: string;
  product_status: string;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  sku_status: string;
  price_amount_minor: string | number;
  currency: string;
  on_hand: number | null;
  reserved: number | null;
  sold: number | null;
  available: number | null;
  inventory_last_event_id: string | number | null;
  inventory_aggregate_version: string | number | null;
};

type CheckoutResultRow = {
  checkout_intent_id: string;
  buyer_id: string;
  status: string;
  payment_id: string | null;
  order_id: string | null;
  rejection_reason: string | null;
  cancellation_reason: string | null;
  aggregate_version: string | number;
  last_event_id: string | number;
  updated_at: Date;
};

type CheckpointResultRow = {
  projection_name: string;
  last_event_id: string | number;
  updated_at: Date;
};

export function createPostgresAdminDashboardRepository(pool: Pool): AdminDashboardRepository {
  return {
    async getDashboard() {
      const [products, checkouts, checkpoints] = await Promise.all([
        readProducts(pool),
        readCheckouts(pool),
        readCheckpoints(pool),
      ]);

      return {
        products,
        checkouts,
        checkpoints,
      };
    },
  };
}

async function readProducts(pool: Pool): Promise<AdminProductRow[]> {
  const result = await pool.query<ProductResultRow>(`
    select
      product.product_id,
      product.name as product_name,
      product.status as product_status,
      sku.sku_id,
      sku.sku_code,
      sku.name as sku_name,
      sku.status as sku_status,
      sku.price_amount_minor,
      sku.currency,
      sku_inventory_projection.on_hand,
      sku_inventory_projection.reserved,
      sku_inventory_projection.sold,
      sku_inventory_projection.available,
      sku_inventory_projection.last_event_id as inventory_last_event_id,
      sku_inventory_projection.aggregate_version as inventory_aggregate_version
    from product
    join sku on sku.product_id = product.product_id
    left join sku_inventory_projection on sku_inventory_projection.sku_id = sku.sku_id
    order by product.product_id, sku.sku_id
  `);

  return result.rows.map((row) => ({
    productId: row.product_id,
    productName: row.product_name,
    productStatus: row.product_status,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
    skuStatus: row.sku_status,
    priceAmountMinor: Number(row.price_amount_minor),
    currency: row.currency,
    onHand: row.on_hand,
    reserved: row.reserved,
    sold: row.sold,
    available: row.available,
    inventoryLastEventId:
      row.inventory_last_event_id === null ? null : Number(row.inventory_last_event_id),
    inventoryAggregateVersion:
      row.inventory_aggregate_version === null ? null : Number(row.inventory_aggregate_version),
  }));
}

async function readCheckouts(pool: Pool): Promise<AdminCheckoutRow[]> {
  const result = await pool.query<CheckoutResultRow>(`
    select
      checkout_intent_id,
      buyer_id,
      status,
      payment_id,
      order_id,
      rejection_reason,
      cancellation_reason,
      aggregate_version,
      last_event_id,
      updated_at
    from checkout_intent_projection
    order by updated_at desc
    limit 20
  `);

  return result.rows.map((row) => ({
    checkoutIntentId: row.checkout_intent_id,
    buyerId: row.buyer_id,
    status: row.status,
    paymentId: row.payment_id,
    orderId: row.order_id,
    rejectionReason: row.rejection_reason,
    cancellationReason: row.cancellation_reason,
    aggregateVersion: Number(row.aggregate_version),
    lastEventId: Number(row.last_event_id),
    updatedAt: row.updated_at.toISOString(),
  }));
}

async function readCheckpoints(pool: Pool): Promise<AdminCheckpointRow[]> {
  const result = await pool.query<CheckpointResultRow>(`
    select projection_name, last_event_id, updated_at
    from projection_checkpoint
    order by projection_name
  `);

  return result.rows.map((row) => ({
    projectionName: row.projection_name,
    lastEventId: Number(row.last_event_id),
    updatedAt: row.updated_at.toISOString(),
  }));
}
