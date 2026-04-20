import { type NextRequest, NextResponse } from "next/server";

import { acceptBuyIntentCommand } from "@/src/application/checkout/accept-buy-intent-command";
import { buyIntentCommandBus } from "@/src/infrastructure/checkout-command";
import { systemClock } from "@/src/ports/clock";
import { cryptoIdGenerator } from "@/src/ports/id-generator";
import {
  type AcceptBuyIntentResponse,
  parseAcceptBuyIntentRequest,
} from "@/src/presentation/api/buy-intent-command-contracts";
import { toCheckoutItems } from "@/src/presentation/api/checkout-intent-contracts";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";

export async function POST(request: NextRequest) {
  const context = getRequestContext(request);

  try {
    const body = parseAcceptBuyIntentRequest(await request.json());
    const headerIdempotencyKey = request.headers.get("idempotency-key")?.trim();
    const idempotencyKey = headerIdempotencyKey || body.idempotencyKey;

    const accepted = await acceptBuyIntentCommand(
      {
        buyer_id: body.buyerId,
        items: toCheckoutItems(body.items),
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        metadata: {
          request_id: context.requestId,
          trace_id: context.traceId,
          source: "web",
          actor_id: body.buyerId,
        },
      },
      {
        bus: buyIntentCommandBus,
        idGenerator: cryptoIdGenerator,
        clock: systemClock,
      },
    );

    const response: AcceptBuyIntentResponse = {
      commandId: accepted.commandId,
      correlationId: accepted.correlationId,
      status: accepted.status,
    };

    return NextResponse.json(response, {
      status: 202,
      headers: {
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  } catch (error) {
    logApiError("buy_intent_accept_failed", context, error);

    return NextResponse.json(
      apiErrorBody("Buy intent command could not be accepted. Please try again.", context),
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
