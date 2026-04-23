import { type NextRequest, NextResponse } from "next/server";

import { processProjections } from "@/src/application/projections/process-projections";
import { postgresProjectionRepository } from "@/src/infrastructure/projections";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";
import { deprecatedGoApiHeaders } from "@/src/presentation/api/deprecation";

export async function POST(request: NextRequest) {
  const context = getRequestContext(request);

  try {
    const body = await readJsonBody(request);
    const result = await processProjections(
      {
        projectionName: typeof body.projectionName === "string" ? body.projectionName : undefined,
        batchSize: typeof body.batchSize === "number" ? body.batchSize : undefined,
      },
      {
        projectionRepository: postgresProjectionRepository,
      },
    );

    return NextResponse.json(result, {
      status: result.locked ? 200 : 409,
      headers: {
        ...deprecatedGoApiHeaders("/api/internal/projections/process"),
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  } catch (error) {
    logApiError("projection_process_failed", context, error);

    return NextResponse.json(apiErrorBody("Projection processing failed.", context), {
      status: 400,
      headers: deprecatedGoApiHeaders("/api/internal/projections/process"),
    });
  }
}

async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  if (!request.body) {
    return {};
  }

  const value = (await request.json().catch(() => ({}))) as unknown;

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}
