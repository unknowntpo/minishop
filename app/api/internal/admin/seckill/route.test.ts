import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSeckillConfig = vi.fn();

vi.mock("@/src/infrastructure/admin", () => ({
  postgresAdminDashboardRepository: {
    updateSeckillConfig,
  },
}));

describe("POST /api/internal/admin/seckill", () => {
  beforeEach(() => {
    updateSeckillConfig.mockReset();
  });

  it("updates seckill config for a candidate SKU", async () => {
    const { POST } = await import("./route");

    const request = new NextRequest("http://localhost:3000/api/internal/admin/seckill", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        skuId: "sku_hot_001",
        enabled: true,
        stockLimit: 25,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(updateSeckillConfig).toHaveBeenCalledWith({
      skuId: "sku_hot_001",
      enabled: true,
      stockLimit: 25,
    });
  });

  it("rejects invalid stock limit when enabling seckill", async () => {
    const { POST } = await import("./route");

    const request = new NextRequest("http://localhost:3000/api/internal/admin/seckill", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        skuId: "sku_hot_001",
        enabled: true,
        stockLimit: 0,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(updateSeckillConfig).not.toHaveBeenCalled();
  });
});
