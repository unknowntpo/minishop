import { describe, expect, it } from "vitest";

import { acceptBuyIntentCommand } from "@/src/application/checkout/accept-buy-intent-command";
import type { BuyIntentCommandGateway } from "@/src/ports/buy-intent-command-gateway";

describe("acceptBuyIntentCommand", () => {
  it("creates command and correlation identities and persists accepted status", async () => {
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
        idGenerator: fixedIds("cmd_1", "corr_1"),
        clock: { now: () => new Date("2026-04-20T03:00:00.000Z") },
      },
    );

    expect(accepted).toEqual({
      commandId: "cmd_1",
      correlationId: "corr_1",
      status: "accepted",
    });
  });
});

class FakeGateway implements BuyIntentCommandGateway {
  async accept(command: Parameters<BuyIntentCommandGateway["accept"]>[0]) {
    return {
      commandId: command.command_id,
      correlationId: command.correlation_id,
      status: "accepted" as const,
    };
  }

  async readStatus() {
    return null;
  }

  async claimPendingBatch() {
    return [];
  }

  async markProcessing() {}

  async markCreated() {}

  async markFailed() {}

  async markMergedDuplicateCommand() {}
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
