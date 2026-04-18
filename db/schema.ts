import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { checkoutStatuses } from "@/src/domain/checkout/status";
import { eventTypes } from "@/src/domain/events/event-type";
import { orderStatuses } from "@/src/domain/order/status";
import { paymentStatuses } from "@/src/domain/payment/status";

function sqlStringList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

export const eventStore = pgTable(
  "event_store",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
    payload: jsonb("payload").notNull(),
    metadata: jsonb("metadata").notNull(),
    idempotencyKey: text("idempotency_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("event_store_event_id_unique").on(table.eventId),
    uniqueIndex("event_store_aggregate_version_unique").on(
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    uniqueIndex("event_store_idempotency_key_unique")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("event_store_aggregate_idx").on(
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    index("event_store_event_type_id_idx").on(table.eventType, table.id),
    check(
      "event_store_event_type_check",
      sql`${table.eventType} in (${sqlStringList(eventTypes)})`,
    ),
  ],
);

export const product = pgTable("product", {
  productId: text("product_id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sku = pgTable(
  "sku",
  {
    skuId: text("sku_id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => product.productId),
    skuCode: text("sku_code").notNull(),
    name: text("name").notNull(),
    priceAmountMinor: bigint("price_amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    attributes: jsonb("attributes").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("sku_sku_code_unique").on(table.skuCode)],
);

export const checkoutIntentProjection = pgTable(
  "checkout_intent_projection",
  {
    checkoutIntentId: uuid("checkout_intent_id").primaryKey(),
    aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
    lastEventId: bigint("last_event_id", { mode: "number" }).notNull(),
    buyerId: text("buyer_id").notNull(),
    status: text("status").notNull(),
    items: jsonb("items").notNull(),
    paymentId: uuid("payment_id"),
    orderId: uuid("order_id"),
    rejectionReason: text("rejection_reason"),
    cancellationReason: text("cancellation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "checkout_intent_projection_status_check",
      sql`${table.status} in (${sqlStringList(checkoutStatuses)})`,
    ),
  ],
);

export const skuInventoryProjection = pgTable(
  "sku_inventory_projection",
  {
    skuId: text("sku_id").primaryKey(),
    aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
    lastEventId: bigint("last_event_id", { mode: "number" }).notNull(),
    onHand: integer("on_hand").notNull(),
    reserved: integer("reserved").notNull(),
    sold: integer("sold").notNull(),
    available: integer("available").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("sku_inventory_projection_on_hand_non_negative", sql`${table.onHand} >= 0`),
    check("sku_inventory_projection_reserved_non_negative", sql`${table.reserved} >= 0`),
    check("sku_inventory_projection_sold_non_negative", sql`${table.sold} >= 0`),
    check("sku_inventory_projection_available_non_negative", sql`${table.available} >= 0`),
    check(
      "sku_inventory_projection_available_consistency",
      sql`${table.available} = ${table.onHand} - ${table.reserved} - ${table.sold}`,
    ),
  ],
);

export const orderProjection = pgTable(
  "order_projection",
  {
    orderId: uuid("order_id").primaryKey(),
    aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
    lastEventId: bigint("last_event_id", { mode: "number" }).notNull(),
    checkoutIntentId: uuid("checkout_intent_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    status: text("status").notNull(),
    paymentStatus: text("payment_status").notNull(),
    items: jsonb("items").notNull(),
    totalAmountMinor: bigint("total_amount_minor", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "order_projection_status_check",
      sql`${table.status} in (${sqlStringList(orderStatuses)})`,
    ),
    check(
      "order_projection_payment_status_check",
      sql`${table.paymentStatus} in (${sqlStringList(paymentStatuses)})`,
    ),
    check("order_projection_total_amount_minor_non_negative", sql`${table.totalAmountMinor} >= 0`),
  ],
);

export const projectionCheckpoint = pgTable("projection_checkpoint", {
  projectionName: text("projection_name").primaryKey(),
  lastEventId: bigint("last_event_id", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
