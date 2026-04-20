import type { Pool, PoolClient } from "pg";
import { applyProjectionEvent } from "@/src/infrastructure/projections/postgres-projection-writer";
import type { StoredEvent } from "@/src/ports/event-store";
import type {
  ProjectionBatchResult,
  ProjectionRepository,
} from "@/src/ports/projection-repository";

type EventStoreRow = {
  id: string | number;
  event_id: string;
  event_type: StoredEvent["event"]["type"];
  event_version: number;
  aggregate_type: StoredEvent["aggregateType"];
  aggregate_id: string;
  aggregate_version: string | number;
  payload: StoredEvent["event"]["payload"];
  metadata: StoredEvent["metadata"];
  idempotency_key: string | null;
  occurred_at: Date;
};

const projectionLockKey = 42_420_001;

export function createPostgresProjectionRepository(pool: Pool): ProjectionRepository {
  return {
    async processBatchWithLock({ projectionName, batchSize }) {
      const client = await pool.connect();

      try {
        await client.query("begin");

        const lock = await client.query<{ locked: boolean }>(
          "select pg_try_advisory_xact_lock($1) as locked",
          [projectionLockKey],
        );

        if (!lock.rows[0]?.locked) {
          await client.query("rollback");
          return {
            locked: false,
            processedEvents: 0,
            lastEventId: await readCheckpointOutsideTransaction(client, projectionName),
          };
        }

        const checkpoint = await readCheckpoint(client, projectionName);
        const events = await readEventsAfter(client, checkpoint, batchSize);
        let lastEventId = checkpoint;

        for (const event of events) {
          await applyProjectionEvent(client, event);
          lastEventId = event.id;
        }

        await upsertCheckpoint(client, projectionName, lastEventId);
        await client.query("commit");

        return {
          locked: true,
          processedEvents: events.length,
          lastEventId,
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function readCheckpoint(client: PoolClient, projectionName: string) {
  const result = await client.query<{ last_event_id: string | number }>(
    `
      select last_event_id
      from projection_checkpoint
      where projection_name = $1
      for update
    `,
    [projectionName],
  );

  return Number(result.rows[0]?.last_event_id ?? 0);
}

async function readCheckpointOutsideTransaction(client: PoolClient, projectionName: string) {
  const result = await client.query<{ last_event_id: string | number }>(
    `
      select last_event_id
      from projection_checkpoint
      where projection_name = $1
    `,
    [projectionName],
  );

  return Number(result.rows[0]?.last_event_id ?? 0);
}

async function readEventsAfter(client: PoolClient, lastEventId: number, limit: number) {
  const result = await client.query<EventStoreRow>(
    `
      select *
      from event_store
      where id > $1
      order by id asc
      limit $2
    `,
    [lastEventId, limit],
  );

  return result.rows.map(rowToStoredEvent);
}

async function upsertCheckpoint(client: PoolClient, projectionName: string, lastEventId: number) {
  await client.query(
    `
      insert into projection_checkpoint (projection_name, last_event_id, updated_at)
      values ($1, $2, now())
      on conflict (projection_name)
      do update set
        last_event_id = excluded.last_event_id,
        updated_at = now()
    `,
    [projectionName, lastEventId],
  );
}

function rowToStoredEvent(row: EventStoreRow): StoredEvent {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    event: {
      type: row.event_type,
      version: row.event_version,
      payload: row.payload,
    } as StoredEvent["event"],
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: Number(row.aggregate_version),
    metadata: row.metadata,
    idempotencyKey: row.idempotency_key ?? undefined,
    occurredAt: row.occurred_at,
    wasIdempotentReplay: false,
  };
}
