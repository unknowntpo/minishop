import { type NextRequest, NextResponse } from "next/server";

import { getPool } from "@/db/client";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";

type RouteParams = {
  params: Promise<{
    skuId: string;
  }>;
};

type SkuInventoryProjectionRow = {
  sku_id: string;
  aggregate_version: string | number;
  last_event_id: string | number;
  on_hand: number;
  reserved: number;
  sold: number;
  available: number;
  updated_at: Date;
};

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const context = getRequestContext(_request);

  try {
    const { skuId } = await params;
    const result = await getPool().query<SkuInventoryProjectionRow>(
      `
        select
          sku_id,
          aggregate_version,
          last_event_id,
          on_hand,
          reserved,
          sold,
          available,
          updated_at
        from sku_inventory_projection
        where sku_id = $1
        limit 1
      `,
      [skuId],
    );
    const row = result.rows[0];

    if (!row) {
      return NextResponse.json(apiErrorBody("SKU inventory projection not found.", context), {
        status: 404,
      });
    }

    return NextResponse.json(
      {
        skuId: row.sku_id,
        aggregateVersion: Number(row.aggregate_version),
        lastEventId: Number(row.last_event_id),
        onHand: row.on_hand,
        reserved: row.reserved,
        sold: row.sold,
        available: row.available,
        updatedAt: row.updated_at.toISOString(),
      },
      {
        headers: {
          "x-request-id": context.requestId,
          "x-trace-id": context.traceId,
        },
      },
    );
  } catch (error) {
    logApiError("sku_inventory_read_failed", context, error);

    return NextResponse.json(
      apiErrorBody("Inventory status is temporarily unavailable.", context),
      { status: 500 },
    );
  }
}
