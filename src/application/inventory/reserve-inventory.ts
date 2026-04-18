import type {
  InventoryReservationRejected,
  InventoryReserved,
} from "@/src/domain/events/domain-event";
import type { EventMetadata } from "@/src/domain/events/event-metadata";
import {
  createSkuInventoryState,
  replaySkuInventoryEvents,
  reserveInventory,
} from "@/src/domain/inventory/sku-inventory-aggregate";
import type { Clock } from "@/src/ports/clock";
import type { EventStore } from "@/src/ports/event-store";
import type { IdGenerator } from "@/src/ports/id-generator";

export type ReserveInventoryInput = {
  checkoutIntentId: string;
  reservationId: string;
  skuId: string;
  quantity: number;
  onHand: number;
  metadata: EventMetadata;
  idempotencyKey?: string;
};

export type ReserveInventoryDeps = {
  eventStore: EventStore;
  idGenerator: IdGenerator;
  clock: Clock;
};

export type ReserveInventoryResult = {
  event: InventoryReserved | InventoryReservationRejected;
  aggregateVersion: number;
  eventId: string;
  idempotentReplay: boolean;
};

export async function handleReserveInventory(
  input: ReserveInventoryInput,
  deps: ReserveInventoryDeps,
): Promise<ReserveInventoryResult> {
  const priorEvents = await deps.eventStore.readAggregateEvents("sku", input.skuId);
  const state = replaySkuInventoryEvents(
    createSkuInventoryState({
      skuId: input.skuId,
      onHand: input.onHand,
    }),
    priorEvents.map((stored) => stored.event),
  );
  const event = reserveInventory(
    state,
    {
      checkout_intent_id: input.checkoutIntentId,
      reservation_id: input.reservationId,
      sku_id: input.skuId,
      quantity: input.quantity,
    },
    new Date(deps.clock.now().getTime() + 15 * 60 * 1000),
  );
  const eventId = deps.idGenerator.randomUuid();
  const stored = await deps.eventStore.append({
    eventId,
    event,
    aggregateType: "sku",
    aggregateId: input.skuId,
    aggregateVersion: state.aggregateVersion + 1,
    metadata: input.metadata,
    idempotencyKey: input.idempotencyKey,
    occurredAt: deps.clock.now(),
  });

  if (
    stored.event.type !== "InventoryReserved" &&
    stored.event.type !== "InventoryReservationRejected"
  ) {
    throw new Error("Idempotency key resolved to a non-inventory reservation event.");
  }

  return {
    event: stored.event,
    aggregateVersion: stored.aggregateVersion,
    eventId: stored.eventId,
    idempotentReplay: stored.wasIdempotentReplay,
  };
}
