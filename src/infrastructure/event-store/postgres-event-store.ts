import "server-only";

import type { Pool } from "pg";

import { type DomainEvent, isDomainEvent } from "@/src/domain/events/domain-event";
import { isEventMetadata } from "@/src/domain/events/event-metadata";
import { isStableTextIdentifier, isUuid } from "@/src/domain/schema-rules";
import type { EventStore, EventStoreAppendInput, StoredEvent } from "@/src/ports/event-store";

type EventStoreRow = {
  id: string | number;
  event_id: string;
  event_type: DomainEvent["type"];
  event_version: number;
  aggregate_type: EventStoreAppendInput["aggregateType"];
  aggregate_id: string;
  aggregate_version: string | number;
  payload: DomainEvent["payload"];
  metadata: EventStoreAppendInput["metadata"];
  idempotency_key: string | null;
  occurred_at: Date;
};

export function createPostgresEventStore(pool: Pool): EventStore {
  return {
    async append<TEvent extends DomainEvent>(
      input: EventStoreAppendInput<TEvent>,
    ): Promise<StoredEvent<TEvent>> {
      if (!isDomainEvent(input.event)) {
        throw new Error("Invalid event payload.");
      }
      if (!isUuid(input.eventId)) {
        throw new Error("event_id must be a UUID.");
      }
      if (!isValidAggregateId(input.aggregateType, input.aggregateId)) {
        throw new Error("aggregate_id does not match aggregate_type schema rule.");
      }
      if (!isEventMetadata(input.metadata)) {
        throw new Error("metadata must match event metadata schema rule.");
      }

      const inserted = await pool.query<EventStoreRow>(
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
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
          on conflict (idempotency_key)
            where idempotency_key is not null
            do nothing
          returning *
        `,
        [
          input.eventId,
          input.event.type,
          input.event.version,
          input.aggregateType,
          input.aggregateId,
          input.aggregateVersion,
          JSON.stringify(input.event.payload),
          JSON.stringify(input.metadata),
          input.idempotencyKey ?? null,
          input.occurredAt,
        ],
      );

      const insertedRow = inserted.rows[0];

      if (insertedRow) {
        return rowToStoredEvent(insertedRow, false);
      }

      if (!input.idempotencyKey) {
        throw new Error("Event append failed without an idempotency replay path.");
      }

      const existing = await pool.query<EventStoreRow>(
        `
          select *
          from event_store
          where idempotency_key = $1
          limit 1
        `,
        [input.idempotencyKey],
      );

      const existingRow = existing.rows[0];

      if (!existingRow) {
        throw new Error("Event append conflicted, but no idempotent event could be loaded.");
      }

      return rowToStoredEvent(existingRow, true);
    },

    async readAggregateEvents(aggregateType, aggregateId) {
      const result = await pool.query<EventStoreRow>(
        `
          select *
          from event_store
          where aggregate_type = $1
            and aggregate_id = $2
          order by aggregate_version asc
        `,
        [aggregateType, aggregateId],
      );

      return result.rows.map((row) => rowToStoredEvent(row, false));
    },
  };
}

function isValidAggregateId(
  aggregateType: EventStoreAppendInput["aggregateType"],
  aggregateId: string,
) {
  if (aggregateType === "sku") {
    return isStableTextIdentifier(aggregateId);
  }

  return isUuid(aggregateId);
}

function rowToStoredEvent<TEvent extends DomainEvent>(
  row: EventStoreRow,
  wasIdempotentReplay: boolean,
): StoredEvent<TEvent> {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    event: {
      type: row.event_type,
      version: row.event_version,
      payload: row.payload,
    } as TEvent,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: Number(row.aggregate_version),
    metadata: row.metadata,
    idempotencyKey: row.idempotency_key ?? undefined,
    occurredAt: row.occurred_at,
    wasIdempotentReplay,
  };
}
