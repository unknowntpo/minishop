import { type NextRequest, NextResponse } from "next/server";

import { buyIntentTemporalSignals } from "@/src/domain/checkout-command/temporal-contract";
import { signalTemporalBuyIntentWorkflow } from "@/src/infrastructure/checkout-command/temporal-buy-intent-command-orchestrator";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";

type RouteParams = {
  params: Promise<{
    commandId: string;
  }>;
};

export async function POST(request: NextRequest, { params }: RouteParams) {
  const context = getRequestContext(request);

  try {
    const temporalAddress = readRuntimeEnv("TEMPORAL_ADDRESS");
    if (!temporalAddress) {
      return NextResponse.json(apiErrorBody("Temporal is not configured.", context), {
        status: 503,
      });
    }

    const { commandId } = await params;
    const body = await request.json().catch(() => ({}));
    const outcome = typeof body.outcome === "string" ? body.outcome : "";

    if (outcome !== "succeeded" && outcome !== "failed") {
      return NextResponse.json(apiErrorBody("payment outcome must be succeeded or failed.", context), {
        status: 400,
      });
    }

    await signalTemporalBuyIntentWorkflow({
      address: temporalAddress,
      namespace: readRuntimeEnv("TEMPORAL_NAMESPACE") || undefined,
      commandId,
      signalName:
        outcome === "succeeded"
          ? buyIntentTemporalSignals.paymentSucceeded
          : buyIntentTemporalSignals.paymentFailed,
      signalArgs:
        outcome === "succeeded"
          ? [{ providerReference: `demo:${commandId}` }]
          : [{ reason: "payment_failed" }],
    });

    return NextResponse.json(
      {
        commandId,
        outcome,
        accepted: true,
      },
      {
        headers: {
          "x-request-id": context.requestId,
          "x-trace-id": context.traceId,
        },
      },
    );
  } catch (error) {
    logApiError("demo_payment_signal_failed", context, error);

    return NextResponse.json(
      apiErrorBody("Demo payment signal could not be delivered.", context),
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

function readRuntimeEnv(name: string) {
  const value = globalThis.process?.env?.[name];
  return typeof value === "string" ? value.trim() : "";
}
