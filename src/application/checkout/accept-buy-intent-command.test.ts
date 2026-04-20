import { describe, expect, it } from "vitest";

import { acceptBuyIntentCommand } from "@/src/application/checkout/accept-buy-intent-command";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";
import type { BuyIntentCommandGateway } from "@/src/ports/buy-intent-command-gateway";
import type { BuyIntentCommandOrchestrator } from "@/src/ports/buy-intent-command-orchestrator";

describe("acceptBuyIntentCommand", () => {
  it("creates command and correlation identities, starts orchestration, and persists accepted status", async () => {
    const orchestrator = new FakeOrchestrator();

    const accepted = await acceptBuyIntentCommand(
      {
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
      },
      {
        gateway: new FakeGateway(),
        bus: new FakeBus(),
        orchestrator,
        idGenerator: fixedIds("cmd_1", "corr_1"),
        clock: { now: () => new Date("2026-04-20T03:00:00.000Z") },
      },
    );

    expect(accepted).toEqual({
      commandId: "cmd_1",
      correlationId: "corr_1",
      status: "accepted",
    });
    expect(orchestrator.started).toHaveLength(1);
    expect(orchestrator.started[0]).toMatchObject({
      command_id: "cmd_1",
      correlation_id: "corr_1",
    });
  });

  it("marks publish failure after accepted status creation", async () => {
    const gateway = new PublishFailureGateway();
    const orchestrator = new FakeOrchestrator();

    await expect(
      acceptBuyIntentCommand(
        {
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
        },
        {
          gateway,
          bus: new FailingBus(),
          orchestrator,
          idGenerator: fixedIds("cmd_2", "corr_2"),
          clock: { now: () => new Date("2026-04-20T03:00:00.000Z") },
        },
      ),
    ).rejects.toThrow("publish failed");

    expect(gateway.publishFailed[0]).toMatchObject({
      commandId: "cmd_2",
      failureCode: "command_publish_failed",
    });
    expect(orchestrator.failed[0]).toMatchObject({
      commandId: "cmd_2",
      failureCode: "command_publish_failed",
    });
  });

  it("marks orchestration failure before attempting publish", async () => {
    const gateway = new PublishFailureGateway();
    const bus = new ObservableBus();

    await expect(
      acceptBuyIntentCommand(
        {
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
        },
        {
          gateway,
          bus,
          orchestrator: new FailingOrchestrator(),
          idGenerator: fixedIds("cmd_3", "corr_3"),
          clock: { now: () => new Date("2026-04-20T03:00:00.000Z") },
        },
      ),
    ).rejects.toThrow("orchestration failed");

    expect(gateway.publishFailed[0]).toMatchObject({
      commandId: "cmd_3",
      failureCode: "command_orchestration_failed",
    });
    expect(bus.published).toHaveLength(0);
  });
});

class FakeGateway implements BuyIntentCommandGateway {
  async createAccepted(command: Parameters<BuyIntentCommandGateway["createAccepted"]>[0]) {
    return {
      commandId: command.command_id,
      correlationId: command.correlation_id,
      status: "accepted" as const,
    };
  }

  async readStatus() {
    return null;
  }

  async readStatuses() {
    return [];
  }

  async stage() {}

  async claimPendingBatch() {
    return [];
  }

  async markProcessing() {}

  async markProcessingBatch() {}

  async markPublishFailed(
    _input: Parameters<BuyIntentCommandGateway["markPublishFailed"]>[0],
  ) {}

  async markCreated() {}

  async markCreatedBatch() {}

  async markFailed() {}

  async markFailedBatch() {}

  async markMergedDuplicateCommand() {}

  async markMergedDuplicateCommands() {}
}

class FakeBus implements BuyIntentCommandBus {
  async publish() {}
}

class ObservableBus implements BuyIntentCommandBus {
  readonly published: Array<Parameters<BuyIntentCommandBus["publish"]>[0]> = [];

  async publish(command: Parameters<BuyIntentCommandBus["publish"]>[0]) {
    this.published.push(command);
  }
}

class FakeOrchestrator implements BuyIntentCommandOrchestrator {
  readonly started: Array<Parameters<BuyIntentCommandOrchestrator["start"]>[0]> = [];
  readonly failed: Array<Parameters<BuyIntentCommandOrchestrator["markFailed"]>[0]> = [];

  async start(command: Parameters<BuyIntentCommandOrchestrator["start"]>[0]) {
    this.started.push(command);
  }

  async markProcessing() {}

  async markCreated() {}

  async markFailed(input: Parameters<BuyIntentCommandOrchestrator["markFailed"]>[0]) {
    this.failed.push(input);
  }
}

class PublishFailureGateway extends FakeGateway {
  readonly publishFailed: Array<
    Parameters<BuyIntentCommandGateway["markPublishFailed"]>[0]
  > = [];

  async markPublishFailed(input: Parameters<BuyIntentCommandGateway["markPublishFailed"]>[0]) {
    this.publishFailed.push(input);
  }
}

class FailingBus implements BuyIntentCommandBus {
  async publish() {
    throw new Error("publish failed");
  }
}

class FailingOrchestrator implements BuyIntentCommandOrchestrator {
  async start() {
    throw new Error("orchestration failed");
  }

  async markProcessing() {}

  async markCreated() {}

  async markFailed() {}
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
