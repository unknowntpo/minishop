import "server-only";

import type { Pool, PoolClient } from "pg";

import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { BuyIntentCommandGateway, BuyIntentCommandStatusView, StagedBuyIntentCommand } from "@/src/ports/buy-intent-command-gateway";

type CommandStatusRow = {
  command_id: string;
  correlation_id: string;
  status: BuyIntentCommandStatusView["status"];
  checkout_intent_id: string | null;
  event_id: string | null;
  is_duplicate: boolean;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type StagingRow = {
  staging_id: string | number;
  command_id: string;
  correlation_id: string;
  idempotency_key: string | null;
  payload_json: BuyIntentCommand;
};

export function createPostgresBuyIntentCommandGateway(pool: Pool): BuyIntentCommandGateway {
  return {
    async accept(command) {
      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(
          `
            insert into command_status (
              command_id,
              correlation_id,
              idempotency_key,
              status
            )
            values ($1, $2, $3, 'accepted')
          `,
          [command.command_id, command.correlation_id, command.idempotency_key ?? null],
        );

        await client.query(
          `
            insert into staging_buy_intent_command (
              command_id,
              correlation_id,
              idempotency_key,
              aggregate_type,
              aggregate_id,
              payload_json,
              metadata_json
            )
            values ($1, $2, $3, 'checkout', $4, $5::jsonb, $6::jsonb)
          `,
          [
            command.command_id,
            command.correlation_id,
            command.idempotency_key ?? null,
            command.command_id,
            JSON.stringify(command),
            JSON.stringify(command.metadata),
          ],
        );

        await client.query("commit");
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }

      return {
        commandId: command.command_id,
        correlationId: command.correlation_id,
        status: "accepted" as const,
      };
    },

    async readStatus(commandId) {
      const result = await pool.query<CommandStatusRow>(
        `
          select
            command_id,
            correlation_id,
            status,
            checkout_intent_id,
            event_id,
            is_duplicate,
            failure_code,
            failure_message,
            created_at,
            updated_at
          from command_status
          where command_id = $1
          limit 1
        `,
        [commandId],
      );

      const row = result.rows[0];

      if (!row) {
        return null;
      }

      return {
        commandId: row.command_id,
        correlationId: row.correlation_id,
        status: row.status,
        checkoutIntentId: row.checkout_intent_id,
        eventId: row.event_id,
        isDuplicate: row.is_duplicate,
        failureCode: row.failure_code,
        failureMessage: row.failure_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    async claimPendingBatch({ batchId, batchSize }) {
      const result = await pool.query<StagingRow>(
        `
          with next_batch as (
            select staging_id
            from staging_buy_intent_command
            where ingest_status = 'pending'
            order by received_at asc
            limit $2
            for update skip locked
          )
          update staging_buy_intent_command as staging
          set
            ingest_status = 'claimed',
            batch_id = $1,
            claimed_at = now()
          from next_batch
          where staging.staging_id = next_batch.staging_id
          returning
            staging.staging_id,
            staging.command_id,
            staging.correlation_id,
            staging.idempotency_key,
            staging.payload_json
        `,
        [batchId, batchSize],
      );

      return result.rows.map((row) => ({
        stagingId: Number(row.staging_id),
        commandId: row.command_id,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key ?? undefined,
        payload: row.payload_json,
      }));
    },

    async markProcessing(commandId) {
      await pool.query(
        `
          update command_status
          set
            status = case when status = 'accepted' then 'processing' else status end,
            updated_at = now()
          where command_id = $1
            and status in ('accepted', 'processing')
        `,
        [commandId],
      );
    },

    async markCreated({ stagingId, commandId, checkoutIntentId, eventId, isDuplicate }) {
      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(
          `
            update command_status
            set
              status = 'created',
              checkout_intent_id = $2,
              event_id = $3,
              is_duplicate = $4,
              failure_code = null,
              failure_message = null,
              updated_at = now()
            where command_id = $1
              and status in ('accepted', 'processing')
          `,
          [commandId, checkoutIntentId, eventId, isDuplicate],
        );

        await client.query(
          `
            update staging_buy_intent_command
            set
              ingest_status = 'merged',
              processed_at = now(),
              last_error_code = null
            where staging_id = $1
          `,
          [stagingId],
        );

        await client.query("commit");
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async markFailed({ stagingId, commandId, failureCode, failureMessage, dlq = true }) {
      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(
          `
            update command_status
            set
              status = 'failed',
              failure_code = $2,
              failure_message = $3,
              updated_at = now()
            where command_id = $1
              and status in ('accepted', 'processing')
          `,
          [commandId, failureCode, failureMessage],
        );

        await client.query(
          `
            update staging_buy_intent_command
            set
              ingest_status = $2,
              processed_at = now(),
              last_error_code = $3,
              retry_count = retry_count + 1
            where staging_id = $1
          `,
          [stagingId, dlq ? "dlq" : "retry", failureCode],
        );

        await client.query("commit");
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async markMergedDuplicateCommand({ stagingId, commandId }) {
      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(
          `
            update staging_buy_intent_command
            set
              ingest_status = 'merged',
              processed_at = now(),
              last_error_code = null
            where staging_id = $1
          `,
          [stagingId],
        );

        await client.query(
          `
            update command_status
            set updated_at = now()
            where command_id = $1
          `,
          [commandId],
        );

        await client.query("commit");
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function safeRollback(client: PoolClient) {
  try {
    await client.query("rollback");
  } catch {}
}
