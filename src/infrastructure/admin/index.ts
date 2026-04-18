import { getPool } from "@/db/client";
import { createPostgresAdminDashboardRepository } from "@/src/infrastructure/admin/postgres-admin-dashboard";
import type { AdminDashboardRepository } from "@/src/ports/admin-dashboard-repository";

export const postgresAdminDashboardRepository: AdminDashboardRepository = {
  getDashboard() {
    return createPostgresAdminDashboardRepository(getPool()).getDashboard();
  },
};
