"use client";

import { useEffect, useMemo, useState } from "react";

import type { AdminDashboardViewModel } from "@/src/presentation/view-models/admin-dashboard";

type LiveAdminDashboard = AdminDashboardViewModel & {
  refreshedAt: string;
};

export function AdminDashboardView({
  initialDashboard,
}: {
  initialDashboard: AdminDashboardViewModel;
}) {
  const [dashboard, setDashboard] = useState<LiveAdminDashboard>({
    ...initialDashboard,
    refreshedAt: new Date().toISOString(),
  });
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const response = await fetch("/api/internal/admin/dashboard", {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Dashboard refresh failed with ${response.status}.`);
        }

        const nextDashboard = (await response.json()) as LiveAdminDashboard;

        if (!cancelled) {
          setDashboard(nextDashboard);
          setLastError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setLastError(error instanceof Error ? error.message : "Dashboard refresh failed.");
        }
      }
    }

    const interval = window.setInterval(refresh, 1000);
    void refresh();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const checkoutStatusCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const row of dashboard.checkouts) {
      counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    }

    return Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [dashboard.checkouts]);

  return (
    <>
      <section className="admin-livebar" aria-label="Admin dashboard live status">
        <div>
          <p className="eyebrow">Live projection dashboard</p>
          <strong>Polling every second</strong>
          <p className="muted admin-livebar-copy">
            Last refresh {formatTime(dashboard.refreshedAt)}
          </p>
        </div>
        <span className="badge neutral">realtime polling</span>
      </section>

      {lastError ? <p className="checkout-demo-status error">{lastError}</p> : null}

      <section className="admin-product-grid" aria-label="Product projection cards">
        {dashboard.products.map((row) => (
          <article className="admin-product-card" key={row.skuId}>
            <div className="admin-product-card-header">
              <div>
                <p className="eyebrow">{row.productStatus}</p>
                <h2>{row.productName}</h2>
                <p className="muted admin-product-copy">
                  {row.skuCode} · {row.skuId}
                </p>
              </div>
              <span className="badge neutral">{row.skuStatus}</span>
            </div>

            <div className="admin-counter-grid">
              <Metric label="on_hand" value={row.onHand} />
              <Metric label="reserved" value={row.reserved} tone="warning" />
              <Metric label="sold" value={row.sold} tone="success" />
              <Metric label="available" value={row.available} tone="strong" />
            </div>

            <div className="admin-product-footer">
              <span>
                <strong>last event</strong>
                <code>{row.inventoryLastEventId ?? "n/a"}</code>
              </span>
              <span>
                <strong>version</strong>
                <code>{row.inventoryAggregateVersion ?? "n/a"}</code>
              </span>
            </div>
          </article>
        ))}
      </section>

      <section className="panel admin-panel" aria-labelledby="checkout-summary-title">
        <p className="eyebrow">Checkout intents</p>
        <h2 id="checkout-summary-title">Latest projection states</h2>
        <div className="admin-status-pills">
          {checkoutStatusCounts.length > 0 ? (
            checkoutStatusCounts.map(([status, count]) => (
              <span className="badge neutral" key={status}>
                {status}: {count}
              </span>
            ))
          ) : (
            <span className="muted">No checkout projections yet.</span>
          )}
        </div>
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
    </>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone?: "strong" | "success" | "warning";
}) {
  return (
    <span className={`admin-counter ${tone ?? ""}`}>
      <strong>{label}</strong>
      <code>{value ?? "n/a"}</code>
    </span>
  );
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
