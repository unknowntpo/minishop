CREATE TABLE "checkout_intent_projection" (
	"checkout_intent_id" uuid PRIMARY KEY NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"last_event_id" bigint NOT NULL,
	"buyer_id" text NOT NULL,
	"status" text NOT NULL,
	"items" jsonb NOT NULL,
	"payment_id" uuid,
	"order_id" uuid,
	"rejection_reason" text,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_intent_projection_status_check" CHECK ("checkout_intent_projection"."status" in ('queued', 'reserving', 'reserved', 'pending_payment', 'confirmed', 'rejected', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "event_store" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"idempotency_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_store_event_type_check" CHECK ("event_store"."event_type" in ('CheckoutIntentCreated', 'InventoryReservationRequested', 'InventoryReserved', 'InventoryReservationRejected', 'PaymentRequested', 'PaymentSucceeded', 'PaymentFailed', 'InventoryReservationReleased', 'OrderConfirmed', 'OrderCancelled'))
);
--> statement-breakpoint
CREATE TABLE "order_projection" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"last_event_id" bigint NOT NULL,
	"checkout_intent_id" uuid NOT NULL,
	"buyer_id" text NOT NULL,
	"status" text NOT NULL,
	"payment_status" text NOT NULL,
	"items" jsonb NOT NULL,
	"total_amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_projection_status_check" CHECK ("order_projection"."status" in ('pending_payment', 'confirmed', 'cancelled')),
	CONSTRAINT "order_projection_payment_status_check" CHECK ("order_projection"."payment_status" in ('not_requested', 'requested', 'succeeded', 'failed', 'timeout')),
	CONSTRAINT "order_projection_total_amount_minor_non_negative" CHECK ("order_projection"."total_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product" (
	"product_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projection_checkpoint" (
	"projection_name" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sku" (
	"sku_id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"sku_code" text NOT NULL,
	"name" text NOT NULL,
	"price_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"seckill_candidate" boolean DEFAULT false NOT NULL,
	"seckill_enabled" boolean DEFAULT false NOT NULL,
	"seckill_stock_limit" integer,
	"seckill_default_stock" integer,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_seckill_stock_limit_non_negative" CHECK ("sku"."seckill_stock_limit" is null or "sku"."seckill_stock_limit" >= 0),
	CONSTRAINT "sku_seckill_default_stock_non_negative" CHECK ("sku"."seckill_default_stock" is null or "sku"."seckill_default_stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sku_inventory_projection" (
	"sku_id" text PRIMARY KEY NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"last_event_id" bigint NOT NULL,
	"on_hand" integer NOT NULL,
	"reserved" integer NOT NULL,
	"sold" integer NOT NULL,
	"available" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_inventory_projection_on_hand_non_negative" CHECK ("sku_inventory_projection"."on_hand" >= 0),
	CONSTRAINT "sku_inventory_projection_reserved_non_negative" CHECK ("sku_inventory_projection"."reserved" >= 0),
	CONSTRAINT "sku_inventory_projection_sold_non_negative" CHECK ("sku_inventory_projection"."sold" >= 0),
	CONSTRAINT "sku_inventory_projection_available_non_negative" CHECK ("sku_inventory_projection"."available" >= 0),
	CONSTRAINT "sku_inventory_projection_available_consistency" CHECK ("sku_inventory_projection"."available" = "sku_inventory_projection"."on_hand" - "sku_inventory_projection"."reserved" - "sku_inventory_projection"."sold")
);
--> statement-breakpoint
ALTER TABLE "sku" ADD CONSTRAINT "sku_product_id_product_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_store_event_id_unique" ON "event_store" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_store_aggregate_version_unique" ON "event_store" USING btree ("aggregate_type","aggregate_id","aggregate_version");--> statement-breakpoint
CREATE UNIQUE INDEX "event_store_idempotency_key_unique" ON "event_store" USING btree ("idempotency_key") WHERE "event_store"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "event_store_aggregate_idx" ON "event_store" USING btree ("aggregate_type","aggregate_id","aggregate_version");--> statement-breakpoint
CREATE INDEX "event_store_event_type_id_idx" ON "event_store" USING btree ("event_type","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_sku_code_unique" ON "sku" USING btree ("sku_code");
