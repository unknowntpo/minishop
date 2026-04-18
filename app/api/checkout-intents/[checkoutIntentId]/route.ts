import { type NextRequest, NextResponse } from "next/server";

import { getPool } from "@/db/client";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";

type RouteParams = {
  params: Promise<{
    checkoutIntentId: string;
  }>;
};

type CheckoutIntentProjectionRow = {
  checkout_intent_id: string;
  buyer_id: string;
  status: string;
  items: unknown;
  payment_id: string | null;
  order_id: string | null;
  rejection_reason: string | null;
  cancellation_reason: string | null;
  aggregate_version: string | number;
  last_event_id: string | number;
  updated_at: Date;
};

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const context = getRequestContext(_request);

  try {
    const { checkoutIntentId } = await params;
    const result = await getPool().query<CheckoutIntentProjectionRow>(
      `
        select
          checkout_intent_id,
          buyer_id,
          status,
          items,
          payment_id,
          order_id,
          rejection_reason,
          cancellation_reason,
          aggregate_version,
          last_event_id,
          updated_at
        from checkout_intent_projection
        where checkout_intent_id = $1
        limit 1
      `,
      [checkoutIntentId],
    );
    const row = result.rows[0];

    if (!row) {
      return NextResponse.json(apiErrorBody("Checkout intent projection not found.", context), {
        status: 404,
      });
    }

    return NextResponse.json(
      {
        checkoutIntentId: row.checkout_intent_id,
        buyerId: row.buyer_id,
        status: row.status,
        items: row.items,
        paymentId: row.payment_id,
        orderId: row.order_id,
        rejectionReason: row.rejection_reason,
        cancellationReason: row.cancellation_reason,
        aggregateVersion: Number(row.aggregate_version),
        lastEventId: Number(row.last_event_id),
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
    logApiError("checkout_intent_read_failed", context, error);

    return NextResponse.json(apiErrorBody("Checkout status is temporarily unavailable.", context), {
      status: 500,
    });
  }
}
