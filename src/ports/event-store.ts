import type { DomainEvent } from "@/src/domain/events/domain-event";
import type { EventMetadata } from "@/src/domain/events/event-metadata";

export type AggregateType = "checkout" | "sku" | "payment" | "order";

export type EventStoreAppendInput<TEvent extends DomainEvent = DomainEvent> = {
  eventId: string;
  event: TEvent;
  aggregateType: AggregateType;
  aggregateId: string;
  aggregateVersion: number;
  metadata: EventMetadata;
  idempotencyKey?: string;
  occurredAt: Date;
};

export type StoredEvent<TEvent extends DomainEvent = DomainEvent> =
  EventStoreAppendInput<TEvent> & {
    id: number;
    wasIdempotentReplay: boolean;
  };

export type EventStore = {
  append<TEvent extends DomainEvent>(
    input: EventStoreAppendInput<TEvent>,
  ): Promise<StoredEvent<TEvent>>;
  readAggregateEvents(aggregateType: AggregateType, aggregateId: string): Promise<StoredEvent[]>;
};
