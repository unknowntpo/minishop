import { describe, expect, it } from "vitest";

import { handleReserveInventory } from "@/src/application/inventory/reserve-inventory";
import type { DomainEvent } from "@/src/domain/events/domain-event";
import type { Clock } from "@/src/ports/clock";
import type { EventStore, EventStoreAppendInput, StoredEvent } from "@/src/ports/event-store";
import type { IdGenerator } from "@/src/ports/id-generator";

describe("handleReserveInventory", () => {
  it("uses SKU as the aggregate and appends reservation outcomes in aggregate order", async () => {
    const eventStore = new InMemoryEventStore();

    const first = await handleReserveInventory(validInput("checkout_1", "reservation_1"), {
      eventStore,
      idGenerator: new SequenceIdGenerator(["event_1"]),
      clock: fixedClock,
    });
    const second = await handleReserveInventory(validInput("checkout_2", "reservation_2"), {
      eventStore,
      idGenerator: new SequenceIdGenerator(["event_2"]),
      clock: fixedClock,
    });

    expect(first.event.type).toBe("InventoryReserved");
    expect(first.aggregateVersion).toBe(1);
    expect(second.event).toMatchObject({
      type: "InventoryReservationRejected",
      payload: {
        reason: "insufficient_inventory",
      },
    });
    expect(second.aggregateVersion).toBe(2);
    expect(eventStore.persistedEvents.map((event) => event.aggregateId)).toEqual([
      "sku_hot_001",
      "sku_hot_001",
    ]);
  });
});

function validInput(checkoutIntentId: string, reservationId: string) {
  return {
    checkoutIntentId,
    reservationId,
    skuId: "sku_hot_001",
    quantity: 1,
    onHand: 1,
    metadata: {
      request_id: `req_${reservationId}`,
      trace_id: `trace_${reservationId}`,
      source: "worker" as const,
      actor_id: "projection-worker",
    },
  };
}

const fixedClock: Clock = {
  now() {
    return new Date("2026-04-18T00:00:00.000Z");
  },
};

class SequenceIdGenerator implements IdGenerator {
  private nextIndex = 0;

  constructor(private readonly values: string[]) {}

  randomUuid() {
    const value = this.values[this.nextIndex];
    this.nextIndex += 1;

    if (!value) {
      throw new Error("No id left in test sequence.");
    }

    return value;
  }
}

class InMemoryEventStore implements EventStore {
  readonly persistedEvents: StoredEvent[] = [];

  async append<TEvent extends DomainEvent>(
    input: EventStoreAppendInput<TEvent>,
  ): Promise<StoredEvent<TEvent>> {
    const stored: StoredEvent<TEvent> = {
      ...input,
      id: this.persistedEvents.length + 1,
      wasIdempotentReplay: false,
    };

    this.persistedEvents.push(stored);
    return stored;
  }

  async readAggregateEvents(
    aggregateType: "checkout" | "sku" | "payment" | "order",
    aggregateId: string,
  ) {
    return this.persistedEvents.filter(
      (event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId,
    );
  }
}
