import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import Link from "next/link";

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
      architectureLane?: string;
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

type CapacityPoint = {
  acceptedRate: number;
  appendPerSecond: number;
  concurrency: number;
  errors: number;
  lag: number;
  p95LatencyMs: number;
  pass: boolean;
};

type ArchitectureLane = {
  bottleneck: string;
  latestFinishedAt?: string;
  latestStatus: "healthy" | "warning" | "danger";
  name: string;
  points: CapacityPoint[];
  safeConcurrency: number | null;
  source: "artifact" | "preview";
};

const previewArchitectureLanes: Record<string, ArchitectureLane[]> = {
  "checkout-postgres-baseline": [
    {
      bottleneck: "projection catch-up at higher ingress",
      latestFinishedAt: "preview",
      latestStatus: "warning",
      name: "postgres-worker-preview",
      points: [
        {
          acceptedRate: 1,
          appendPerSecond: 210,
          concurrency: 50,
          errors: 0,
          lag: 0,
          p95LatencyMs: 120,
          pass: true,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 395,
          concurrency: 100,
          errors: 0,
          lag: 0,
          p95LatencyMs: 180,
          pass: true,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 830,
          concurrency: 250,
          errors: 0,
          lag: 0,
          p95LatencyMs: 310,
          pass: true,
        },
        {
          acceptedRate: 0.998,
          appendPerSecond: 1420,
          concurrency: 500,
          errors: 1,
          lag: 0,
          p95LatencyMs: 520,
          pass: true,
        },
        {
          acceptedRate: 0.992,
          appendPerSecond: 1990,
          concurrency: 1000,
          errors: 8,
          lag: 14,
          p95LatencyMs: 980,
          pass: true,
        },
      ],
      safeConcurrency: 500,
      source: "preview",
    },
    {
      bottleneck: "event relay and read-model fan-out",
      latestFinishedAt: "preview",
      latestStatus: "healthy",
      name: "postgres-kafka-cache-preview",
      points: [
        {
          acceptedRate: 1,
          appendPerSecond: 240,
          concurrency: 50,
          errors: 0,
          lag: 0,
          p95LatencyMs: 90,
          pass: true,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 470,
          concurrency: 100,
          errors: 0,
          lag: 0,
          p95LatencyMs: 130,
          pass: true,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 1120,
          concurrency: 250,
          errors: 0,
          lag: 0,
          p95LatencyMs: 220,
          pass: true,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 2140,
          concurrency: 500,
          errors: 0,
          lag: 0,
          p95LatencyMs: 340,
          pass: true,
        },
        {
          acceptedRate: 0.998,
          appendPerSecond: 3280,
          concurrency: 1000,
          errors: 2,
          lag: 0,
          p95LatencyMs: 620,
          pass: true,
        },
      ],
      safeConcurrency: 1000,
      source: "preview",
    },
  ],
};

export default async function InternalBenchmarksPage({
  searchParams,
}: {
  searchParams?: Promise<{ scenario?: string }>;
}) {
  const params = await searchParams;
  const runs = await readBenchmarkRuns();
  const latest = runs[0];
  const scenarioSummaries = summarizeScenarios(runs);
  const requestedScenarioName = params?.scenario;
  const selectedScenarioName = scenarioSummaries.find(
    (scenario) => scenario.name === requestedScenarioName,
  )?.name;
  const selectedScenarioRuns = selectedScenarioName
    ? runs.filter((run) => scenarioNameFor(run) === selectedScenarioName)
    : [];
  const comparisonRuns = selectedScenarioRuns.slice(0, 10).reverse();
  const capacityScenarioName =
    selectedScenarioName ?? (latest ? scenarioNameFor(latest) : undefined);
  const architectureLanes = capacityScenarioName
    ? buildArchitectureLanes(runs, capacityScenarioName)
    : [];

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
              Click a scenario to expand its run comparison below. Click the selected scenario again
              to collapse it. Future cart, reservation, Kafka, or read-model polling benchmarks will
              appear as separate families.
            </p>
            <div className="benchmark-scenario-grid">
              {scenarioSummaries.map((scenario) => {
                const isSelected = scenario.name === selectedScenarioName;
                const href = isSelected
                  ? "/internal/benchmarks"
                  : `/internal/benchmarks?scenario=${encodeURIComponent(scenario.name)}`;

                return (
                  <Link
                    className={`benchmark-scenario-card${isSelected ? " selected" : ""}`}
                    href={href}
                    key={scenario.name}
                    scroll={false}
                    aria-expanded={isSelected}
                    aria-label={`${isSelected ? "Collapse" : "Expand"} ${scenario.name} run comparison`}
                  >
                    <strong title={scenarioDescription(scenario.name)}>{scenario.name}</strong>
                    <span className="benchmark-scenario-badges">
                      <span className={`badge ${scenario.latestPass ? "success" : "danger"}`}>
                        {scenario.latestPass ? "latest pass" : "latest failed"}
                      </span>
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
                  </Link>
                );
              })}
            </div>
            {selectedScenarioName ? (
              <RunComparison scenarioName={selectedScenarioName} runs={comparisonRuns} />
            ) : null}
          </section>

          {capacityScenarioName ? (
            <section className="panel admin-panel" aria-labelledby="capacity-title">
              <p className="eyebrow">Capacity</p>
              <h2 id="capacity-title">Architecture lane comparison</h2>
              <p className="muted admin-panel-copy">
                Compare concurrency curves inside one benchmark family. Artifact lanes are real
                measurements. Preview lanes are mock future architectures so the dashboard can be
                tuned before Kafka, workers, or cache layers exist.
              </p>
              <div className="capacity-lane-grid">
                {architectureLanes.map((lane) => (
                  <article className="capacity-lane-card" key={lane.name}>
                    <div className="capacity-lane-header">
                      <strong title={lane.name}>{lane.name}</strong>
                      <span className="benchmark-scenario-badges">
                        <span
                          className={`badge ${
                            lane.latestStatus === "danger"
                              ? "danger"
                              : lane.latestStatus === "warning"
                                ? "warning"
                                : "success"
                          }`}
                        >
                          {lane.latestStatus}
                        </span>
                        <span
                          className={`badge ${lane.source === "preview" ? "neutral" : "success"}`}
                        >
                          {lane.source === "preview" ? "preview" : "artifact"}
                        </span>
                      </span>
                    </div>
                    <KeyValueList
                      values={{
                        "safe concurrency":
                          lane.safeConcurrency === null
                            ? "not reached"
                            : formatNumber(lane.safeConcurrency),
                        bottleneck: lane.bottleneck,
                        points: formatNumber(lane.points.length),
                        latest:
                          lane.source === "preview"
                            ? "preview"
                            : formatDateTime(lane.latestFinishedAt),
                      }}
                    />
                  </article>
                ))}
              </div>

              <div className="capacity-chart-grid">
                <LaneMetricChart
                  description="How much of the intended burst the ingress path actually accepted."
                  label="accepted rate"
                  lanes={architectureLanes}
                  unit="%"
                  valueFor={(point) => point.acceptedRate * 100}
                />
                <LaneMetricChart
                  description="Tail latency at the checkout intent API boundary."
                  label="p95 latency"
                  lanes={architectureLanes}
                  unit="ms"
                  valueFor={(point) => point.p95LatencyMs}
                />
                <LaneMetricChart
                  description="Projection distance from durable events after processing completes."
                  label="projection lag"
                  lanes={architectureLanes}
                  unit="events"
                  valueFor={(point) => point.lag}
                />
              </div>
            </section>
          ) : null}

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

function RunComparison({ scenarioName, runs }: { scenarioName: string; runs: BenchmarkRun[] }) {
  return (
    <section className="benchmark-run-comparison" aria-labelledby="comparison-title">
      <p className="eyebrow">Run comparison</p>
      <h3 id="comparison-title">Selected scenario: {scenarioName}</h3>
      <p className="muted admin-panel-copy">
        This compares runs from the scenario selected in Benchmark families. Conditions are tags
        beside each run; use the plots for signal, then use the evidence table to explain why a run
        moved.
      </p>

      <div className="benchmark-run-tags">
        {runs.map((run, index) => (
          <span className="benchmark-run-tag" key={run.artifactFile}>
            <strong>r{index + 1}</strong>
            <span className={`badge ${run.pass ? "success" : "danger"}`}>
              {run.pass ? "pass" : "fail"}
            </span>
            <code>{formatConditionSummary(run)}</code>
          </span>
        ))}
      </div>

      <div className="benchmark-comparison-grid">
        <ComparisonChart
          definition="Accepted requests divided by requested Buy clicks. It tells you how much of the intended load was admitted by the API."
          calculation="accepted / requestedBuyClicks * 100"
          interpretation="Aim to stay close to 100%. A drop means the ingress path is rejecting or losing work before durable append and projection verification."
          label="accepted rate"
          runs={runs}
          unit="%"
          valueFor={(run) => Math.round(readAcceptedRate(run) * 100)}
        />
        <ComparisonChart
          definition="HTTP requests completed per second by the benchmark client during the request burst."
          calculation="total requests / request burst duration seconds"
          interpretation="Read this with accepted rate and errors. Higher is only better when success remains stable."
          label="request/sec"
          runs={runs}
          unit="/s"
          valueFor={(run) => run.requestPath?.requestsPerSecond ?? 0}
        />
        <ComparisonChart
          definition="95th percentile request latency for the checkout intent API path. This is ingress latency, not end-to-end reservation or payment latency."
          calculation="95th percentile of per-request latency samples"
          interpretation="This shows the slow tail. Spikes usually indicate queueing, database pressure, or server saturation."
          label="p95 latency"
          runs={runs}
          unit="ms"
          valueFor={(run) => run.requestPath?.p95LatencyMs ?? 0}
        />
        <ComparisonChart
          definition="Durable event append throughput. It tracks how quickly accepted work became event_store facts."
          calculation="appendedEvents / request burst duration seconds"
          interpretation="Compare this with request/sec. If append/sec lags far behind ingress, persistence is the bottleneck."
          label="append/sec"
          runs={runs}
          unit="/s"
          valueFor={(run) => run.eventStore?.appendThroughputPerSecond ?? 0}
        />
        <ComparisonChart
          definition="Request failures observed by the benchmark client. HTTP status 0 usually means no response was received."
          calculation="requestedBuyClicks - accepted"
          interpretation="Use this with HTTP status and error distributions below to separate transport failure from application rejection."
          label="errors"
          runs={runs}
          unit=""
          valueFor={(run) => run.requestPath?.errors ?? 0}
        />
        <ComparisonChart
          definition="Distance between event_store position and projection checkpoint after processing."
          calculation="eventStoreLastEventId - checkpointLastEventId"
          interpretation="Zero means projections caught up by the end of verification. Sustained non-zero lag means read models are behind writes."
          label="projection lag"
          runs={runs}
          unit="events"
          valueFor={(run) => readProjectionLagEvents(run) ?? 0}
        />
      </div>

      <RunEvidenceComparison runs={runs} />
    </section>
  );
}

function ComparisonChart({
  calculation,
  definition,
  interpretation,
  label,
  runs,
  unit,
  valueFor,
}: {
  calculation: string;
  definition: string;
  interpretation: string;
  label: string;
  runs: BenchmarkRun[];
  unit: string;
  valueFor: (run: BenchmarkRun) => number;
}) {
  const values = runs.map(valueFor);
  const max = Math.max(1, ...values);

  return (
    <article className="benchmark-comparison-card">
      <strong>
        <span>{label}</span>
        <button
          type="button"
          aria-label={`${label}. Definition: ${definition} Calculation: ${calculation} Interpretation: ${interpretation}`}
          className="benchmark-info"
          title={`Definition: ${definition}\nCalculation: ${calculation}\nInterpretation: ${interpretation}`}
        >
          ?
          <span className="benchmark-info-card">
            <strong>{label}</strong>
            <span className="benchmark-info-row">
              <em>Definition</em>
              <span>{definition}</span>
            </span>
            <span className="benchmark-info-row">
              <em>Calculation</em>
              <code>{calculation}</code>
            </span>
            <span className="benchmark-info-row">
              <em>Interpretation</em>
              <span>{interpretation}</span>
            </span>
          </span>
        </button>
      </strong>
      <div className="benchmark-plot" role="img" aria-label={`${label} comparison`}>
        {runs.map((run, index) => {
          const value = valueFor(run);
          const height = Math.max(6, Math.round((value / max) * 120));

          return (
            <span className="benchmark-plot-column" key={run.artifactFile}>
              <span
                className={run.pass ? "benchmark-plot-bar" : "benchmark-plot-bar failed"}
                style={{ height }}
                title={`r${index + 1} ${run.runId}: ${value}${unit ? ` ${unit}` : ""}\n${formatConditionSummary(
                  run,
                )}\nHTTP ${formatDistribution(run.requestPath?.statusDistribution)}`}
              />
              <code>r{index + 1}</code>
            </span>
          );
        })}
      </div>
      <span className="muted">
        latest {formatNumber(values.at(-1))}
        {unit ? ` ${unit}` : ""}
      </span>
    </article>
  );
}

function RunEvidenceComparison({ runs }: { runs: BenchmarkRun[] }) {
  return (
    <div className="admin-table-wrap benchmark-evidence-compare">
      <div className="benchmark-evidence-purpose">
        <strong>Diagnostic evidence matrix</strong>
        <span>
          These are categorical distributions and invariant checks, so a compact table explains the
          plots better than another chart.
        </span>
      </div>
      <table className="admin-table benchmark-evidence-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>HTTP status</th>
            <th>Errors</th>
            <th>Event types</th>
            <th>Checkout status</th>
            <th>Inventory</th>
            <th>Idempotency</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run, index) => (
            <tr key={run.artifactFile}>
              <td>
                <strong>r{index + 1}</strong>
                <span className="muted mono">{shortRunId(run.runId)}</span>
              </td>
              <td>{formatDistribution(run.requestPath?.statusDistribution)}</td>
              <td>{formatDistribution(run.requestPath?.errorDistribution)}</td>
              <td>{formatDistribution(run.eventStore?.eventTypeDistribution)}</td>
              <td>{formatDistribution(run.projections?.checkoutStatusDistribution)}</td>
              <td>{formatInventorySummary(run)}</td>
              <td>{formatIdempotencySummary(run)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LaneMetricChart({
  description,
  label,
  lanes,
  unit,
  valueFor,
}: {
  description: string;
  label: string;
  lanes: ArchitectureLane[];
  unit: string;
  valueFor: (point: CapacityPoint) => number;
}) {
  const allSteps = uniqueSortedNumbers(
    lanes.flatMap((lane) => lane.points.map((point) => point.concurrency)),
  );
  const maxValue = Math.max(1, ...lanes.flatMap((lane) => lane.points.map(valueFor)));
  const colors = ["#2e9462", "#b75f4b", "#2f6fd6", "#c48326"];

  return (
    <article className="capacity-chart-card">
      <div className="capacity-chart-header">
        <div>
          <strong>{label}</strong>
          <p className="muted">{description}</p>
        </div>
      </div>
      <svg
        className="capacity-chart"
        viewBox="0 0 360 200"
        role="img"
        aria-label={`${label} by concurrency and architecture lane`}
      >
        <line className="capacity-axis" x1="40" y1="12" x2="40" y2="164" />
        <line className="capacity-axis" x1="40" y1="164" x2="344" y2="164" />
        {lanes.map((lane, laneIndex) => {
          const color = colors[laneIndex % colors.length];
          const points = lane.points
            .sort((left, right) => left.concurrency - right.concurrency)
            .map((point, pointIndex, orderedPoints) => {
              const x =
                orderedPoints.length === 1
                  ? 192
                  : 40 + (pointIndex / (orderedPoints.length - 1)) * 304;
              const y = 164 - (valueFor(point) / maxValue) * 132;

              return { point, x, y };
            });
          const polyline = points.map(({ x, y }) => `${x},${y}`).join(" ");

          return (
            <g key={lane.name}>
              <polyline
                className={`capacity-line${lane.source === "preview" ? " preview" : ""}`}
                points={polyline}
                stroke={color}
              />
              {points.map(({ point, x, y }) => (
                <g key={`${lane.name}-${point.concurrency}`}>
                  <circle
                    className={`capacity-point${lane.source === "preview" ? " preview" : ""}`}
                    cx={x}
                    cy={y}
                    fill={color}
                    r={4}
                  />
                  <title>
                    {`${lane.name} · c${point.concurrency} · ${formatNumber(valueFor(point))}${unit ? ` ${unit}` : ""}`}
                  </title>
                </g>
              ))}
            </g>
          );
        })}
        {allSteps.map((step, index) => {
          const x = allSteps.length === 1 ? 192 : 40 + (index / (allSteps.length - 1)) * 304;

          return (
            <text className="capacity-axis-label" key={step} x={x} y="186">
              {step}
            </text>
          );
        })}
      </svg>
      <div className="capacity-legend">
        {lanes.map((lane, laneIndex) => {
          const color = colors[laneIndex % colors.length];

          return (
            <span className="capacity-legend-item" key={lane.name}>
              <span
                className={`capacity-legend-swatch${lane.source === "preview" ? " preview" : ""}`}
                style={{ backgroundColor: color }}
              />
              <span>{lane.name}</span>
            </span>
          );
        })}
      </div>
    </article>
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

function architectureLaneFor(run: BenchmarkRun) {
  return run.conditions?.workload?.architectureLane ?? scenarioNameFor(run);
}

function concurrencyFor(run: BenchmarkRun) {
  return run.conditions?.workload?.httpConcurrency ?? run.scenario?.requestedBuyClicks ?? 0;
}

function buildArchitectureLanes(runs: BenchmarkRun[], scenarioName: string): ArchitectureLane[] {
  const scenarioRuns = runs.filter((run) => scenarioNameFor(run) === scenarioName);
  const grouped = new Map<string, Map<number, BenchmarkRun>>();

  for (const run of scenarioRuns) {
    const laneName = architectureLaneFor(run);
    const concurrency = concurrencyFor(run);

    if (concurrency <= 0) {
      continue;
    }

    const laneRuns = grouped.get(laneName) ?? new Map<number, BenchmarkRun>();
    const existing = laneRuns.get(concurrency);

    if (!existing || timestampFor(run) > timestampFor(existing)) {
      laneRuns.set(concurrency, run);
    }

    grouped.set(laneName, laneRuns);
  }

  const artifactLanes = [...grouped.entries()].map(([name, laneRuns]) => {
    const orderedRuns = [...laneRuns.values()].sort(
      (left, right) => concurrencyFor(left) - concurrencyFor(right),
    );
    const points = orderedRuns.map((run) => ({
      acceptedRate: readAcceptedRate(run),
      appendPerSecond: run.eventStore?.appendThroughputPerSecond ?? 0,
      concurrency: concurrencyFor(run),
      errors: run.requestPath?.errors ?? 0,
      lag: readProjectionLagEvents(run) ?? 0,
      p95LatencyMs: run.requestPath?.p95LatencyMs ?? 0,
      pass: run.pass ?? false,
    }));

    return {
      bottleneck: deriveLaneBottleneck(points.at(-1)),
      latestFinishedAt: orderedRuns.at(-1)?.finishedAt,
      latestStatus: deriveLaneStatus(points.at(-1)),
      name,
      points,
      safeConcurrency: deriveSafeConcurrency(points),
      source: "artifact" as const,
    };
  });

  return [...artifactLanes, ...(previewArchitectureLanes[scenarioName] ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function scenarioDescription(name: string) {
  if (name === "checkout-postgres-baseline") {
    return "Single hot SKU checkout intent ingress benchmark. It measures API acceptance, durable event append, projection catch-up, idempotency, and no synchronous inventory decrement.";
  }

  return "Benchmark scenario. Compare only with runs from the same scenario and compatible run conditions.";
}

function formatConditionSummary(run: BenchmarkRun) {
  const mode = run.conditions?.software?.nextMode ?? "unknown mode";
  const appInstances = formatNumber(run.conditions?.services?.nextjs?.instanceCount ?? 1);
  const pgInstances = formatNumber(run.conditions?.services?.postgres?.instanceCount ?? 1);
  const pgPool = formatNumber(run.conditions?.services?.postgres?.poolMax);
  const concurrency = formatNumber(run.conditions?.workload?.httpConcurrency);

  return `${mode} · app ${appInstances} · pg ${pgInstances} · pool ${pgPool} · c ${concurrency}`;
}

function formatDistribution(values: Record<string, number> | undefined) {
  const entries = Object.entries(values ?? {});

  if (entries.length === 0) {
    return "n/a";
  }

  return entries.map(([key, value]) => `${key}:${formatNumber(value)}`).join(" · ");
}

function formatInventorySummary(run: BenchmarkRun) {
  const inventory = run.projections?.skuInventory;

  if (!inventory) {
    return "n/a";
  }

  return `available ${formatNumber(inventory.available)} · reserved ${formatNumber(
    inventory.reserved,
  )} · sold ${formatNumber(inventory.sold)} · ${inventory.noOversell ? "no oversell" : "risk"}`;
}

function formatIdempotencySummary(run: BenchmarkRun) {
  const replay = run.requestPath?.duplicateReplay;

  if (!replay) {
    return "n/a";
  }

  return `${formatNumber(replay.status)} · replay ${replay.idempotentReplay ? "true" : "false"}`;
}

function shortRunId(runId: string) {
  return runId.length > 18 ? `${runId.slice(0, 18)}...` : runId;
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

function deriveSafeConcurrency(points: CapacityPoint[]) {
  const safePoints = points.filter(
    (point) =>
      point.acceptedRate >= 0.99 && point.p95LatencyMs <= 1000 && point.lag === 0 && point.pass,
  );

  return safePoints.length > 0 ? (safePoints.at(-1)?.concurrency ?? null) : null;
}

function deriveLaneStatus(point: CapacityPoint | undefined): ArchitectureLane["latestStatus"] {
  if (!point) {
    return "danger";
  }

  if (point.acceptedRate < 0.99 || point.errors > 0) {
    return "danger";
  }

  if (point.lag > 0 || point.p95LatencyMs > 1000) {
    return "warning";
  }

  return "healthy";
}

function deriveLaneBottleneck(point: CapacityPoint | undefined) {
  if (!point) {
    return "no data";
  }

  if (point.acceptedRate < 0.99 || point.errors > 0) {
    return "ingress admission and transport pressure";
  }

  if (point.lag > 0) {
    return "projection catch-up";
  }

  if (point.p95LatencyMs > 1000) {
    return "tail latency saturation";
  }

  return "healthy baseline";
}

function uniqueSortedNumbers(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}
