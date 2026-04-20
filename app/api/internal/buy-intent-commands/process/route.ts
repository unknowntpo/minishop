import { type NextRequest, NextResponse } from "next/server";

import { processStagedBuyIntentCommandBatch } from "@/src/application/checkout/process-staged-buy-intent-command-batch";
import {
  buyIntentCommandOrchestrator,
  postgresBuyIntentCommandGateway,
} from "@/src/infrastructure/checkout-command";
import { postgresEventStore } from "@/src/infrastructure/event-store";
import { systemClock } from "@/src/ports/clock";
import { cryptoIdGenerator } from "@/src/ports/id-generator";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";

export async function POST(request: NextRequest) {
  const context = getRequestContext(request);

  try {
    const body = (await request.json().catch(() => ({}))) as { batchSize?: unknown };
    const batchSize =
      typeof body.batchSize === "number" && Number.isFinite(body.batchSize)
        ? Math.max(1, Math.trunc(body.batchSize))
        : undefined;

    const result = await processStagedBuyIntentCommandBatch(
      { batchSize },
      {
        gateway: postgresBuyIntentCommandGateway,
        orchestrator: buyIntentCommandOrchestrator,
        eventStore: postgresEventStore,
        idGenerator: cryptoIdGenerator,
        clock: systemClock,
      },
    );

    return NextResponse.json(result, {
      headers: {
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  } catch (error) {
    logApiError("buy_intent_command_process_failed", context, error);

    return NextResponse.json(
      apiErrorBody("Buy intent command batch could not be processed.", context),
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
