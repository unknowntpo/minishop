import Link from "next/link";

import { AdminDashboardView } from "@/components/admin/admin-dashboard";
import { getAdminDashboard } from "@/src/application/admin/get-admin-dashboard";
import { postgresAdminDashboardRepository } from "@/src/infrastructure/admin";

export const dynamic = "force-dynamic";

export default async function InternalAdminPage() {
  const dashboard = await getAdminDashboard({
    adminDashboardRepository: postgresAdminDashboardRepository,
  });

  return (
    <main className="page-shell admin-shell">
      <Link className="text-link" href="/products">
        Products
      </Link>

      <section className="catalog-hero" aria-labelledby="admin-title">
        <p className="eyebrow">Internal admin</p>
        <h1 id="admin-title">Projection status</h1>
        <p className="muted hero-copy">
          Local visibility for catalog SKUs, inventory counters, checkout projections, and worker
          checkpoints.
        </p>
      </section>

      <AdminDashboardView initialDashboard={dashboard} />
    </main>
  );
}
