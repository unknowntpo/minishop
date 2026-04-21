import { type NextRequest, NextResponse } from "next/server";

import { createCheckoutIntent } from "@/src/application/checkout/create-checkout-intent";
import { postgresEventStore } from "@/src/infrastructure/event-store";
import { systemClock } from "@/src/ports/clock";
import { cryptoIdGenerator } from "@/src/ports/id-generator";
import {
  type CreateCheckoutIntentResponse,
  parseCreateCheckoutIntentRequest,
  toCheckoutItems,
} from "@/src/presentation/api/checkout-intent-contracts";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";
import { injectTraceCarrier } from "@/src/infrastructure/telemetry/otel";

export async function POST(request: NextRequest) {
  const context = getRequestContext(request);

  try {
    const body = parseCreateCheckoutIntentRequest(await request.json());
    const headerIdempotencyKey = request.headers.get("idempotency-key")?.trim();
    const idempotencyKey = headerIdempotencyKey || body.idempotencyKey;

    const result = await createCheckoutIntent(
      {
        buyer_id: body.buyerId,
        items: toCheckoutItems(body.items),
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        metadata: {
          request_id: context.requestId,
          trace_id: context.traceId,
          source: "web",
          actor_id: body.buyerId,
          ...injectTraceCarrier(),
        },
      },
      {
        eventStore: postgresEventStore,
        idGenerator: cryptoIdGenerator,
        clock: systemClock,
      },
    );

    const response: CreateCheckoutIntentResponse = {
      checkoutIntentId: result.checkoutIntentId,
      eventId: result.eventId,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
    };

    return NextResponse.json(response, {
      status: result.idempotentReplay ? 200 : 202,
      headers: {
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  } catch (error) {
    logApiError("checkout_intent_create_failed", context, error);

    return NextResponse.json(
      apiErrorBody("Checkout request could not be accepted. Please try again.", context),
      {
        status: 500,
        headers: {
          "x-request-id": context.requestId,
          "x-trace-id": context.traceId,
        },
      },
    );
  }
}
