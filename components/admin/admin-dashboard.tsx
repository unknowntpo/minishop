"use client";

import { useEffect, useState } from "react";

import type { AdminDashboardViewModel } from "@/src/presentation/view-models/admin-dashboard";

type LiveAdminDashboard = AdminDashboardViewModel & {
  refreshedAt: string;
};

export function AdminDashboardView({ initialDashboard }: { initialDashboard: LiveAdminDashboard }) {
  const [dashboard, setDashboard] = useState<LiveAdminDashboard>(initialDashboard);
  const [lastError, setLastError] = useState<string | null>(null);
  const [savingSkuId, setSavingSkuId] = useState<string | null>(null);
  const [stockInputs, setStockInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialDashboard.products.map((row) => [
        row.skuId,
        String(row.seckillStockLimit ?? row.seckillDefaultStock ?? ""),
      ]),
    ),
  );

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
          setStockInputs((current) => ({
            ...Object.fromEntries(
              nextDashboard.products.map((row) => [
                row.skuId,
                current[row.skuId] ??
                  String(row.seckillStockLimit ?? row.seckillDefaultStock ?? ""),
              ]),
            ),
          }));
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
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <span className="badge neutral">{row.skuStatus}</span>
                {row.seckillCandidate ? <span className="badge neutral">seckill candidate</span> : null}
                {row.seckillEnabled ? <span className="badge warning">秒殺活動</span> : null}
              </div>
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

            <div className="admin-product-footer">
              <span>
                <strong>seckill stock</strong>
                <code>{row.seckillStockLimit ?? row.seckillDefaultStock ?? "n/a"}</code>
              </span>
              <span>
                <strong>seckill result</strong>
                <code>
                  ok {row.seckillReservedCount} / reject {row.seckillRejectedCount}
                </code>
              </span>
              <span>
                <strong>last seckill</strong>
                <code>{row.seckillLastProcessedAt ?? "n/a"}</code>
              </span>
            </div>

            {row.seckillCandidate ? (
              <form
                className="admin-product-footer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void updateSeckill(row.skuId, true);
                }}
              >
                <label style={{ display: "grid", gap: "0.35rem" }}>
                  <strong>活動 stock</strong>
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={stockInputs[row.skuId] ?? ""}
                    onChange={(event) =>
                      setStockInputs((current) => ({
                        ...current,
                        [row.skuId]: event.target.value,
                      }))
                    }
                    disabled={savingSkuId === row.skuId}
                  />
                </label>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "end" }}>
                  <button
                    className="button primary"
                    type="submit"
                    disabled={savingSkuId === row.skuId}
                  >
                    開始秒殺
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={savingSkuId === row.skuId || !row.seckillEnabled}
                    onClick={() => void updateSeckill(row.skuId, false)}
                  >
                    停止秒殺
                  </button>
                </div>
              </form>
            ) : null}
          </article>
        ))}
      </section>

      <section className="panel admin-panel" aria-labelledby="checkout-summary-title">
        <p className="eyebrow">Checkout intents</p>
        <h2 id="checkout-summary-title">Latest projection states</h2>
        <p className="muted admin-panel-copy">
          Showing the latest {dashboard.checkoutSummary.displayedLimit} records only. Total
          projected checkouts: {dashboard.checkoutSummary.totalCount}.
        </p>
        <div className="admin-status-pills">
          {dashboard.checkoutSummary.statusCounts.length > 0 ? (
            dashboard.checkoutSummary.statusCounts.map(({ status, count }) => (
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

  async function updateSeckill(skuId: string, enabled: boolean) {
    const stockLimit = Number.parseInt(stockInputs[skuId] ?? "", 10);

    if (enabled && (!Number.isInteger(stockLimit) || stockLimit <= 0)) {
      setLastError("活動 stock 必須是大於 0 的整數。");
      return;
    }

    setSavingSkuId(skuId);

    try {
      const response = await fetch("/api/internal/admin/seckill", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          skuId,
          enabled,
          stockLimit: enabled ? stockLimit : null,
        }),
      });

      if (!response.ok) {
        throw new Error(`Seckill update failed with ${response.status}.`);
      }

      const dashboardResponse = await fetch("/api/internal/admin/dashboard", {
        cache: "no-store",
      });

      if (!dashboardResponse.ok) {
        throw new Error(`Dashboard refresh failed with ${dashboardResponse.status}.`);
      }

      const nextDashboard = (await dashboardResponse.json()) as LiveAdminDashboard;
      setDashboard(nextDashboard);
      setStockInputs((current) => ({
        ...current,
        [skuId]: String(
          nextDashboard.products.find((product) => product.skuId === skuId)?.seckillStockLimit ??
            nextDashboard.products.find((product) => product.skuId === skuId)?.seckillDefaultStock ??
            "",
        ),
      }));
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Seckill update failed.");
    } finally {
      setSavingSkuId(null);
    }
  }
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
