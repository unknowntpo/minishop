import { describe, expect, it } from "vitest";

import { ingestBuyIntentCommandMessage } from "@/src/application/checkout/ingest-buy-intent-command-message";
import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { StagedBuyIntentCommandInput } from "@/src/ports/buy-intent-command-gateway";

describe("ingestBuyIntentCommandMessage", () => {
  it("stages a valid command and acks the message", async () => {
    const staged: StagedBuyIntentCommandInput[] = [];

    const result = await ingestBuyIntentCommandMessage(
      {
        data: new TextEncoder().encode(JSON.stringify(buildCommand())),
        sourceSubject: "buy-intent.command",
      },
      {
        decode(data) {
          return JSON.parse(new TextDecoder().decode(data)) as BuyIntentCommand;
        },
        async stage(input) {
          staged.push(input);
        },
        async publishDlq() {
          throw new Error("dlq should not be called");
        },
      },
    );

    expect(result).toEqual({
      outcome: "ack",
      staged: true,
      dlqPublished: false,
    });
    expect(staged).toHaveLength(1);
    expect(staged[0]?.command.command_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("publishes invalid payloads to dlq and still acks", async () => {
    const dlq: Array<{ reason: string; sourceSubject: string; data: Uint8Array }> = [];

    const result = await ingestBuyIntentCommandMessage(
      {
        data: new TextEncoder().encode("{bad json"),
        sourceSubject: "buy-intent.command",
      },
      {
        decode() {
          throw new Error("Unexpected token");
        },
        async stage() {
          throw new Error("stage should not be called");
        },
        async publishDlq(input) {
          dlq.push(input);
        },
      },
    );

    expect(result).toEqual({
      outcome: "ack",
      staged: false,
      dlqPublished: true,
    });
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({
      reason: "invalid_buy_intent_command",
      sourceSubject: "buy-intent.command",
    });
  });

  it("naks transient staging failures", async () => {
    const result = await ingestBuyIntentCommandMessage(
      {
        data: new TextEncoder().encode(JSON.stringify(buildCommand())),
        sourceSubject: "buy-intent.command",
      },
      {
        decode(data) {
          return JSON.parse(new TextDecoder().decode(data)) as BuyIntentCommand;
        },
        async stage() {
          throw new Error("temporary database issue");
        },
        async publishDlq() {
          throw new Error("dlq should not be called");
        },
      },
    );

    expect(result).toEqual({
      outcome: "nak",
      staged: false,
      dlqPublished: false,
    });
  });
});

function buildCommand(): BuyIntentCommand {
  return {
    command_id: "11111111-1111-4111-8111-111111111111",
    correlation_id: "22222222-2222-4222-8222-222222222222",
    buyer_id: "buyer_1",
    idempotency_key: "idem_1",
    items: [
      {
        sku_id: "sku_hot_001",
        quantity: 1,
        unit_price_amount_minor: 1200,
        currency: "TWD",
      },
    ],
    metadata: {
      request_id: "req_1",
      trace_id: "trace_1",
      source: "web",
      actor_id: "buyer_1",
    },
    issued_at: "2026-04-20T03:00:00.000Z",
  };
}
