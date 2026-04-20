import { describe, expect, it } from "vitest";

import { acceptBuyIntentCommand } from "@/src/application/checkout/accept-buy-intent-command";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";

describe("acceptBuyIntentCommand", () => {
  it("creates command and correlation identities, publishes to the bus, and returns accepted", async () => {
    const bus = new ObservableBus();
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
        bus,
        idGenerator: fixedIds("cmd_1", "corr_1"),
        clock: { now: () => new Date("2026-04-20T03:00:00.000Z") },
      },
    );

    expect(accepted).toEqual({
      commandId: "cmd_1",
      correlationId: "corr_1",
      status: "accepted",
    });
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0]).toMatchObject({
      command_id: "cmd_1",
      correlation_id: "corr_1",
    });
  });

  it("propagates publish failure", async () => {
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
          bus: new FailingBus(),
          idGenerator: fixedIds("cmd_2", "corr_2"),
          clock: { now: () => new Date("2026-04-20T03:00:00.000Z") },
        },
      ),
    ).rejects.toThrow("publish failed");
  });
});

class ObservableBus implements BuyIntentCommandBus {
  readonly published: Array<Parameters<BuyIntentCommandBus["publish"]>[0]> = [];

  async publish(command: Parameters<BuyIntentCommandBus["publish"]>[0]) {
    this.published.push(command);
  }
}

class FailingBus implements BuyIntentCommandBus {
  async publish() {
    throw new Error("publish failed");
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
