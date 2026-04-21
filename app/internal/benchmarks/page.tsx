import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import Link from "next/link";
import { Fragment } from "react";
import { profileStandaloneHref } from "./profiles/page";

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
  kafka?: {
    client?: string;
    brokers?: string[];
    requestTopic?: string;
    resultTopic?: string;
    dlqTopic?: string;
    createdBoundary?: string;
    appPublish?: {
      batchSize?: number;
      lingerMs?: number;
    };
    producer?: {
      lingerMs?: number;
      batchNumMessages?: number;
    };
    requestTopicOffsets?: {
      partitions?: number;
      startOffset?: number;
      endOffset?: number;
      delta?: number;
    } | null;
    resultTopicOffsets?: {
      partitions?: number;
      startOffset?: number;
      endOffset?: number;
      delta?: number;
    } | null;
    dlqTopicOffsets?: {
      partitions?: number;
      startOffset?: number;
      endOffset?: number;
      delta?: number;
    } | null;
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
      profilingEnabled?: boolean;
    };
  };
  scenario?: {
    requestedBuyClicks?: number;
    skuId?: string;
    skuIds?: string[];
    workloadType?: string;
    cartSkuCount?: number;
    quantityPerIntent?: number;
    items?: Array<{
      skuId: string;
      quantity: number;
      unitPriceAmountMinor: number;
      currency: string;
    }>;
  };
  requestPath?: {
    accepted?: number;
    errors?: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    p99LatencyMs?: number;
    maxLatencyMs?: number;
    requestsPerSecond?: number;
    acceptRequestsPerSecond?: number;
    acceptLatencyMs?: {
      p50?: number;
      p95?: number;
      p99?: number;
      max?: number;
    };
    statusDistribution?: Record<string, number>;
    errorDistribution?: Record<string, number>;
    duplicateReplay?: {
      status?: number;
      idempotentReplay?: boolean;
      checkoutIntentId?: string | null;
    };
  };
  intentCreation?: {
    created?: number;
    createdThroughputPerSecond?: number;
    requestToCreatedLatencyMs?: {
      p50?: number;
      p95?: number;
      p99?: number;
      max?: number;
    };
  };
  eventStore?: {
    beforeEventCount?: number;
    afterEventCount?: number;
    appendedEvents?: number;
    appendThroughputPerSecond?: number;
    eventTypeDistribution?: Record<string, number>;
  };
  commandLifecycle?: {
    created?: number;
    duplicates?: number;
    createdThroughputPerSecond?: number;
    createdLatencyMs?: {
      p50?: number;
      p95?: number;
      p99?: number;
      max?: number;
    };
  };
  checkoutLifecycle?: {
    displayReadyStatusDistribution?: Record<string, number>;
    displayReadyLatencyMs?: {
      p50?: number;
      p95?: number;
      p99?: number;
      max?: number;
    };
    resolvedStatusDistribution?: Record<string, number>;
  };
  projections?: {
    checkpointLastEventId?: number;
    eventStoreLastEventId?: number;
    checkpointLagEvents?: number;
    projectionLagEvents?: number;
    checkoutProjectionCount?: number;
    checkoutStatusDistribution?: Record<string, number>;
    skuInventory?: {
      skuId?: string;
      noOversell?: boolean;
      matchesAccounting?: boolean;
      unchangedFromSeed?: boolean;
      onHand?: number;
      available?: number;
      reserved?: number;
      sold?: number;
    } | null;
    skuInventories?: Array<{
      skuId?: string;
      noOversell?: boolean;
      matchesAccounting?: boolean;
      unchangedFromSeed?: boolean;
      onHand?: number;
      available?: number;
      reserved?: number;
      sold?: number;
    }> | null;
  };
  profiling?: {
    enabled?: boolean;
    status?: "disabled" | "captured" | "failed";
    target?: string;
    scope?: string;
    format?: string;
    startedAt?: string;
    stoppedAt?: string;
    error?: string;
    files?: Array<{
      kind?: "cpu";
      path?: string;
      label?: string;
    }>;
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
  requestsPerSecond: number;
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
          requestsPerSecond: 225,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 395,
          concurrency: 100,
          errors: 0,
          lag: 0,
          p95LatencyMs: 180,
          pass: true,
          requestsPerSecond: 420,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 830,
          concurrency: 250,
          errors: 0,
          lag: 0,
          p95LatencyMs: 310,
          pass: true,
          requestsPerSecond: 875,
        },
        {
          acceptedRate: 0.998,
          appendPerSecond: 1420,
          concurrency: 500,
          errors: 1,
          lag: 0,
          p95LatencyMs: 520,
          pass: true,
          requestsPerSecond: 1510,
        },
        {
          acceptedRate: 0.992,
          appendPerSecond: 1990,
          concurrency: 1000,
          errors: 8,
          lag: 14,
          p95LatencyMs: 980,
          pass: true,
          requestsPerSecond: 2125,
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
          requestsPerSecond: 252,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 470,
          concurrency: 100,
          errors: 0,
          lag: 0,
          p95LatencyMs: 130,
          pass: true,
          requestsPerSecond: 490,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 1120,
          concurrency: 250,
          errors: 0,
          lag: 0,
          p95LatencyMs: 220,
          pass: true,
          requestsPerSecond: 1180,
        },
        {
          acceptedRate: 1,
          appendPerSecond: 2140,
          concurrency: 500,
          errors: 0,
          lag: 0,
          p95LatencyMs: 340,
          pass: true,
          requestsPerSecond: 2235,
        },
        {
          acceptedRate: 0.998,
          appendPerSecond: 3280,
          concurrency: 1000,
          errors: 2,
          lag: 0,
          p95LatencyMs: 620,
          pass: true,
          requestsPerSecond: 3390,
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
  searchParams?: Promise<{ scenario?: string; run?: string }>;
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
  const comparisonRuns = selectedScenarioRuns.slice(0, 10);
  const selectedRunId = params?.run;
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
        <Link className="text-link" href="/internal/design-system">
          Design system
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
              <RunComparison
                scenarioName={selectedScenarioName}
                selectedRunId={selectedRunId}
                runs={comparisonRuns}
              />
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
                  description={ingressMetricDescription(capacityScenarioName)}
                  label={ingressMetricLabel(capacityScenarioName)}
                  lanes={architectureLanes}
                  unit="/s"
                  valueFor={(point) => point.requestsPerSecond}
                />
                <LaneMetricChart
                  description="Tail latency at the checkout intent API boundary."
                  label="p95 latency"
                  lanes={architectureLanes}
                  unit="ms"
                  valueFor={(point) => point.p95LatencyMs}
                />
                <LaneMetricChart
                  description={throughputMetricDescription(capacityScenarioName)}
                  label={throughputMetricLabel(capacityScenarioName)}
                  lanes={architectureLanes}
                  unit="/s"
                  valueFor={(point) => point.appendPerSecond}
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
                    <th>Throughput</th>
                    <th>Lag</th>
                    <th>Profiling</th>
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
                      <td>{formatNumber(readRequestP95(run))}ms</td>
                      <td>{formatPrimaryThroughput(run)}</td>
                      <td>{formatNumber(readProjectionLagEvents(run))}</td>
                      <td>{renderProfilingEvidence(run)}</td>
                      <td>
                        <StatusSummary values={readCheckoutStatusDistribution(run)} />
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
        latestP95LatencyMs: latest ? readRequestP95(latest) : undefined,
        latestPass: latest?.pass,
        name,
        runCount: scenarioRuns.length,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function RunComparison({
  scenarioName,
  selectedRunId,
  runs,
}: {
  scenarioName: string;
  selectedRunId?: string;
  runs: BenchmarkRun[];
}) {
  const selectedRun = selectedRunId ? runs.find((run) => run.runId === selectedRunId) ?? null : null;

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
          <Fragment key={run.artifactFile}>
            <Link
              className={`benchmark-run-tag${selectedRun?.runId === run.runId ? " selected" : ""}`}
              href={
                selectedRun?.runId === run.runId
                  ? `/internal/benchmarks?scenario=${encodeURIComponent(scenarioName)}`
                  : `/internal/benchmarks?scenario=${encodeURIComponent(scenarioName)}&run=${encodeURIComponent(run.runId)}`
              }
              scroll={false}
              aria-expanded={selectedRun?.runId === run.runId}
            >
              <strong>{displayRunName(run)}</strong>
              <span className="benchmark-run-id mono">{shortRunId(run.runId)}</span>
              <span className={`badge ${run.pass ? "success" : "danger"}`}>
                {run.pass ? "pass" : "fail"}
              </span>
              <code>{formatConditionSummary(run)}</code>
            </Link>
            {selectedRun?.runId === run.runId ? (
              <SelectedRunPanel run={selectedRun} scenarioName={scenarioName} />
            ) : null}
          </Fragment>
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
          definition={ingressMetricDefinition(scenarioName)}
          calculation={ingressMetricCalculation(scenarioName)}
          interpretation={ingressMetricInterpretation(scenarioName)}
          label={ingressMetricLabel(scenarioName)}
          runs={runs}
          unit="/s"
          valueFor={(run) => readRequestsPerSecond(run)}
        />
        <ComparisonChart
          definition="95th percentile request latency for the checkout intent API path. This is ingress latency, not end-to-end reservation or payment latency."
          calculation="95th percentile of per-request latency samples"
          interpretation="This shows the slow tail. Spikes usually indicate queueing, database pressure, or server saturation."
          label="p95 latency"
          runs={runs}
          unit="ms"
          valueFor={(run) => readRequestP95(run)}
        />
        <ComparisonChart
          definition={throughputMetricDefinition(scenarioName)}
          calculation={throughputMetricCalculation(scenarioName)}
          interpretation={throughputMetricInterpretation(scenarioName)}
          label={throughputMetricLabel(scenarioName)}
          runs={runs}
          unit="/s"
          valueFor={(run) => readAppendThroughputPerSecond(run)}
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

function SelectedRunPanel({
  run,
  scenarioName,
}: {
  run: BenchmarkRun;
  scenarioName: string;
}) {
  const profileFile = run.profiling?.files?.find((file) => Boolean(file.path))?.path;

  return (
    <article className="capacity-chart-card benchmark-selected-run-card">
      <div className="capacity-chart-header">
        <div>
          <p className="eyebrow">Selected run</p>
          <strong>{displayRunName(run)}</strong>
          <p className="muted admin-panel-copy">
            {formatDateTime(run.finishedAt)} · {formatConditionSummary(run)} · {run.runId}
          </p>
        </div>
        <span className={`badge ${run.pass ? "success" : "danger"}`}>
          {run.pass ? "pass" : "failed"}
        </span>
      </div>

      <KeyValueList
        values={{
          requests: formatNumber(run.scenario?.requestedBuyClicks),
          accepted: formatNumber(run.requestPath?.accepted),
          errors: formatNumber(run.requestPath?.errors),
          "p95 latency": `${formatNumber(readRequestP95(run))}ms`,
          [throughputMetricLabelForRun(run)]: formatNumber(readAppendThroughputPerSecond(run)),
          "projection lag": formatNumber(readProjectionLagEvents(run)),
          profiling: run.profiling?.status ?? "disabled",
        }}
      />

      <DetailSections
        sections={[
          { title: "Scenario", value: run.scenario },
          { title: "Environment", value: run.environment },
          { title: "Conditions", value: run.conditions },
          { title: "Kafka", value: run.kafka },
        ]}
      />

      <div className="benchmark-selected-run-actions">
        {profileFile ? (
          <Link
            className="text-link"
            href={profileViewerHref(profileFile, scenarioName, run.runId)}
          >
            Open profiling viewer
          </Link>
        ) : (
          <span className="muted">No profiling file attached to this run.</span>
        )}
      </div>
    </article>
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
          const hoverText = `r${index + 1} ${run.runId}: ${value}${unit ? ` ${unit}` : ""}\n${formatConditionSummary(
            run,
          )}\n${displayRunName(run)}\nHTTP ${formatDistribution(run.requestPath?.statusDistribution)}`;

          return (
            <span
              className="benchmark-plot-column"
              key={run.artifactFile}
              aria-label={hoverText}
              tabIndex={0}
            >
              <span className="benchmark-plot-value">{formatPlotHoverValue(value, unit)}</span>
              <span
                className={run.pass ? "benchmark-plot-bar" : "benchmark-plot-bar failed"}
                style={{ height }}
              />
              <code>{displayRunShortName(run, index + 1)}</code>
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
                <strong>{displayRunShortName(run, index + 1)}</strong>
                <span className="muted mono">{shortRunId(run.runId)}</span>
              </td>
              <td>{formatDistribution(run.requestPath?.statusDistribution)}</td>
              <td>{formatDistribution(run.requestPath?.errorDistribution)}</td>
              <td>{formatDistribution(run.eventStore?.eventTypeDistribution)}</td>
              <td>{formatDistribution(readCheckoutStatusDistribution(run))}</td>
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
  const yAxisLabel = axisLabelForUnit(unit);
  const yAxisShortUnit = axisShortUnitForUnit(unit);

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
        viewBox="0 0 396 244"
        role="img"
        aria-label={`${label} by concurrency and architecture lane`}
      >
        <text className="capacity-axis-unit" x="18" y="18">
          ({yAxisShortUnit})
        </text>
        <text className="capacity-axis-title" transform="translate(18 156) rotate(-90)">
          {yAxisLabel}
        </text>
        <text className="capacity-axis-title" x="198" y="232" textAnchor="middle">
          concurrency
        </text>
        <text className="capacity-axis-unit" x="352" y="222">
          (c)
        </text>
        <line className="capacity-axis" x1="52" y1="28" x2="52" y2="190" />
        <line className="capacity-axis" x1="52" y1="190" x2="356" y2="190" />
        <polyline className="capacity-axis-arrow" points="44,36 52,28 60,36" />
        <polyline className="capacity-axis-arrow" points="348,182 356,190 348,198" />
        {lanes.map((lane, laneIndex) => {
          const color = colors[laneIndex % colors.length];
          const points = lane.points
            .sort((left, right) => left.concurrency - right.concurrency)
            .map((point) => {
              const stepIndex = allSteps.indexOf(point.concurrency);
              const x =
                allSteps.length === 1 || stepIndex === -1
                  ? 204
                  : 52 + (stepIndex / (allSteps.length - 1)) * 304;
              const y = 190 - (valueFor(point) / maxValue) * 132;

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
                <g
                  className="capacity-point-group"
                  key={`${lane.name}-${point.concurrency}`}
                  tabIndex={0}
                >
                  <circle
                    className={`capacity-point${lane.source === "preview" ? " preview" : ""}`}
                    cx={x}
                    cy={y}
                    fill={color}
                    r={4}
                  />
                  <foreignObject
                    className="capacity-point-tooltip"
                    height="60"
                    width="132"
                    x={Math.min(Math.max(x - 54, 10), 214)}
                    y={Math.max(y - 58, 8)}
                  >
                    <div className="capacity-point-tooltip-card">
                      <strong>{lane.name}</strong>
                      <span>c{formatNumber(point.concurrency)}</span>
                      <span>
                        {formatNumber(valueFor(point))}
                        {unit ? ` ${unit}` : ""}
                      </span>
                    </div>
                  </foreignObject>
                  <title>
                    {`${lane.name} · c${point.concurrency} · ${formatNumber(valueFor(point))}${unit ? ` ${unit}` : ""}`}
                  </title>
                </g>
              ))}
            </g>
          );
        })}
        {allSteps.map((step, index) => {
          const x = allSteps.length === 1 ? 204 : 52 + (index / (allSteps.length - 1)) * 304;

          return (
            <text className="capacity-axis-label" key={step} x={x} y="214">
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

function axisLabelForUnit(unit: string) {
  if (unit === "%") {
    return "accepted rate";
  }

  if (unit === "ms") {
    return "milliseconds";
  }

  if (unit === "events") {
    return "events";
  }

  if (unit === "/s") {
    return "per second";
  }

  return "count";
}

function axisShortUnitForUnit(unit: string) {
  if (unit === "/s") {
    return "1/s";
  }

  return unit || "count";
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

function DetailSections({
  sections,
}: {
  sections: Array<{ title: string; value: unknown }>;
}) {
  const nonEmptySections = sections
    .map((section) => ({
      ...section,
      values: flattenDetailValues(section.value),
    }))
    .filter((section) => Object.keys(section.values).length > 0);

  if (nonEmptySections.length === 0) {
    return null;
  }

  return (
    <>
      {nonEmptySections.map((section, index) => (
        <Fragment key={section.title}>
          <p className="eyebrow" style={{ marginTop: index === 0 ? "1.5rem" : "1rem" }}>
            {section.title}
          </p>
          <KeyValueList values={section.values} />
        </Fragment>
      ))}
    </>
  );
}

function flattenDetailValues(
  value: unknown,
  path: string[] = [],
  result: Record<string, string> = {},
): Record<string, string> {
  if (value === null || typeof value === "undefined") {
    if (path.length > 0) {
      result[formatDetailLabel(path)] = "n/a";
    }
    return result;
  }

  if (typeof value === "string") {
    result[formatDetailLabel(path)] = value || "n/a";
    return result;
  }

  if (typeof value === "number") {
    result[formatDetailLabel(path)] = formatPrimitiveDetailValue(path, value);
    return result;
  }

  if (typeof value === "boolean") {
    result[formatDetailLabel(path)] = value ? "true" : "false";
    return result;
  }

  if (Array.isArray(value)) {
    result[formatDetailLabel(path)] =
      value.length === 0 ? "n/a" : value.map((entry) => String(entry)).join(", ");
    return result;
  }

  if (typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value)) {
      flattenDetailValues(nestedValue, [...path, key], result);
    }
  }

  return result;
}

function formatDetailLabel(path: string[]) {
  return path
    .flatMap((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .split(" "),
    )
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function formatPrimitiveDetailValue(path: string[], value: number) {
  const label = path[path.length - 1] ?? "";

  if (label === "lingerMs") {
    return formatMilliseconds(value);
  }

  return formatNumber(value);
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

function readRequestP95(run: BenchmarkRun) {
  return run.requestPath?.p95LatencyMs ?? run.requestPath?.acceptLatencyMs?.p95 ?? 0;
}

function readRequestsPerSecond(run: BenchmarkRun) {
  return run.requestPath?.requestsPerSecond ?? run.requestPath?.acceptRequestsPerSecond ?? 0;
}

function readAppendThroughputPerSecond(run: BenchmarkRun) {
  return (
    run.intentCreation?.createdThroughputPerSecond ??
    run.eventStore?.appendThroughputPerSecond ??
    run.commandLifecycle?.createdThroughputPerSecond ??
    0
  );
}

function readCheckoutStatusDistribution(run: BenchmarkRun) {
  return (
    run.projections?.checkoutStatusDistribution ??
    run.checkoutLifecycle?.resolvedStatusDistribution ??
    run.checkoutLifecycle?.displayReadyStatusDistribution
  );
}

function isBuyIntentScenarioName(scenarioName?: string) {
  return Boolean(scenarioName?.startsWith("buy-intent-"));
}

function throughputMetricLabel(scenarioName?: string) {
  return "intent created/sec";
}

function throughputMetricLabelForRun(run: BenchmarkRun) {
  return throughputMetricLabel(scenarioNameFor(run));
}

function ingressMetricLabel(scenarioName?: string) {
  return isBuyIntentScenarioName(scenarioName) ? "accept/sec" : "request/sec";
}

function ingressMetricDescription(scenarioName?: string) {
  if (isBuyIntentScenarioName(scenarioName)) {
    return "Accepted buy-intent commands per second at the HTTP ingress boundary.";
  }

  return "Ingress throughput by concurrency step inside the same architecture lane.";
}

function ingressMetricDefinition(scenarioName?: string) {
  if (isBuyIntentScenarioName(scenarioName)) {
    return "Accepted buy-intent ingress throughput. It tracks how quickly the API admitted buy-intent work.";
  }

  return "HTTP requests completed per second by the benchmark client during the request burst.";
}

function ingressMetricCalculation(scenarioName?: string) {
  if (isBuyIntentScenarioName(scenarioName)) {
    return "acceptedCommands / accept duration seconds";
  }

  return "total requests / request burst duration seconds";
}

function ingressMetricInterpretation(scenarioName?: string) {
  if (isBuyIntentScenarioName(scenarioName)) {
    return "This is the fast ingress metric. Compare it with buyIntent created/sec to see how much slower durable processing is than acceptance.";
  }

  return "Read this with accepted rate and errors. Higher is only better when success remains stable.";
}

function throughputMetricDescription(scenarioName?: string) {
  return isBuyIntentScenarioName(scenarioName)
    ? "Checkout intent creation facts across concurrency steps in the same architecture lane."
    : "Checkout intent creation facts across concurrency steps in the same architecture lane.";
}

function throughputMetricDefinition(scenarioName?: string) {
  return isBuyIntentScenarioName(scenarioName)
    ? "CheckoutIntentCreated throughput. It tracks how quickly accepted work became a durable checkout intent fact."
    : "CheckoutIntentCreated throughput. It tracks how quickly accepted work became a durable checkout intent fact.";
}

function throughputMetricCalculation(scenarioName?: string) {
  return isBuyIntentScenarioName(scenarioName)
    ? "createdFacts / (max CheckoutIntentCreated occurred_at - min request started_at)"
    : "createdFacts / (max CheckoutIntentCreated occurred_at - min request started_at)";
}

function throughputMetricInterpretation(scenarioName?: string) {
  return isBuyIntentScenarioName(scenarioName)
    ? "Compare this with accept/sec. If intent created/sec lags far behind ingress, orchestration or merge progress is the bottleneck."
    : "Compare this with request/sec. If intent created/sec lags far behind ingress, durable checkout creation is the bottleneck.";
}

function formatPrimaryThroughput(run: BenchmarkRun) {
  return `${throughputMetricLabelForRun(run)} ${formatNumber(readAppendThroughputPerSecond(run))}`;
}

function scenarioNameFor(run: BenchmarkRun) {
  return run.scenarioName ?? run.conditions?.workload?.scenarioName ?? "unknown";
}

function defaultArchitectureLaneForScenario(scenarioName: string) {
  if (scenarioName === "checkout-postgres-baseline") {
    return "postgres-baseline";
  }

  return scenarioName;
}

function architectureLaneFor(run: BenchmarkRun) {
  return (
    run.conditions?.workload?.architectureLane ??
    defaultArchitectureLaneForScenario(scenarioNameFor(run))
  );
}

function concurrencyFor(run: BenchmarkRun) {
  return (
    run.conditions?.workload?.httpConcurrency ??
    run.conditions?.workload?.requestedBuyClicks ??
    run.scenario?.requestedBuyClicks ??
    0
  );
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
      appendPerSecond: readAppendThroughputPerSecond(run),
      concurrency: concurrencyFor(run),
      errors: run.requestPath?.errors ?? 0,
      lag: readProjectionLagEvents(run) ?? 0,
      p95LatencyMs: readRequestP95(run),
      pass: run.pass ?? false,
      requestsPerSecond: readRequestsPerSecond(run),
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

  if (name === "checkout-postgres-multi-sku-cart") {
    return "Multi-SKU cart checkout ingress benchmark. It measures mixed-cart acceptance, durable event append, projection catch-up, idempotency, and per-SKU inventory invariants without reservation processing.";
  }

  if (name === "buy-intent-bypass-created") {
    return "Async buy-intent benchmark on the queue-first worker path. The flow stops at CheckoutIntentCreated and queued projection state.";
  }

  return "Benchmark scenario. Compare only with runs from the same scenario and compatible run conditions.";
}

function formatConditionSummary(run: BenchmarkRun) {
  if (run.conditions?.workload?.workloadType === "buy_intent_temporal_flow") {
    const lane = run.conditions?.workload?.architectureLane ?? "unknown";
    const concurrency = formatNumber(run.conditions?.workload?.httpConcurrency);

    return `${lane} · c ${concurrency}`;
  }

  const mode = run.conditions?.software?.nextMode ?? "unknown mode";
  const appInstances = formatNumber(run.conditions?.services?.nextjs?.instanceCount ?? 1);
  const pgInstances = formatNumber(run.conditions?.services?.postgres?.instanceCount ?? 1);
  const pgPool = formatNumber(run.conditions?.services?.postgres?.poolMax);
  const concurrency = formatNumber(run.conditions?.workload?.httpConcurrency);
  const kafkaClient = run.kafka?.client ? ` · kafka ${run.kafka.client}` : "";

  return `${mode} · app ${appInstances} · pg ${pgInstances} · pool ${pgPool} · c ${concurrency}${kafkaClient}`;
}

function formatMilliseconds(value: number | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }

  return `${formatNumber(value)}ms`;
}

function formatDistribution(values: Record<string, number> | undefined) {
  const entries = Object.entries(values ?? {});

  if (entries.length === 0) {
    return "n/a";
  }

  return entries.map(([key, value]) => `${key}:${formatNumber(value)}`).join(" · ");
}

function formatInventorySummary(run: BenchmarkRun) {
  const inventories = run.projections?.skuInventories;

  if (inventories && inventories.length > 0) {
    const failed = inventories.filter(
      (inventory) =>
        !inventory.noOversell || !inventory.matchesAccounting || !inventory.unchangedFromSeed,
    ).length;
    const skuList = inventories.map((inventory) => inventory.skuId ?? "unknown").join(", ");

    return `${inventories.length} sku · ${failed === 0 ? "all invariants ok" : `${failed} invariant failures`} · ${skuList}`;
  }

  const inventory = run.projections?.skuInventory;

  if (!inventory) {
    return "n/a";
  }

  return `available ${formatNumber(inventory.available)} · reserved ${formatNumber(
    inventory.reserved,
  )} · sold ${formatNumber(inventory.sold)} · ${
    inventory.noOversell && inventory.matchesAccounting && inventory.unchangedFromSeed
      ? "all invariants ok"
      : "risk"
  }`;
}

function formatIdempotencySummary(run: BenchmarkRun) {
  const replay = run.requestPath?.duplicateReplay;

  if (!replay) {
    return "n/a";
  }

  return `${formatNumber(replay.status)} · replay ${replay.idempotentReplay ? "true" : "false"}`;
}

function renderProfilingEvidence(run: BenchmarkRun) {
  const files = run.profiling?.files?.filter((file) => Boolean(file.path)) ?? [];

  if (files.length > 0) {
    return (
      <span className="benchmark-profiling-links">
        {files.map((file) => (
          <Link
            className="text-link"
            href={profileViewerHref(file.path ?? "")}
            key={`${run.artifactFile}-${file.path ?? file.label ?? "profile"}`}
          >
            {file.label ?? "CPU flamegraph"}
          </Link>
        ))}
      </span>
    );
  }

  if (run.profiling?.status === "failed") {
    return <span className="badge warning">profile failed</span>;
  }

  if (run.profiling?.enabled || run.conditions?.workload?.profilingEnabled) {
    return <span className="badge neutral">enabled</span>;
  }

  return <span className="muted">off</span>;
}

function profileViewerHref(filePath: string, scenarioName?: string, runId?: string) {
  return profileStandaloneHref(filePath, scenarioName, runId);
}

function displayRunName(run: BenchmarkRun) {
  const base = runNamePrefixForScenario(scenarioNameFor(run));
  const stamp = compactTimestamp(run.finishedAt ?? run.startedAt);

  return stamp ? `${base}-${stamp}` : `${base}-${shortRunId(run.runId)}`;
}

function displayRunShortName(run: BenchmarkRun, fallbackIndex: number) {
  const name = displayRunName(run);

  return name.length > 18 ? `r${fallbackIndex}` : name;
}

function compactTimestamp(value?: string) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day}-${hours}${minutes}`;
}

function runNamePrefixForScenario(scenarioName: string) {
  if (scenarioName === "checkout-postgres-baseline") {
    return "baseline";
  }

  if (scenarioName === "checkout-postgres-multi-sku-cart") {
    return "multi-sku-cart";
  }

  return scenarioName.replace(/^checkout-/, "").replace(/^postgres-/, "").replace(/[^a-z0-9]+/gi, "-");
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

function formatPlotHoverValue(value: number, unit: string) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  if (unit === "%") {
    return `${Math.round(value)}%`;
  }

  if (unit === "") {
    return formatNumber(value);
  }

  return `${formatNumber(Number(value.toFixed(2)))}${unit}`;
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
