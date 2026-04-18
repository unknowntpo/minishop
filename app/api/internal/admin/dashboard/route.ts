import { type NextRequest, NextResponse } from "next/server";

import { getAdminDashboard } from "@/src/application/admin/get-admin-dashboard";
import { postgresAdminDashboardRepository } from "@/src/infrastructure/admin";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";

export async function GET(request: NextRequest) {
  const context = getRequestContext(request);

  try {
    const dashboard = await getAdminDashboard({
      adminDashboardRepository: postgresAdminDashboardRepository,
    });

    return NextResponse.json(
      {
        ...dashboard,
        refreshedAt: new Date().toISOString(),
      },
      {
        headers: {
          "x-request-id": context.requestId,
          "x-trace-id": context.traceId,
        },
      },
    );
  } catch (error) {
    logApiError("admin_dashboard_read_failed", context, error);

    return NextResponse.json(apiErrorBody("Admin dashboard is temporarily unavailable.", context), {
      status: 500,
      headers: {
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  }
}
