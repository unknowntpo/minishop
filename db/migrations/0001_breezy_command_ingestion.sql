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
CREATE TABLE "staging_buy_intent_command" (
	"staging_id" bigserial PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"idempotency_key" text,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"ingest_status" text DEFAULT 'pending' NOT NULL,
	"batch_id" uuid,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "staging_buy_intent_command_ingest_status_check" CHECK ("staging_buy_intent_command"."ingest_status" in ('pending', 'claimed', 'merged', 'retry', 'dlq'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "command_status_correlation_id_unique" ON "command_status" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "command_status_status_idx" ON "command_status" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "staging_buy_intent_command_ingest_status_idx" ON "staging_buy_intent_command" USING btree ("ingest_status","received_at");--> statement-breakpoint
CREATE INDEX "staging_buy_intent_command_command_id_idx" ON "staging_buy_intent_command" USING btree ("command_id");
