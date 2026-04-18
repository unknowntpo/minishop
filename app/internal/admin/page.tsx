import Link from "next/link";

import { getAdminDashboard } from "@/src/application/admin/get-admin-dashboard";
import { postgresAdminDashboardRepository } from "@/src/infrastructure/admin";

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

      <section className="panel admin-panel" aria-labelledby="sku-title">
        <p className="eyebrow">Products and SKUs</p>
        <h2 id="sku-title">Inventory projections</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th>Status</th>
                <th>On hand</th>
                <th>Reserved</th>
                <th>Sold</th>
                <th>Available</th>
                <th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.products.map((row) => (
                <tr key={row.skuId}>
                  <td>
                    <strong>{row.productName}</strong>
                    <span className="muted">{row.productId}</span>
                  </td>
                  <td>
                    <strong>{row.skuCode}</strong>
                    <span className="muted">{row.skuId}</span>
                  </td>
                  <td>
                    <span className="badge neutral">{row.skuStatus}</span>
                  </td>
                  <td>{row.onHand ?? "n/a"}</td>
                  <td>{row.reserved ?? "n/a"}</td>
                  <td>{row.sold ?? "n/a"}</td>
                  <td>
                    <strong>{row.available ?? "n/a"}</strong>
                  </td>
                  <td>{row.inventoryLastEventId ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel admin-panel" aria-labelledby="checkout-title">
        <p className="eyebrow">Checkout intents</p>
        <h2 id="checkout-title">Latest projections</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Checkout</th>
                <th>Buyer</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Order</th>
                <th>Reason</th>
                <th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.checkouts.length > 0 ? (
                dashboard.checkouts.map((row) => (
                  <tr key={row.checkoutIntentId}>
                    <td className="mono">{row.checkoutIntentId}</td>
                    <td>{row.buyerId}</td>
                    <td>
                      <span className="badge neutral">{row.status}</span>
                    </td>
                    <td className="mono">{row.paymentId ?? "n/a"}</td>
                    <td className="mono">{row.orderId ?? "n/a"}</td>
                    <td>{row.rejectionReason ?? row.cancellationReason ?? "n/a"}</td>
                    <td>{row.lastEventId}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7}>No checkout projections yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel admin-panel" aria-labelledby="checkpoint-title">
        <p className="eyebrow">Projection checkpoints</p>
        <h2 id="checkpoint-title">Worker cursor</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Projection</th>
                <th>Last event</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.checkpoints.length > 0 ? (
                dashboard.checkpoints.map((row) => (
                  <tr key={row.projectionName}>
                    <td>{row.projectionName}</td>
                    <td>{row.lastEventId}</td>
                    <td>{row.updatedAt}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3}>No checkpoint rows yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
