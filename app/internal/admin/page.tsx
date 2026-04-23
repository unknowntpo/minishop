import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminDashboardView } from "@/components/admin/admin-dashboard";
import { getAdminDashboard } from "@/src/application/admin/get-admin-dashboard";
import { postgresAdminDashboardRepository } from "@/src/infrastructure/admin";
import { buildBuyerWebUrl } from "@/src/presentation/buyer-web-runtime";

export const dynamic = "force-dynamic";

export default async function InternalAdminPage() {
  const buyerWebUrl = buildBuyerWebUrl("/internal/admin");
  if (buyerWebUrl) {
    redirect(buyerWebUrl);
  }

  const dashboard = await getAdminDashboard({
    adminDashboardRepository: postgresAdminDashboardRepository,
  });

  return (
    <main className="page-shell admin-shell">
      <nav className="admin-nav">
        <Link className="text-link" href="/products">
          Products
        </Link>
        <Link className="text-link" href="/internal/design-system">
          Design system
        </Link>
        <Link className="text-link" href="/internal/benchmarks">
          Benchmark results
        </Link>
      </nav>

      <section className="catalog-hero" aria-labelledby="admin-title">
        <p className="eyebrow">Internal admin</p>
        <h1 id="admin-title">Projection status</h1>
        <p className="muted hero-copy">
          Local visibility for catalog SKUs, inventory counters, checkout projections, and worker
          checkpoints.
        </p>
      </section>

      <AdminDashboardView
        initialDashboard={{
          ...dashboard,
          refreshedAt: new Date().toISOString(),
        }}
      />
    </main>
  );
}
