CREATE TABLE "command_status" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"correlation_id" uuid NOT NULL,
	"idempotency_key" text,
	"status" text NOT NULL,
	"checkout_intent_id" uuid,
	"event_id" uuid,
	"is_duplicate" boolean DEFAULT false NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_status_status_check" CHECK ("command_status"."status" in ('accepted', 'processing', 'created', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "staged_buy_intent_command" (
	"staging_id" bigserial PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"idempotency_key" text,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"traceparent" text,
	"tracestate" text,
	"baggage" text,
	"ingest_status" text DEFAULT 'pending' NOT NULL,
	"batch_id" uuid,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "staged_buy_intent_command_ingest_status_check" CHECK ("staged_buy_intent_command"."ingest_status" in ('pending', 'claimed', 'merged', 'retry', 'dlq'))
);
--> statement-breakpoint
CREATE TABLE "seckill_command_result" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"correlation_id" uuid NOT NULL,
	"sku_id" text NOT NULL,
	"checkout_intent_id" uuid,
	"status" text NOT NULL,
	"requested_quantity" integer NOT NULL,
	"seckill_stock_limit" integer NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seckill_command_result_status_check" CHECK ("seckill_command_result"."status" in ('reserved', 'rejected')),
	CONSTRAINT "seckill_command_result_requested_quantity_positive" CHECK ("seckill_command_result"."requested_quantity" > 0),
	CONSTRAINT "seckill_command_result_stock_limit_non_negative" CHECK ("seckill_command_result"."seckill_stock_limit" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "command_status_correlation_id_unique" ON "command_status" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "command_status_status_idx" ON "command_status" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "staged_buy_intent_command_ingest_status_idx" ON "staged_buy_intent_command" USING btree ("ingest_status","received_at");--> statement-breakpoint
CREATE INDEX "staged_buy_intent_command_command_id_idx" ON "staged_buy_intent_command" USING btree ("command_id");
--> statement-breakpoint
CREATE INDEX "seckill_command_result_sku_idx" ON "seckill_command_result" USING btree ("sku_id","updated_at");
