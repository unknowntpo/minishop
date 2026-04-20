import { type NextRequest, NextResponse } from "next/server";

import { startCpuProfile, stopCpuProfile } from "@/src/infrastructure/benchmarks/node-cpu-profiler";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const context = getRequestContext(request);

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";

    if (!runId) {
      return NextResponse.json(apiErrorBody("Profiling runId is required.", context), {
        status: 400,
      });
    }

    if (action === "start") {
      const result = await startCpuProfile({
        runId,
        label: typeof body.label === "string" ? body.label : undefined,
      });

      return NextResponse.json(
        {
          status: "started",
          ...result,
        },
        {
          status: 202,
          headers: {
            "x-request-id": context.requestId,
            "x-trace-id": context.traceId,
          },
        },
      );
    }

    if (action === "stop") {
      const result = await stopCpuProfile({ runId });

      return NextResponse.json(
        {
          status: "captured",
          ...result,
        },
        {
          headers: {
            "x-request-id": context.requestId,
            "x-trace-id": context.traceId,
          },
        },
      );
    }

    return NextResponse.json(apiErrorBody("Profiling action must be start or stop.", context), {
      status: 400,
    });
  } catch (error) {
    logApiError("benchmark_profiling_failed", context, error);

    return NextResponse.json(apiErrorBody("Benchmark profiling failed.", context), {
      status: 500,
      headers: {
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  }
}
