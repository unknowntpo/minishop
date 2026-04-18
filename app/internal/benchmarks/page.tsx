import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import Link from "next/link";

export const dynamic = "force-dynamic";

const resultsDirectory = path.join(
  process.cwd(),
  "benchmark-results",
  "checkout-postgres-baseline",
);

type BenchmarkReport = {
  schemaVersion?: number;
  runId: string;
  scenarioName?: string;
  startedAt?: string;
  finishedAt?: string;
  pass?: boolean;
  environment?: {
    runtime?: string;
    appUrl?: string;
    kafka?: string;
    redis?: string;
    paymentProvider?: string;
  };
  scenario?: {
    requestedBuyClicks?: number;
    skuId?: string;
  };
  requestPath?: {
    accepted?: number;
    errors?: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    p99LatencyMs?: number;
    maxLatencyMs?: number;
    requestsPerSecond?: number;
    statusDistribution?: Record<string, number>;
    errorDistribution?: Record<string, number>;
  };
  eventStore?: {
    appendedEvents?: number;
    appendThroughputPerSecond?: number;
  };
  projections?: {
    checkpointLagEvents?: number;
    projectionLagEvents?: number;
    checkoutStatusDistribution?: Record<string, number>;
    skuInventory?: {
      noOversell?: boolean;
      available?: number;
      reserved?: number;
      sold?: number;
    } | null;
  };
};

type BenchmarkRun = BenchmarkReport & {
  artifactFile: string;
};

export default async function InternalBenchmarksPage() {
  const runs = await readBenchmarkRuns();
  const latest = runs[0];
  const trendRuns = runs.slice(0, 10).reverse();

  return (
    <main className="page-shell admin-shell">
      <nav className="admin-nav">
        <Link className="text-link" href="/internal/admin">
          Projection admin
        </Link>
        <Link className="text-link" href="/products">
          Products
        </Link>
      </nav>

      <section className="catalog-hero" aria-labelledby="benchmark-title">
        <p className="eyebrow">Internal benchmark</p>
        <h1 id="benchmark-title">Benchmark results</h1>
        <p className="muted hero-copy">
          Historical checkout-postgres-baseline artifacts for request latency, event append
          throughput, projection lag, and correctness checks.
        </p>
      </section>

      {latest ? (
        <>
          <section className="admin-livebar" aria-label="Latest benchmark status">
            <div>
              <p className="eyebrow">Latest run</p>
              <strong>{latest.runId}</strong>
              <p className="muted admin-livebar-copy">
                {formatDateTime(latest.finishedAt)} · {latest.scenarioName ?? "unknown scenario"}
              </p>
            </div>
            <span className={`badge ${latest.pass ? "success" : "danger"}`}>
              {latest.pass ? "pass" : "failed"}
            </span>
          </section>

          <section className="benchmark-metric-grid" aria-label="Latest benchmark metrics">
            <MetricCard label="accepted" value={formatNumber(latest.requestPath?.accepted)} />
            <MetricCard label="errors" value={formatNumber(latest.requestPath?.errors)} />
            <MetricCard
              label="p95 latency"
              value={`${formatNumber(latest.requestPath?.p95LatencyMs)}ms`}
            />
            <MetricCard
              label="append/sec"
              value={formatNumber(latest.eventStore?.appendThroughputPerSecond)}
            />
            <MetricCard
              label="projection lag"
              value={formatNumber(readProjectionLagEvents(latest))}
            />
            <MetricCard
              label="no oversell"
              value={latest.projections?.skuInventory?.noOversell ? "true" : "false"}
            />
          </section>

          <section className="panel admin-panel" aria-labelledby="trend-title">
            <p className="eyebrow">Trend</p>
            <h2 id="trend-title">Last {trendRuns.length} runs</h2>
            <div className="benchmark-trend-grid">
              <TrendChart
                label="p95 latency"
                unit="ms"
                runs={trendRuns}
                valueFor={(run) => run.requestPath?.p95LatencyMs ?? 0}
              />
              <TrendChart
                label="append throughput"
                unit="/s"
                runs={trendRuns}
                valueFor={(run) => run.eventStore?.appendThroughputPerSecond ?? 0}
              />
              <TrendChart
                label="errors"
                unit=""
                runs={trendRuns}
                valueFor={(run) => run.requestPath?.errors ?? 0}
              />
              <TrendChart
                label="projection lag"
                unit="events"
                runs={trendRuns}
                valueFor={(run) => readProjectionLagEvents(run) ?? 0}
              />
            </div>
          </section>

          <section className="panel admin-panel" aria-labelledby="history-title">
            <p className="eyebrow">History</p>
            <h2 id="history-title">Recent artifacts</h2>
            <p className="muted admin-panel-copy">
              Showing local benchmark result files. These are diagnostic artifacts, not domain
              events.
            </p>
            <div className="admin-table-wrap">
              <table className="admin-table benchmark-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Finished</th>
                    <th>Result</th>
                    <th>Requests</th>
                    <th>Accepted</th>
                    <th>Errors</th>
                    <th>p95</th>
                    <th>Append/sec</th>
                    <th>Lag</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.artifactFile}>
                      <td>
                        <strong>{run.runId}</strong>
                        <span className="muted mono">{run.artifactFile}</span>
                      </td>
                      <td>{formatDateTime(run.finishedAt)}</td>
                      <td>
                        <span className={`badge ${run.pass ? "success" : "danger"}`}>
                          {run.pass ? "pass" : "failed"}
                        </span>
                      </td>
                      <td>{formatNumber(run.scenario?.requestedBuyClicks)}</td>
                      <td>{formatNumber(run.requestPath?.accepted)}</td>
                      <td>{formatNumber(run.requestPath?.errors)}</td>
                      <td>{formatNumber(run.requestPath?.p95LatencyMs)}ms</td>
                      <td>{formatNumber(run.eventStore?.appendThroughputPerSecond)}</td>
                      <td>{formatNumber(readProjectionLagEvents(run))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <section className="panel admin-panel" aria-labelledby="empty-benchmark-title">
          <p className="eyebrow">No artifacts</p>
          <h2 id="empty-benchmark-title">Run the baseline benchmark first.</h2>
          <p className="muted">
            Use <code>pnpm benchmark:checkout:postgres</code>. Results will be written under{" "}
            <code>benchmark-results/checkout-postgres-baseline</code>.
          </p>
        </section>
      )}
    </main>
  );
}

async function readBenchmarkRuns(): Promise<BenchmarkRun[]> {
  try {
    const files = await readdir(resultsDirectory);
    const jsonFiles = files.filter((file) => file.endsWith(".json"));
    const runs = await Promise.all(jsonFiles.map(readBenchmarkRun));

    return runs
      .filter((run): run is BenchmarkRun => run !== null)
      .sort((left, right) => timestampFor(right) - timestampFor(left));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readBenchmarkRun(file: string): Promise<BenchmarkRun | null> {
  try {
    const raw = await readFile(path.join(resultsDirectory, file), "utf8");
    const parsed = JSON.parse(raw) as BenchmarkReport;

    if (!parsed.runId) {
      return null;
    }

    return {
      ...parsed,
      artifactFile: file,
    };
  } catch {
    return null;
  }
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <span className="admin-counter benchmark-metric">
      <strong>{label}</strong>
      <code>{value}</code>
    </span>
  );
}

function TrendChart({
  label,
  unit,
  runs,
  valueFor,
}: {
  label: string;
  unit: string;
  runs: BenchmarkRun[];
  valueFor: (run: BenchmarkRun) => number;
}) {
  const values = runs.map(valueFor);
  const max = Math.max(1, ...values);

  return (
    <article className="benchmark-trend-card">
      <strong>{label}</strong>
      <div className="benchmark-bars" role="img" aria-label={`${label} trend`}>
        {runs.map((run) => {
          const value = valueFor(run);
          const height = Math.max(6, Math.round((value / max) * 96));

          return (
            <span
              className={run.pass ? "benchmark-bar" : "benchmark-bar failed"}
              key={run.artifactFile}
              style={{ height }}
              title={`${run.runId}: ${value}${unit ? ` ${unit}` : ""}`}
            />
          );
        })}
      </div>
      <span className="muted">
        latest {values.at(-1) ?? 0}
        {unit ? ` ${unit}` : ""}
      </span>
    </article>
  );
}

function timestampFor(run: BenchmarkRun) {
  return Date.parse(run.finishedAt ?? run.startedAt ?? "") || 0;
}

function readProjectionLagEvents(run: BenchmarkRun) {
  // Current artifacts use checkpointLagEvents; keep the fallback for early local reports.
  return run.projections?.checkpointLagEvents ?? run.projections?.projectionLagEvents;
}

function formatNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en") : "n/a";
}

function formatDateTime(value: string | undefined) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}
