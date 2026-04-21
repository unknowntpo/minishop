import { describe, expect, it, vi } from "vitest";

import { createRoutingBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/routing-buy-intent-command-bus";

describe("createRoutingBuyIntentCommandBus", () => {
  it("routes a single enabled seckill SKU to the seckill bus", async () => {
    const defaultBus = { publish: vi.fn() };
    const seckillBus = { publish: vi.fn() };
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            seckill_enabled: true,
            seckill_stock_limit: 25,
          },
        ],
      }),
    };

    const bus = createRoutingBuyIntentCommandBus({
      defaultBus,
      seckillBus,
      pool: pool as never,
    });

    await bus.publish({
      command_id: "11111111-1111-4111-8111-111111111111",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      buyer_id: "buyer_1",
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
      issued_at: "2026-04-21T00:00:00.000Z",
    });

    expect(seckillBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sku_id: "sku_hot_001",
        seckill_stock_limit: 25,
      }),
    );
    expect(defaultBus.publish).not.toHaveBeenCalled();
  });

  it("keeps mixed-cart traffic on the default path", async () => {
    const defaultBus = { publish: vi.fn() };
    const seckillBus = { publish: vi.fn() };
    const bus = createRoutingBuyIntentCommandBus({
      defaultBus,
      seckillBus,
      pool: { query: vi.fn() } as never,
    });

    const command = {
      command_id: "11111111-1111-4111-8111-111111111111",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      buyer_id: "buyer_1",
      items: [
        {
          sku_id: "sku_hot_001",
          quantity: 1,
          unit_price_amount_minor: 100000,
          currency: "TWD",
        },
        {
          sku_id: "sku_tee_001",
          quantity: 1,
          unit_price_amount_minor: 68000,
          currency: "TWD",
        },
      ],
      metadata: {
        request_id: "req_1",
        trace_id: "trace_1",
        source: "web" as const,
        actor_id: "buyer_1",
      },
      issued_at: "2026-04-21T00:00:00.000Z",
    };

    await bus.publish(command);

    expect(defaultBus.publish).toHaveBeenCalledWith(command);
    expect(seckillBus.publish).not.toHaveBeenCalled();
  });
});
