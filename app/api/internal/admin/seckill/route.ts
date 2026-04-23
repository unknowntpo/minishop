import { type NextRequest, NextResponse } from "next/server";

import { postgresAdminDashboardRepository } from "@/src/infrastructure/admin";
import { invalidateSeckillSkuConfigCache } from "@/src/infrastructure/checkout-command/routing-buy-intent-command-bus";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";
import { deprecatedGoApiHeaders } from "@/src/presentation/api/deprecation";

function parseRequest(value: unknown) {
  if (typeof value !== "object" || value === null) {
    throw new Error("Request body must be an object.");
  }

  const record = value as Record<string, unknown>;
  const skuId = typeof record.skuId === "string" ? record.skuId.trim() : "";
  const enabled = record.enabled;
  const stockLimit = record.stockLimit;

  if (!skuId) {
    throw new Error("skuId is required.");
  }
  if (typeof enabled !== "boolean") {
    throw new Error("enabled must be a boolean.");
  }
  if (enabled) {
    if (
      typeof stockLimit !== "number" ||
      !Number.isInteger(stockLimit) ||
      Number.isNaN(stockLimit) ||
      stockLimit <= 0
    ) {
      throw new Error("stockLimit must be a positive integer when enabling seckill.");
    }
  }

  return {
    skuId,
    enabled,
    stockLimit: enabled ? (stockLimit as number) : null,
  };
}

export async function POST(request: NextRequest) {
  const context = getRequestContext(request);

  try {
    const body = parseRequest(await request.json());
    await postgresAdminDashboardRepository.updateSeckillConfig(body);
    invalidateSeckillSkuConfigCache(body.skuId);

    return NextResponse.json(
      {
        ok: true,
      },
      {
        headers: {
          ...deprecatedGoApiHeaders("/api/internal/admin/seckill"),
          "x-request-id": context.requestId,
          "x-trace-id": context.traceId,
        },
      },
    );
  } catch (error) {
    logApiError("admin_seckill_update_failed", context, error);

    return NextResponse.json(apiErrorBody("Seckill config update failed.", context), {
      status: 400,
      headers: {
        ...deprecatedGoApiHeaders("/api/internal/admin/seckill"),
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  }
}
