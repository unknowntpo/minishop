import type {
  AdminDashboard,
  AdminDashboardRepository,
} from "@/src/ports/admin-dashboard-repository";

export type GetAdminDashboardDeps = {
  adminDashboardRepository: AdminDashboardRepository;
};

export async function getAdminDashboard({
  adminDashboardRepository,
}: GetAdminDashboardDeps): Promise<AdminDashboard> {
  return adminDashboardRepository.getDashboard();
}
