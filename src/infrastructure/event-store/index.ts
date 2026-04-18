import { getPool } from "@/db/client";
import { createPostgresEventStore } from "@/src/infrastructure/event-store/postgres-event-store";
import type { EventStore } from "@/src/ports/event-store";

export const postgresEventStore: EventStore = {
  append(input) {
    return createPostgresEventStore(getPool()).append(input);
  },
  readAggregateEvents(aggregateType, aggregateId) {
    return createPostgresEventStore(getPool()).readAggregateEvents(aggregateType, aggregateId);
  },
};
