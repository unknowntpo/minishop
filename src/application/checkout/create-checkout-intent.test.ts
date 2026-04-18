import { describe, expect, it } from "vitest";

import { createCheckoutIntent } from "@/src/application/checkout/create-checkout-intent";
import type { DomainEvent } from "@/src/domain/events/domain-event";
import type { Clock } from "@/src/ports/clock";
import type { EventStore, EventStoreAppendInput, StoredEvent } from "@/src/ports/event-store";
import type { IdGenerator } from "@/src/ports/id-generator";

describe("createCheckoutIntent", () => {
  it("appends CheckoutIntentCreated on the checkout aggregate without touching SKU inventory", async () => {
    const eventStore = new InMemoryEventStore();
    const result = await createCheckoutIntent(validCommand(), {
      eventStore,
      idGenerator: new SequenceIdGenerator(["checkout_1", "event_1"]),
      clock: fixedClock,
    });

    expect(result).toEqual({
      checkoutIntentId: "checkout_1",
      eventId: "event_1",
      status: "queued",
      idempotentReplay: false,
    });

    expect(eventStore.appends).toHaveLength(1);
    expect(eventStore.appends[0]).toMatchObject({
      aggregateType: "checkout",
      aggregateId: "checkout_1",
      aggregateVersion: 1,
      idempotencyKey: "idem_1",
    });
    expect(eventStore.appends[0]?.event).toMatchObject({
      type: "CheckoutIntentCreated",
      version: 1,
    });
  });

  it("returns the original checkout intent when idempotency key is replayed", async () => {
    const eventStore = new InMemoryEventStore();
    const command = validCommand();

    const first = await createCheckoutIntent(command, {
      eventStore,
      idGenerator: new SequenceIdGenerator(["checkout_1", "event_1"]),
      clock: fixedClock,
    });

    const second = await createCheckoutIntent(command, {
      eventStore,
      idGenerator: new SequenceIdGenerator(["checkout_2", "event_2"]),
      clock: fixedClock,
    });

    expect(first.checkoutIntentId).toBe("checkout_1");
    expect(second).toEqual({
      checkoutIntentId: "checkout_1",
      eventId: "event_1",
      status: "queued",
      idempotentReplay: true,
    });
    expect(eventStore.persistedEvents).toHaveLength(1);
  });
});

function validCommand() {
  return {
    buyer_id: "buyer_1",
    idempotency_key: "idem_1",
    items: [
      {
        sku_id: "sku_hot_001",
        quantity: 1,
        unit_price_amount_minor: 100000,
        currency: "TWD",
      },
    ],
    metadata: {
      request_id: "req_1",
      trace_id: "trace_1",
      source: "web" as const,
      actor_id: "buyer_1",
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
  readonly appends: EventStoreAppendInput[] = [];
  readonly persistedEvents: StoredEvent[] = [];
  private readonly eventsByIdempotencyKey = new Map<string, StoredEvent>();

  async append<TEvent extends DomainEvent>(
    input: EventStoreAppendInput<TEvent>,
  ): Promise<StoredEvent<TEvent>> {
    this.appends.push(input);

    if (input.idempotencyKey) {
      const existing = this.eventsByIdempotencyKey.get(input.idempotencyKey);

      if (existing) {
        return {
          ...existing,
          wasIdempotentReplay: true,
        } as StoredEvent<TEvent>;
      }
    }

    const stored: StoredEvent<TEvent> = {
      ...input,
      id: this.persistedEvents.length + 1,
      wasIdempotentReplay: false,
    };

    this.persistedEvents.push(stored);

    if (input.idempotencyKey) {
      this.eventsByIdempotencyKey.set(input.idempotencyKey, stored);
    }

    return stored;
  }

  async readAggregateEvents() {
    return this.persistedEvents;
  }
}
