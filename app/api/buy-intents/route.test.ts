import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const acceptBuyIntentCommand = vi.fn();
const classifyBuyIntentItemsForSeckill = vi.fn();

vi.mock("@/src/application/checkout/accept-buy-intent-command", () => ({
  acceptBuyIntentCommand,
}));

vi.mock("@/src/infrastructure/checkout-command", () => ({
  buyIntentCommandBus: {},
  buyIntentCommandOrchestrator: {},
  classifyBuyIntentItemsForSeckill,
  postgresBuyIntentCommandGateway: {},
}));

vi.mock("@/db/client", () => ({
  getPool: vi.fn(() => ({})),
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
    classifyBuyIntentItemsForSeckill.mockReset();
    classifyBuyIntentItemsForSeckill.mockResolvedValue({ kind: "default" });
    vi.unstubAllGlobals();
    delete process.env.GO_SECKILL_INGRESS_PROXY_ENABLED;
    delete process.env.GO_SECKILL_INGRESS_INTERNAL_URL;
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

  it("proxies single seckill traffic to the Go ingress when enabled", async () => {
    process.env.GO_SECKILL_INGRESS_PROXY_ENABLED = "1";
    process.env.GO_SECKILL_INGRESS_INTERNAL_URL = "http://go-seckill-ingress:3000";
    classifyBuyIntentItemsForSeckill.mockResolvedValue({
      kind: "single_seckill",
      skuId: "sku_hot_001",
      stockLimit: 100,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          status: "accepted",
        }),
        {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_go",
            "x-trace-id": "trace_go",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");

    const request = new NextRequest("http://localhost:3000/api/buy-intents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem_go",
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
      commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "accepted",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://go-seckill-ingress:3000/api/buy-intents",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "idempotency-key": "idem_go",
        }),
      }),
    );
    expect(acceptBuyIntentCommand).not.toHaveBeenCalled();
  });
});
