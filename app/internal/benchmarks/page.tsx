import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import Link from "next/link";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

const benchmarkResultsRoot = path.join(process.cwd(), "benchmark-results");

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
    platform?: string;
    cpuCount?: number;
    cpuModel?: string;
    totalMemoryBytes?: number;
    kafka?: string;
    redis?: string;
    paymentProvider?: string;
  };
  conditions?: {
    hardware?: {
      platform?: string;
      cpuCount?: number;
      cpuModel?: string;
      totalMemoryBytes?: number;
    };
    software?: {
      node?: string;
      nextMode?: string;
      packageManager?: string;
      loadGenerator?: string;
    };
    services?: {
      nextjs?: {
        appUrl?: string;
        instanceCount?: number;
      };
      postgres?: {
        host?: string;
        port?: number;
        database?: string;
        instanceCount?: number;
        poolMax?: number;
      };
      redis?: {
        enabled?: boolean;
        instanceCount?: number;
      };
      kafka?: {
        enabled?: boolean;
        brokerCount?: number;
      };
      paymentProvider?: {
        enabled?: boolean;
      };
    };
    workload?: {
      scenarioName?: string;
      workloadType?: string;
      requestedBuyClicks?: number;
      httpConcurrency?: number;
      skuId?: string;
      cartSkuCount?: number;
      quantityPerIntent?: number;
      projectionBatchSize?: number;
    };
  };
  scenario?: {
    requestedBuyClicks?: number;
    skuId?: string;
    workloadType?: string;
    cartSkuCount?: number;
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
    duplicateReplay?: {
      status?: number;
      idempotentReplay?: boolean;
      checkoutIntentId?: string | null;
    };
  };
  eventStore?: {
    beforeEventCount?: number;
    afterEventCount?: number;
    appendedEvents?: number;
    appendThroughputPerSecond?: number;
    eventTypeDistribution?: Record<string, number>;
  };
  projections?: {
    checkpointLastEventId?: number;
    eventStoreLastEventId?: number;
    checkpointLagEvents?: number;
    projectionLagEvents?: number;
    checkoutProjectionCount?: number;
    checkoutStatusDistribution?: Record<string, number>;
    skuInventory?: {
      noOversell?: boolean;
      onHand?: number;
      available?: number;
      reserved?: number;
      sold?: number;
    } | null;
  };
};

type BenchmarkRun = BenchmarkReport & {
  artifactFile: string;
};

type ScenarioSummary = {
  latestErrors?: number;
  latestFinishedAt?: string;
  latestP95LatencyMs?: number;
  latestPass?: boolean;
  name: string;
  runCount: number;
};

export default async function InternalBenchmarksPage() {
  const runs = await readBenchmarkRuns();
  const latest = runs[0];
  const latestScenarioName = latest?.scenarioName ?? "unknown";
  const latestScenarioRuns = runs.filter((run) => scenarioNameFor(run) === latestScenarioName);
  const trendRuns = latestScenarioRuns.slice(0, 10).reverse();
  const scenarioSummaries = summarizeScenarios(runs);

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
          Local benchmark artifacts across scenarios, with run conditions, evidence, and bottleneck
          signals kept separate from domain events.
        </p>
      </section>

      {latest ? (
        <>
          <section className="admin-livebar" aria-label="Latest benchmark status">
            <div>
              <p className="eyebrow">Latest run</p>
              <strong>{latest.runId}</strong>
              <p className="muted admin-livebar-copy">
                {formatDateTime(latest.finishedAt)} · {scenarioNameFor(latest)}
              </p>
            </div>
            <span className={`badge ${latest.pass ? "success" : "danger"}`}>
              {latest.pass ? "pass" : "failed"}
            </span>
          </section>

          <section className="panel admin-panel" aria-labelledby="flow-title">
            <p className="eyebrow">Data flow</p>
            <h2 id="flow-title">Where each metric comes from</h2>
            <p className="muted admin-panel-copy">
              Benchmarks should map measurements to a system path: load enters an API, accepted work
              appends durable facts, processors build read models, and verifiers inspect durable
              state.
            </p>
            <ol className="benchmark-flow" aria-label="Checkout benchmark data flow">
              <li>
                <span>1</span>
                <strong>Ingress</strong>
                <p className="muted">HTTP/API entry point</p>
                <code>request/sec · p95 · errors</code>
              </li>
              <li>
                <span>2</span>
                <strong>Append</strong>
                <p className="muted">durable event log</p>
                <code>append/sec · event types</code>
              </li>
              <li>
                <span>3</span>
                <strong>Project</strong>
                <p className="muted">read model processor</p>
                <code>checkpoint · lag · status</code>
              </li>
              <li>
                <span>4</span>
                <strong>Verify</strong>
                <p className="muted">domain checks</p>
                <code>no oversell · idempotency</code>
              </li>
            </ol>
          </section>

          <section className="panel admin-panel" aria-labelledby="scenario-title">
            <p className="eyebrow">Scenarios</p>
            <h2 id="scenario-title">Benchmark families</h2>
            <p className="muted admin-panel-copy">
              Each scenario keeps its own comparison lane. Do not compare a single-SKU ingress run
              directly with a cart, reservation, Kafka, or read-model polling benchmark.
            </p>
            <div className="benchmark-scenario-grid">
              {scenarioSummaries.map((scenario) => (
                <article className="benchmark-scenario-card" key={scenario.name}>
                  <strong>{scenario.name}</strong>
                  <span className={`badge ${scenario.latestPass ? "success" : "danger"}`}>
                    {scenario.latestPass ? "latest pass" : "latest failed"}
                  </span>
                  <div className="benchmark-scenario-details">
                    <KeyValueList
                      values={{
                        latest: formatDateTime(scenario.latestFinishedAt),
                        runs: formatNumber(scenario.runCount),
                        "latest p95": `${formatNumber(scenario.latestP95LatencyMs)}ms`,
                        "latest errors": formatNumber(scenario.latestErrors),
                      }}
                    />
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="benchmark-metric-grid" aria-label="Latest benchmark metrics">
            <MetricCard
              label="accepted rate"
              tone={readAcceptedRate(latest) === 1 ? "success" : "warning"}
              value={formatPercent(readAcceptedRate(latest))}
            />
            <MetricCard
              label="request/sec"
              value={formatNumber(latest.requestPath?.requestsPerSecond)}
            />
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
              tone={latest.projections?.skuInventory?.noOversell ? "success" : "danger"}
              value={latest.projections?.skuInventory?.noOversell ? "true" : "false"}
            />
          </section>

          <section className="panel admin-panel" aria-labelledby="conditions-title">
            <p className="eyebrow">Run conditions</p>
            <h2 id="conditions-title">Hardware, software, services</h2>
            <p className="muted admin-panel-copy">
              Benchmark numbers only compare cleanly when the machine, runtime, service topology,
              and workload shape are recorded with the result.
            </p>
            <div className="benchmark-condition-grid">
              <ConditionCard
                title="Hardware"
                values={{
                  cpu: formatCpu(latest),
                  memory: formatBytes(
                    latest.conditions?.hardware?.totalMemoryBytes ??
                      latest.environment?.totalMemoryBytes,
                  ),
                  platform: latest.conditions?.hardware?.platform ?? latest.environment?.platform,
                }}
              />
              <ConditionCard
                title="Software"
                values={{
                  "load generator": latest.conditions?.software?.loadGenerator ?? "node",
                  "next mode": latest.conditions?.software?.nextMode ?? "unknown",
                  node: latest.conditions?.software?.node ?? latest.environment?.runtime,
                  "package manager": latest.conditions?.software?.packageManager ?? "pnpm",
                }}
              />
              <ConditionCard
                title="Services"
                values={{
                  kafka: formatEnabledCount(
                    latest.conditions?.services?.kafka?.enabled,
                    latest.conditions?.services?.kafka?.brokerCount,
                  ),
                  nextjs: `${formatNumber(
                    latest.conditions?.services?.nextjs?.instanceCount ?? 1,
                  )} instance`,
                  postgres: formatPostgresCondition(latest),
                  redis: formatEnabledCount(
                    latest.conditions?.services?.redis?.enabled,
                    latest.conditions?.services?.redis?.instanceCount,
                  ),
                }}
              />
              <ConditionCard
                title="Workload"
                values={{
                  concurrency: formatNumber(latest.conditions?.workload?.httpConcurrency),
                  "projection batch": formatNumber(
                    latest.conditions?.workload?.projectionBatchSize,
                  ),
                  requests: formatNumber(
                    latest.conditions?.workload?.requestedBuyClicks ??
                      latest.scenario?.requestedBuyClicks,
                  ),
                  type:
                    latest.conditions?.workload?.workloadType ??
                    latest.scenario?.workloadType ??
                    "single_sku_direct_buy",
                }}
              />
            </div>
          </section>

          <section className="panel admin-panel" aria-labelledby="evidence-title">
            <p className="eyebrow">Latest evidence</p>
            <h2 id="evidence-title">What this run proves</h2>
            <p className="muted admin-panel-copy">
              The baseline separates load symptoms from domain correctness. A failed HTTP burst can
              still prove durable events, projection catch-up, and no oversell for accepted
              requests.
            </p>
            <div className="benchmark-evidence-grid">
              <EvidenceCard
                badge={latest.requestPath?.errors ? `${latest.requestPath.errors} errors` : "clean"}
                detail={`p95 ${formatNumber(latest.requestPath?.p95LatencyMs)}ms · ${formatNumber(
                  latest.requestPath?.requestsPerSecond,
                )} req/s`}
                summary={`${formatNumber(latest.requestPath?.accepted)} accepted of ${formatNumber(
                  latest.scenario?.requestedBuyClicks,
                )}`}
                title="Request ingress"
                tone={latest.requestPath?.errors ? "danger" : "success"}
              >
                <DistributionList
                  label="HTTP status"
                  values={latest.requestPath?.statusDistribution}
                />
                <DistributionList label="Errors" values={latest.requestPath?.errorDistribution} />
              </EvidenceCard>

              <EvidenceCard
                badge={
                  latest.eventStore?.appendedEvents === latest.requestPath?.accepted
                    ? "accepted = events"
                    : "mismatch"
                }
                detail={`event ids ${formatNumber(latest.eventStore?.beforeEventCount)} -> ${formatNumber(
                  latest.eventStore?.afterEventCount,
                )}`}
                summary={`${formatNumber(latest.eventStore?.appendedEvents)} events appended`}
                title="Durable event store"
                tone={
                  latest.eventStore?.appendedEvents === latest.requestPath?.accepted
                    ? "success"
                    : "danger"
                }
              >
                <DistributionList
                  label="Event types"
                  values={latest.eventStore?.eventTypeDistribution}
                />
              </EvidenceCard>

              <EvidenceCard
                badge={readProjectionLagEvents(latest) === 0 ? "caught up" : "behind"}
                detail={`checkpoint ${formatNumber(
                  latest.projections?.checkpointLastEventId,
                )} of ${formatNumber(latest.projections?.eventStoreLastEventId)}`}
                summary={`${formatNumber(readProjectionLagEvents(latest))} lag events`}
                title="Projection catch-up"
                tone={readProjectionLagEvents(latest) === 0 ? "success" : "warning"}
              >
                <DistributionList
                  label="Checkout status"
                  values={latest.projections?.checkoutStatusDistribution}
                />
              </EvidenceCard>

              <EvidenceCard
                badge={
                  latest.projections?.skuInventory?.noOversell ? "no oversell" : "inventory risk"
                }
                detail={`on_hand ${formatNumber(
                  latest.projections?.skuInventory?.onHand,
                )} · reserved ${formatNumber(
                  latest.projections?.skuInventory?.reserved,
                )} · sold ${formatNumber(latest.projections?.skuInventory?.sold)}`}
                summary={`available ${formatNumber(latest.projections?.skuInventory?.available)}`}
                title="Inventory and idempotency"
                tone={latest.projections?.skuInventory?.noOversell ? "success" : "danger"}
              >
                <KeyValueList
                  values={{
                    "duplicate status": formatNumber(latest.requestPath?.duplicateReplay?.status),
                    "idempotent replay": latest.requestPath?.duplicateReplay?.idempotentReplay
                      ? "true"
                      : "false",
                    workload: latest.scenario?.workloadType ?? "single_sku_direct_buy",
                    "cart sku count": formatNumber(latest.scenario?.cartSkuCount ?? 1),
                    sku: latest.scenario?.skuId ?? "n/a",
                  }}
                />
              </EvidenceCard>
            </div>
          </section>

          <section className="panel admin-panel" aria-labelledby="trend-title">
            <p className="eyebrow">Trend</p>
            <h2 id="trend-title">
              {latestScenarioName} signals across {trendRuns.length} runs
            </h2>
            <p className="muted admin-panel-copy">
              Trend is scenario-scoped for regression hunting. Compare runs with similar conditions
              first, then inspect history when hardware, service count, or workload changes.
            </p>
            <div className="benchmark-trend-grid">
              <TrendChart
                label="accepted rate"
                runs={trendRuns}
                unit="%"
                valueFor={(run) => Math.round(readAcceptedRate(run) * 100)}
              />
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
                    <th>Scenario</th>
                    <th>Finished</th>
                    <th>Result</th>
                    <th>Conditions</th>
                    <th>Requests</th>
                    <th>Accepted</th>
                    <th>Errors</th>
                    <th>p95</th>
                    <th>Append/sec</th>
                    <th>Lag</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.artifactFile}>
                      <td>
                        <strong>{run.runId}</strong>
                        <span className="muted mono">{run.artifactFile}</span>
                      </td>
                      <td>{scenarioNameFor(run)}</td>
                      <td>{formatDateTime(run.finishedAt)}</td>
                      <td>
                        <span className={`badge ${run.pass ? "success" : "danger"}`}>
                          {run.pass ? "pass" : "failed"}
                        </span>
                      </td>
                      <td>{formatConditionSummary(run)}</td>
                      <td>{formatNumber(run.scenario?.requestedBuyClicks)}</td>
                      <td>{formatNumber(run.requestPath?.accepted)}</td>
                      <td>{formatNumber(run.requestPath?.errors)}</td>
                      <td>{formatNumber(run.requestPath?.p95LatencyMs)}ms</td>
                      <td>{formatNumber(run.eventStore?.appendThroughputPerSecond)}</td>
                      <td>{formatNumber(readProjectionLagEvents(run))}</td>
                      <td>
                        <StatusSummary values={run.projections?.checkoutStatusDistribution} />
                      </td>
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
            <code>benchmark-results/&lt;scenario&gt;</code>.
          </p>
        </section>
      )}
    </main>
  );
}

async function readBenchmarkRuns(): Promise<BenchmarkRun[]> {
  try {
    const entries = await readdir(benchmarkResultsRoot, { withFileTypes: true });
    const artifactFiles = entries.flatMap((entry) => {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        return [entry.name];
      }

      if (!entry.isDirectory()) {
        return [];
      }

      return [];
    });
    const scenarioFiles = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const files = await readdir(path.join(benchmarkResultsRoot, entry.name));

          return files
            .filter((file) => file.endsWith(".json"))
            .map((file) => path.join(entry.name, file));
        }),
    );
    const runs = await Promise.all(
      [...artifactFiles, ...scenarioFiles.flat()].map(readBenchmarkRun),
    );

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
    const raw = await readFile(path.join(benchmarkResultsRoot, file), "utf8");
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

function summarizeScenarios(runs: BenchmarkRun[]): ScenarioSummary[] {
  const grouped = new Map<string, BenchmarkRun[]>();

  for (const run of runs) {
    const name = scenarioNameFor(run);
    grouped.set(name, [...(grouped.get(name) ?? []), run]);
  }

  return [...grouped.entries()]
    .map(([name, scenarioRuns]) => {
      const latest = scenarioRuns[0];

      return {
        latestErrors: latest?.requestPath?.errors,
        latestFinishedAt: latest?.finishedAt,
        latestP95LatencyMs: latest?.requestPath?.p95LatencyMs,
        latestPass: latest?.pass,
        name,
        runCount: scenarioRuns.length,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

type Tone = "success" | "warning" | "danger";

function MetricCard({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <span className={`admin-counter benchmark-metric${tone ? ` ${tone}` : ""}`}>
      <strong>{label}</strong>
      <code>{value}</code>
    </span>
  );
}

function EvidenceCard({
  badge,
  children,
  detail,
  summary,
  title,
  tone,
}: {
  badge: string;
  children: ReactNode;
  detail: string;
  summary: string;
  title: string;
  tone: Tone;
}) {
  return (
    <article className="benchmark-evidence-card">
      <div className="benchmark-evidence-header">
        <strong>{title}</strong>
        <span className={`badge ${tone}`}>{badge}</span>
      </div>
      <code>{summary}</code>
      <p className="muted">{detail}</p>
      {children}
    </article>
  );
}

function ConditionCard({
  title,
  values,
}: {
  title: string;
  values: Record<string, string | undefined>;
}) {
  return (
    <article className="benchmark-condition-card">
      <strong>{title}</strong>
      <KeyValueList
        values={Object.fromEntries(
          Object.entries(values).map(([label, value]) => [label, value ?? "n/a"]),
        )}
      />
    </article>
  );
}

function DistributionList({
  label,
  values,
}: {
  label: string;
  values: Record<string, number> | undefined;
}) {
  const entries = Object.entries(values ?? {});
  const total = entries.reduce((sum, [, value]) => sum + value, 0);

  if (entries.length === 0) {
    return (
      <div className="benchmark-distribution">
        <strong>{label}</strong>
        <span className="muted">n/a</span>
      </div>
    );
  }

  return (
    <div className="benchmark-distribution">
      <strong>{label}</strong>
      {entries.map(([key, value]) => {
        const percentage = total > 0 ? value / total : 0;

        return (
          <div className="benchmark-distribution-row" key={key}>
            <span>{key}</span>
            <div className="benchmark-distribution-track" aria-hidden="true">
              <span style={{ width: `${Math.max(2, Math.round(percentage * 100))}%` }} />
            </div>
            <code>{formatNumber(value)}</code>
          </div>
        );
      })}
    </div>
  );
}

function KeyValueList({ values }: { values: Record<string, string> }) {
  return (
    <dl className="benchmark-kv-list">
      {Object.entries(values).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatusSummary({ values }: { values: Record<string, number> | undefined }) {
  const entries = Object.entries(values ?? {});

  if (entries.length === 0) {
    return <span className="muted">n/a</span>;
  }

  return (
    <span className="benchmark-status-summary">
      {entries.map(([status, count]) => (
        <span className="badge neutral" key={status}>
          {status}: {formatNumber(count)}
        </span>
      ))}
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

function scenarioNameFor(run: BenchmarkRun) {
  return run.scenarioName ?? run.conditions?.workload?.scenarioName ?? "unknown";
}

function formatConditionSummary(run: BenchmarkRun) {
  const mode = run.conditions?.software?.nextMode ?? "unknown mode";
  const appInstances = formatNumber(run.conditions?.services?.nextjs?.instanceCount ?? 1);
  const pgInstances = formatNumber(run.conditions?.services?.postgres?.instanceCount ?? 1);
  const pgPool = formatNumber(run.conditions?.services?.postgres?.poolMax);
  const concurrency = formatNumber(run.conditions?.workload?.httpConcurrency);

  return `${mode} · app ${appInstances} · pg ${pgInstances} · pool ${pgPool} · c ${concurrency}`;
}

function formatCpu(run: BenchmarkRun) {
  const count = run.conditions?.hardware?.cpuCount ?? run.environment?.cpuCount;
  const model = run.conditions?.hardware?.cpuModel ?? run.environment?.cpuModel;

  if (!count && !model) {
    return "n/a";
  }

  return `${formatNumber(count)} core · ${model ?? "unknown"}`;
}

function formatPostgresCondition(run: BenchmarkRun) {
  const postgres = run.conditions?.services?.postgres;

  if (!postgres) {
    return "postgresql";
  }

  return `${postgres.database ?? "n/a"} @ ${postgres.host ?? "n/a"}:${postgres.port ?? "n/a"} · ${formatNumber(
    postgres.instanceCount,
  )} instance · pool ${formatNumber(postgres.poolMax)}`;
}

function formatEnabledCount(enabled: boolean | undefined, count: number | undefined) {
  if (!enabled) {
    return "disabled";
  }

  return `${formatNumber(count)} instance`;
}

function readAcceptedRate(run: BenchmarkRun) {
  const requested = run.scenario?.requestedBuyClicks ?? 0;
  const accepted = run.requestPath?.accepted ?? 0;

  return requested > 0 ? accepted / requested : 0;
}

function formatPercent(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : "n/a";
}

function formatNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en") : "n/a";
}

function formatBytes(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  const gib = value / 1024 ** 3;

  return `${gib.toFixed(1)} GiB`;
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
