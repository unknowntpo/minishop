import { type NextRequest, NextResponse } from "next/server";

import { completeDemoCheckout } from "@/src/application/checkout/complete-demo-checkout";
import { postgresCheckoutDemoRepository } from "@/src/infrastructure/checkout-demo";
import { postgresEventStore } from "@/src/infrastructure/event-store";
import { systemClock } from "@/src/ports/clock";
import { cryptoIdGenerator } from "@/src/ports/id-generator";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";
import { deprecatedGoApiHeaders } from "@/src/presentation/api/deprecation";
import { injectTraceCarrier } from "@/src/infrastructure/telemetry/otel";

type RouteParams = {
  params: Promise<{
    checkoutIntentId: string;
  }>;
};

export async function POST(request: NextRequest, { params }: RouteParams) {
  const context = getRequestContext(request);

  try {
    const { checkoutIntentId } = await params;
    const result = await completeDemoCheckout(
      {
        checkoutIntentId,
        metadata: {
          request_id: context.requestId,
          trace_id: context.traceId,
          source: "worker",
          actor_id: "demo-checkout-completer",
          ...injectTraceCarrier(),
        },
      },
      {
        checkoutDemoRepository: postgresCheckoutDemoRepository,
        eventStore: postgresEventStore,
        idGenerator: cryptoIdGenerator,
        clock: systemClock,
      },
    );

    return NextResponse.json(result, {
      headers: {
        ...deprecatedGoApiHeaders("/api/internal/checkout-intents/:checkoutIntentId/complete-demo"),
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  } catch (error) {
    logApiError("checkout_demo_completion_failed", context, error);

    return NextResponse.json(apiErrorBody("Checkout demo completion failed.", context), {
      status: 400,
      headers: {
        ...deprecatedGoApiHeaders("/api/internal/checkout-intents/:checkoutIntentId/complete-demo"),
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  }
}
