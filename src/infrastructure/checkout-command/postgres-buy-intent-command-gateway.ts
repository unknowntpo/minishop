import type { Pool, PoolClient } from "pg";

import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type {
  BuyIntentCommandGateway,
  BuyIntentCommandStatusView,
  StagedBuyIntentCommand,
  StagedBuyIntentCommandInput,
} from "@/src/ports/buy-intent-command-gateway";
import type { TraceCarrier } from "@/src/ports/trace-carrier";

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
  traceparent: string | null;
  tracestate: string | null;
  baggage: string | null;
};

export function createPostgresBuyIntentCommandGateway(pool: Pool): BuyIntentCommandGateway {
  return {
    async readStatus(commandId) {
      const rows = await this.readStatuses([commandId]);
      return rows[0] ?? null;
    },

    async readStatuses(commandIds) {
      if (commandIds.length === 0) {
        return [];
      }

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
          where command_id = any($1::uuid[])
        `,
        [commandIds],
      );

      return result.rows.map((row) => ({
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
      }));
    },

    async stage(input) {
      const command = input.command;
      await pool.query(
        `
          insert into staged_buy_intent_command (
            command_id,
            correlation_id,
            idempotency_key,
            aggregate_type,
            aggregate_id,
            payload_json,
            metadata_json,
            traceparent,
            tracestate,
            baggage
          )
          values ($1, $2, $3, 'checkout', $4, $5::jsonb, $6::jsonb, $7, $8, $9)
        `,
        [
          command.command_id,
          command.correlation_id,
          command.idempotency_key ?? null,
          command.command_id,
          JSON.stringify(command),
          JSON.stringify(command.metadata),
          input.traceCarrier?.traceparent ?? null,
          input.traceCarrier?.tracestate ?? null,
          input.traceCarrier?.baggage ?? null,
        ],
      );
    },

    async stageBatch(inputs) {
      if (inputs.length === 0) {
        return;
      }

      await pool.query(
        `
          insert into staged_buy_intent_command (
            command_id,
            correlation_id,
            idempotency_key,
            aggregate_type,
            aggregate_id,
            payload_json,
            metadata_json,
            traceparent,
            tracestate,
            baggage
          )
          select
            entry.command_id,
            entry.correlation_id,
            entry.idempotency_key,
            'checkout',
            entry.command_id::text,
            entry.payload_json::jsonb,
            entry.metadata_json::jsonb,
            entry.traceparent,
            entry.tracestate,
            entry.baggage
          from jsonb_to_recordset($1::jsonb) as entry(
            command_id uuid,
            correlation_id uuid,
            idempotency_key text,
            payload_json jsonb,
            metadata_json jsonb,
            traceparent text,
            tracestate text,
            baggage text
          )
        `,
        [
          JSON.stringify(
            inputs.map((input) => ({
              command_id: input.command.command_id,
              correlation_id: input.command.correlation_id,
              idempotency_key: input.command.idempotency_key ?? null,
              payload_json: input.command,
              metadata_json: input.command.metadata,
              traceparent: input.traceCarrier?.traceparent ?? null,
              tracestate: input.traceCarrier?.tracestate ?? null,
              baggage: input.traceCarrier?.baggage ?? null,
            })),
          ),
        ],
      );
    },

    async ensureAcceptedBatch(commands) {
      if (commands.length === 0) {
        return;
      }

      await pool.query(
        `
          insert into command_status (
            command_id,
            correlation_id,
            idempotency_key,
            status
          )
          select
            entry.command_id,
            entry.correlation_id,
            entry.idempotency_key,
            'accepted'
          from jsonb_to_recordset($1::jsonb) as entry(
            command_id uuid,
            correlation_id uuid,
            idempotency_key text
          )
          on conflict (command_id) do nothing
        `,
        [
          JSON.stringify(
            commands.map((command) => ({
              command_id: command.commandId,
              correlation_id: command.correlationId,
              idempotency_key: command.idempotencyKey ?? null,
            })),
          ),
        ],
      );
    },

    async claimPendingBatch({ batchId, batchSize }) {
      const result = await pool.query<StagingRow>(
        `
          with next_batch as (
            select staging_id
            from staged_buy_intent_command
            where ingest_status = 'pending'
            order by received_at asc
            limit $2
            for update skip locked
          )
          update staged_buy_intent_command as staging
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
            staging.payload_json,
            staging.traceparent,
            staging.tracestate,
            staging.baggage
        `,
        [batchId, batchSize],
      );

      return result.rows.map((row) => ({
        stagingId: Number(row.staging_id),
        commandId: row.command_id,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key ?? undefined,
        payload: row.payload_json,
        traceCarrier: toTraceCarrier(row),
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

    async markProcessingBatch(commandIds) {
      if (commandIds.length === 0) {
        return;
      }

      await pool.query(
        `
          update command_status
          set
            status = case when status = 'accepted' then 'processing' else status end,
            updated_at = now()
          where command_id = any($1::uuid[])
            and status in ('accepted', 'processing')
        `,
        [commandIds],
      );
    },

    async markPublishFailed({ commandId, failureCode, failureMessage }) {
      await pool.query(
        `
          update command_status
          set
            status = 'failed',
            failure_code = $2,
            failure_message = $3,
            updated_at = now()
          where command_id = $1
            and status = 'accepted'
        `,
        [commandId, failureCode, failureMessage],
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
            update staged_buy_intent_command
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

    async markCreatedBatch(inputs) {
      if (inputs.length === 0) {
        return;
      }

      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(
          `
            with data as (
              select *
              from jsonb_to_recordset($1::jsonb) as entry(
                command_id uuid,
                checkout_intent_id uuid,
                event_id uuid,
                is_duplicate boolean
              )
            )
            update command_status as status
            set
              status = 'created',
              checkout_intent_id = data.checkout_intent_id,
              event_id = data.event_id,
              is_duplicate = data.is_duplicate,
              failure_code = null,
              failure_message = null,
              updated_at = now()
            from data
            where status.command_id = data.command_id
              and status.status in ('accepted', 'processing')
          `,
          [
            JSON.stringify(
              inputs.map((input) => ({
                command_id: input.commandId,
                checkout_intent_id: input.checkoutIntentId,
                event_id: input.eventId,
                is_duplicate: input.isDuplicate,
              })),
            ),
          ],
        );

        await client.query(
          `
            update staged_buy_intent_command
            set
              ingest_status = 'merged',
              processed_at = now(),
              last_error_code = null
            where staging_id = any($1::bigint[])
          `,
          [inputs.map((input) => input.stagingId)],
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
            update staged_buy_intent_command
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

    async markFailedBatch(inputs) {
      if (inputs.length === 0) {
        return;
      }

      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(
          `
            with data as (
              select *
              from jsonb_to_recordset($1::jsonb) as entry(
                command_id uuid,
                failure_code text,
                failure_message text
              )
            )
            update command_status as status
            set
              status = 'failed',
              failure_code = data.failure_code,
              failure_message = data.failure_message,
              updated_at = now()
            from data
            where status.command_id = data.command_id
              and status.status in ('accepted', 'processing')
          `,
          [
            JSON.stringify(
              inputs.map((input) => ({
                command_id: input.commandId,
                failure_code: input.failureCode,
                failure_message: input.failureMessage,
              })),
            ),
          ],
        );

        await client.query(
          `
            with data as (
              select *
              from jsonb_to_recordset($1::jsonb) as entry(
                staging_id bigint,
                ingest_status text,
                failure_code text
              )
            )
            update staged_buy_intent_command as staged
            set
              ingest_status = data.ingest_status,
              processed_at = now(),
              last_error_code = data.failure_code,
              retry_count = retry_count + 1
            from data
            where staged.staging_id = data.staging_id
          `,
          [
            JSON.stringify(
              inputs.map((input) => ({
                staging_id: input.stagingId,
                ingest_status: input.dlq === false ? "retry" : "dlq",
                failure_code: input.failureCode,
              })),
            ),
          ],
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
            update staged_buy_intent_command
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

    async markMergedDuplicateCommands(inputs) {
      if (inputs.length === 0) {
        return;
      }

      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(
          `
            update staged_buy_intent_command
            set
              ingest_status = 'merged',
              processed_at = now(),
              last_error_code = null
            where staging_id = any($1::bigint[])
          `,
          [inputs.map((input) => input.stagingId)],
        );

        await client.query(
          `
            update command_status
            set updated_at = now()
            where command_id = any($1::uuid[])
          `,
          [inputs.map((input) => input.commandId)],
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

function toTraceCarrier(
  row: Pick<StagingRow, "traceparent" | "tracestate" | "baggage">,
): TraceCarrier | undefined {
  if (!row.traceparent && !row.tracestate && !row.baggage) {
    return undefined;
  }

  return {
    ...(row.traceparent ? { traceparent: row.traceparent } : {}),
    ...(row.tracestate ? { tracestate: row.tracestate } : {}),
    ...(row.baggage ? { baggage: row.baggage } : {}),
  };
}

async function safeRollback(client: PoolClient) {
  try {
    await client.query("rollback");
  } catch {}
}
