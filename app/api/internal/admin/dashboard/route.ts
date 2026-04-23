import { type NextRequest, NextResponse } from "next/server";

import { getAdminDashboard } from "@/src/application/admin/get-admin-dashboard";
import { postgresAdminDashboardRepository } from "@/src/infrastructure/admin";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";
import { deprecatedGoApiHeaders } from "@/src/presentation/api/deprecation";

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
          ...deprecatedGoApiHeaders("/api/internal/admin/dashboard"),
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
        ...deprecatedGoApiHeaders("/api/internal/admin/dashboard"),
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  }
}
