import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const acceptBuyIntentCommand = vi.fn();

vi.mock("@/src/application/checkout/accept-buy-intent-command", () => ({
  acceptBuyIntentCommand,
}));

vi.mock("@/src/infrastructure/checkout-command", () => ({
  buyIntentCommandBus: {},
  buyIntentCommandOrchestrator: {},
  postgresBuyIntentCommandGateway: {},
}));

vi.mock("@/src/ports/clock", () => ({
  systemClock: { now: () => new Date("2026-04-20T03:00:00.000Z") },
}));

vi.mock("@/src/ports/id-generator", () => ({
  cryptoIdGenerator: { randomUuid: () => crypto.randomUUID() },
}));

describe("POST /api/buy-intents", () => {
  beforeEach(() => {
    acceptBuyIntentCommand.mockReset();
  });

  it("returns 202 accepted with command identity", async () => {
    acceptBuyIntentCommand.mockResolvedValue({
      commandId: "11111111-1111-4111-8111-111111111111",
      correlationId: "22222222-2222-4222-8222-222222222222",
      status: "accepted",
    });

    const { POST } = await import("./route");

    const request = new NextRequest("http://localhost:3000/api/buy-intents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem_1",
        "x-request-id": "req_1",
        "x-trace-id": "trace_1",
      },
      body: JSON.stringify({
        buyerId: "buyer_1",
        items: [
          {
            skuId: "sku_hot_001",
            quantity: 1,
            unitPriceAmountMinor: 1200,
            currency: "TWD",
          },
        ],
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      commandId: "11111111-1111-4111-8111-111111111111",
      correlationId: "22222222-2222-4222-8222-222222222222",
      status: "accepted",
    });
    expect(acceptBuyIntentCommand).toHaveBeenCalledTimes(1);
  });
});
