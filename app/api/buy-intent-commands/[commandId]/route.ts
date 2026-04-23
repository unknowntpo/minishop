import { type NextRequest, NextResponse } from "next/server";

import { postgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";
import { deprecatedGoApiHeaders } from "@/src/presentation/api/deprecation";

type RouteParams = {
  params: Promise<{
    commandId: string;
  }>;
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  const context = getRequestContext(request);

  try {
    const { commandId } = await params;
    const status = await postgresBuyIntentCommandGateway.readStatus(commandId);

    if (!status) {
      return NextResponse.json(apiErrorBody("Buy intent command not found.", context), {
        status: 404,
        headers: deprecatedGoApiHeaders("/api/buy-intent-commands/:commandId"),
      });
    }

    return NextResponse.json(
      {
        commandId: status.commandId,
        correlationId: status.correlationId,
        status: status.status,
        checkoutIntentId: status.checkoutIntentId,
        eventId: status.eventId,
        isDuplicate: status.isDuplicate,
        failureCode: status.failureCode,
        failureMessage: status.failureMessage,
        createdAt: status.createdAt.toISOString(),
        updatedAt: status.updatedAt.toISOString(),
      },
      {
        headers: {
          ...deprecatedGoApiHeaders("/api/buy-intent-commands/:commandId"),
          "x-request-id": context.requestId,
          "x-trace-id": context.traceId,
        },
      },
    );
  } catch (error) {
    logApiError("buy_intent_command_read_failed", context, error);

    return NextResponse.json(
      apiErrorBody("Buy intent command status is temporarily unavailable.", context),
      {
        status: 500,
        headers: {
          ...deprecatedGoApiHeaders("/api/buy-intent-commands/:commandId"),
          "x-request-id": context.requestId,
          "x-trace-id": context.traceId,
        },
      },
    );
  }
}
