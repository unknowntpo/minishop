import { describe, expect, it, vi } from "vitest";

import {
  createRoutingBuyIntentCommandBus,
  MixedCartWithSeckillNotSupportedError,
} from "@/src/infrastructure/checkout-command/routing-buy-intent-command-bus";

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
      bucketCount: 16,
      maxProbe: 4,
      seckillSkuConfigTtlMs: 60_000,
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
        bucket_count: 16,
        primary_bucket_id: expect.any(Number),
        bucket_id: expect.any(Number),
        attempt: 0,
        max_probe: 4,
        processing_key: expect.stringMatching(/^sku_hot_001#\d{2}$/),
      }),
    );
    expect(defaultBus.publish).not.toHaveBeenCalled();
  });

  it("rejects mixed-cart traffic when any item is seckill-enabled", async () => {
    const defaultBus = { publish: vi.fn() };
    const seckillBus = { publish: vi.fn() };
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            sku_id: "sku_hot_001",
            seckill_enabled: true,
            seckill_stock_limit: 25,
          },
          {
            sku_id: "sku_tee_001",
            seckill_enabled: false,
            seckill_stock_limit: null,
          },
        ],
      }),
    };
    const bus = createRoutingBuyIntentCommandBus({
      defaultBus,
      seckillBus,
      pool: pool as never,
      bucketCount: 16,
      maxProbe: 4,
      seckillSkuConfigTtlMs: 60_000,
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

    await expect(bus.publish(command)).rejects.toBeInstanceOf(MixedCartWithSeckillNotSupportedError);

    expect(defaultBus.publish).not.toHaveBeenCalled();
    expect(seckillBus.publish).not.toHaveBeenCalled();
  });

  it("keeps non-seckill mixed-cart traffic on the default path", async () => {
    const defaultBus = { publish: vi.fn() };
    const seckillBus = { publish: vi.fn() };
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            sku_id: "sku_tee_001",
            seckill_enabled: false,
            seckill_stock_limit: null,
          },
          {
            sku_id: "sku_cap_001",
            seckill_enabled: false,
            seckill_stock_limit: null,
          },
        ],
      }),
    };
    const bus = createRoutingBuyIntentCommandBus({
      defaultBus,
      seckillBus,
      pool: pool as never,
      bucketCount: 16,
      maxProbe: 4,
      seckillSkuConfigTtlMs: 60_000,
    });

    const command = {
      command_id: "11111111-1111-4111-8111-111111111111",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      buyer_id: "buyer_1",
      items: [
        {
          sku_id: "sku_tee_001",
          quantity: 1,
          unit_price_amount_minor: 68000,
          currency: "TWD",
        },
        {
          sku_id: "sku_cap_001",
          quantity: 1,
          unit_price_amount_minor: 42000,
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
