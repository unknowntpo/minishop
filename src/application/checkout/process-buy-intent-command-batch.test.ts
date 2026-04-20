import { describe, expect, it } from "vitest";

import { processBuyIntentCommandBatch } from "@/src/application/checkout/process-buy-intent-command-batch";
import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { DomainEvent } from "@/src/domain/events/domain-event";
import type { BuyIntentCommandGateway, BuyIntentCommandStatusView, StagedBuyIntentCommand } from "@/src/ports/buy-intent-command-gateway";
import type { EventStore, EventStoreAppendInput, StoredEvent } from "@/src/ports/event-store";

describe("processBuyIntentCommandBatch", () => {
  it("marks created when a staged command is appended successfully", async () => {
    const gateway = new FakeGateway([
      {
        stagingId: 1,
        commandId: "cmd_1",
        correlationId: "corr_1",
        idempotencyKey: "idem_1",
        payload: {
          command_id: "cmd_1",
          correlation_id: "corr_1",
          buyer_id: "buyer_1",
          items: [
            {
              sku_id: "sku_hot_001",
              quantity: 1,
              unit_price_amount_minor: 1200,
              currency: "TWD",
            },
          ],
          idempotency_key: "idem_1",
          metadata: {
            request_id: "req_1",
            trace_id: "trace_1",
            source: "web",
            actor_id: "buyer_1",
          },
          issued_at: "2026-04-20T03:00:00.000Z",
        },
      },
    ]);

    const result = await processBuyIntentCommandBatch(
      { batchSize: 10 },
      {
        gateway,
        eventStore: new FakeEventStore(false),
        idGenerator: fixedIds("batch_1", "checkout_1", "event_1"),
        clock: { now: () => new Date("2026-04-20T03:00:00.000Z") },
      },
    );

    expect(result).toMatchObject({
      batchId: "batch_1",
      claimedCount: 1,
      createdCount: 1,
      failedCount: 0,
      duplicateCommandCount: 0,
    });
    expect(gateway.created[0]).toMatchObject({
      commandId: "cmd_1",
      checkoutIntentId: "checkout_1",
      eventId: "event_1",
      isDuplicate: false,
    });
  });

  it("marks replayed event append as created with duplicate flag", async () => {
    const gateway = new FakeGateway([
      {
        stagingId: 2,
        commandId: "cmd_2",
        correlationId: "corr_2",
        idempotencyKey: "idem_same",
        payload: {
          command_id: "cmd_2",
          correlation_id: "corr_2",
          buyer_id: "buyer_2",
          items: [
            {
              sku_id: "sku_hot_001",
              quantity: 1,
              unit_price_amount_minor: 1200,
              currency: "TWD",
            },
          ],
          idempotency_key: "idem_same",
          metadata: {
            request_id: "req_2",
            trace_id: "trace_2",
            source: "web",
            actor_id: "buyer_2",
          },
          issued_at: "2026-04-20T03:10:00.000Z",
        },
      },
    ]);

    await processBuyIntentCommandBatch(
      { batchSize: 10 },
      {
        gateway,
        eventStore: new FakeEventStore(true),
        idGenerator: fixedIds("batch_2", "checkout_2", "event_2"),
        clock: { now: () => new Date("2026-04-20T03:10:00.000Z") },
      },
    );

    expect(gateway.created[0]).toMatchObject({
      commandId: "cmd_2",
      isDuplicate: true,
    });
  });
});

class FakeGateway implements BuyIntentCommandGateway {
  readonly created: Array<Parameters<BuyIntentCommandGateway["markCreated"]>[0]> = [];

  constructor(private readonly staged: StagedBuyIntentCommand[]) {}

  async createAccepted(command: BuyIntentCommand) {
    return {
      commandId: command.command_id,
      correlationId: command.correlation_id,
      status: "accepted" as const,
    };
  }

  async readStatus(commandId: string): Promise<BuyIntentCommandStatusView | null> {
    return {
      commandId,
      correlationId: "corr_1",
      status: "accepted",
      checkoutIntentId: null,
      eventId: null,
      isDuplicate: false,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date("2026-04-20T03:00:00.000Z"),
      updatedAt: new Date("2026-04-20T03:00:00.000Z"),
    };
  }

  async stage() {}

  async claimPendingBatch() {
    return this.staged;
  }

  async markProcessing() {}

  async markPublishFailed() {}

  async markCreated(input: Parameters<BuyIntentCommandGateway["markCreated"]>[0]) {
    this.created.push(input);
  }

  async markFailed() {}

  async markMergedDuplicateCommand() {}
}

class FakeEventStore implements EventStore {
  constructor(private readonly wasReplay: boolean) {}

  async append<TEvent extends DomainEvent>(
    input: EventStoreAppendInput<TEvent>,
  ): Promise<StoredEvent<TEvent>> {
    return {
      ...input,
      id: 1,
      wasIdempotentReplay: this.wasReplay,
    };
  }

  async readAggregateEvents() {
    return [];
  }
}

function fixedIds(...values: string[]) {
  let index = 0;

  return {
    randomUuid() {
      const value = values[index];

      if (!value) {
        throw new Error("No more fixed ids available.");
      }

      index += 1;
      return value;
    },
  };
}
