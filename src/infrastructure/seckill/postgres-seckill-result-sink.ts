import type { Pool } from "pg";

import type {
  SeckillCommandOutcome,
  SeckillCommandResult,
} from "@/src/domain/seckill/seckill-command-outcome";

export function createPostgresSeckillResultSink(pool: Pool) {
  return {
    async persistOutcome(outcome: SeckillCommandOutcome) {
      const { request, result } = outcome;
      const client = await pool.connect();

      try {
        await client.query("begin");

        if (result.status === "reserved") {
          await client.query(
            `
              insert into event_store (
                event_id,
                event_type,
                event_version,
                aggregate_type,
                aggregate_id,
                aggregate_version,
                payload,
                metadata,
                idempotency_key,
                occurred_at
              )
              values ($1, 'CheckoutIntentCreated', 1, 'checkout', $2, 1, $3::jsonb, $4::jsonb, $5, $6)
              on conflict (idempotency_key)
                where idempotency_key is not null
                do nothing
            `,
            [
              result.eventId,
              result.checkoutIntentId,
              JSON.stringify({
                checkout_intent_id: result.checkoutIntentId,
                buyer_id: request.buyerId,
                items: request.items,
                ...(request.idempotencyKey
                  ? { idempotency_key: request.idempotencyKey }
                  : {}),
              }),
              JSON.stringify({
                request_id: request.metadata.request_id,
                trace_id: request.metadata.trace_id,
                source: request.metadata.source,
                actor_id: request.metadata.actor_id,
              }),
              request.idempotencyKey ?? null,
              outcome.processedAt,
            ],
          );

          await client.query(
            `
              insert into command_status (
                command_id,
                correlation_id,
                idempotency_key,
                status,
                checkout_intent_id,
                event_id,
                is_duplicate,
                failure_code,
                failure_message
              )
              values ($1, $2, $3, 'created', $4, $5, $6, null, null)
              on conflict (command_id)
              do update set
                correlation_id = excluded.correlation_id,
                idempotency_key = excluded.idempotency_key,
                status = excluded.status,
                checkout_intent_id = excluded.checkout_intent_id,
                event_id = excluded.event_id,
                is_duplicate = excluded.is_duplicate,
                failure_code = null,
                failure_message = null,
                updated_at = now()
            `,
            [
              result.commandId,
              result.correlationId,
              request.idempotencyKey ?? null,
              result.checkoutIntentId,
              result.eventId,
              result.duplicate,
            ],
          );
        } else {
          await client.query(
            `
              insert into command_status (
                command_id,
                correlation_id,
                idempotency_key,
                status,
                is_duplicate,
                failure_code,
                failure_message
              )
              values ($1, $2, $3, 'failed', $4, 'seckill_out_of_stock', $5)
              on conflict (command_id)
              do update set
                correlation_id = excluded.correlation_id,
                idempotency_key = excluded.idempotency_key,
                status = excluded.status,
                is_duplicate = excluded.is_duplicate,
                failure_code = excluded.failure_code,
                failure_message = excluded.failure_message,
                updated_at = now()
            `,
            [
              result.commandId,
              result.correlationId,
              request.idempotencyKey ?? null,
              result.duplicate,
              result.failureReason ?? "seckill_out_of_stock",
            ],
          );
        }

        await upsertSeckillCommandResult(client, result);

        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function upsertSeckillCommandResult(
  client: { query: Pool["query"] },
  result: SeckillCommandResult,
) {
  await client.query(
    `
      insert into seckill_command_result (
        command_id,
        correlation_id,
        sku_id,
        checkout_intent_id,
        status,
        requested_quantity,
        seckill_stock_limit,
        failure_reason
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (command_id)
      do update set
        correlation_id = excluded.correlation_id,
        sku_id = excluded.sku_id,
        checkout_intent_id = excluded.checkout_intent_id,
        status = excluded.status,
        requested_quantity = excluded.requested_quantity,
        seckill_stock_limit = excluded.seckill_stock_limit,
        failure_reason = excluded.failure_reason,
        updated_at = now()
    `,
    [
      result.commandId,
      result.correlationId,
      result.skuId,
      result.checkoutIntentId,
      result.status,
      result.requestedQuantity,
      result.seckillStockLimit,
      result.failureReason,
    ],
  );
}
