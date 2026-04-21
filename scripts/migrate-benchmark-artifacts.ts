import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type BenchmarkMeasurement = {
  key: string;
  label: string;
  unit: string;
  value: number;
  definition?: string;
  calculation?: string;
  interpretation?: string;
};

type BenchmarkSeries = {
  key: string;
  label: string;
  xKey: string;
  xLabel: string;
  xUnit: string;
  yUnit: string;
  points: Array<{
    x: number | string;
    y: number;
    runId?: string;
    pointLabel?: string;
  }>;
  definition?: string;
  calculation?: string;
  interpretation?: string;
};

type BenchmarkArtifact = {
  runId?: string;
  scenarioName?: string;
  scenarioTags?: Record<string, string | number | boolean>;
  scenario?: {
    requestedBuyClicks?: number;
  };
  kafka?: {
    createdBoundary?: string;
  };
  conditions?: {
    workload?: {
      benchmarkStyle?: "burst" | "steady_state";
      httpConcurrency?: number;
    };
    benchmarkStyle?: "burst" | "steady_state";
  };
  requestPath?: {
    accepted?: number;
    errors?: number;
    acceptRequestsPerSecond?: number;
    acceptLatencyMs?: {
      p95?: number;
    };
  };
  intentCreation?: {
    createdThroughputPerSecond?: number;
  };
  projections?: {
    checkpointLagEvents?: number;
    projectionLagEvents?: number;
  };
  measurements?: BenchmarkMeasurement[];
  series?: BenchmarkSeries[];
};

const benchmarkResultsRoot = path.join(process.cwd(), "benchmark-results");

async function main() {
  const files = await collectArtifactFiles(benchmarkResultsRoot);
  let migrated = 0;

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const artifact = JSON.parse(raw) as BenchmarkArtifact;

    if (!artifact.runId) {
      continue;
    }

    artifact.measurements = buildMeasurementsFromArtifact(artifact);
    artifact.series = buildSeriesFromArtifact(artifact);
    await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    migrated += 1;
  }

  console.log(`Migrated ${migrated} benchmark artifact(s).`);
}

async function collectArtifactFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectArtifactFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function buildMeasurementsFromArtifact(artifact: BenchmarkArtifact): BenchmarkMeasurement[] {
  const scenarioName = artifact.scenarioName ?? "unknown";
  const benchmarkStyle =
    artifact.conditions?.workload?.benchmarkStyle ?? artifact.conditions?.benchmarkStyle ?? "burst";
  const createdBoundary = artifact.kafka?.createdBoundary;
  const accepted = artifact.requestPath?.accepted ?? 0;
  const requested = artifact.scenario?.requestedBuyClicks ?? 0;
  const errors = artifact.requestPath?.errors ?? 0;
  const ingressThroughput = artifact.requestPath?.acceptRequestsPerSecond ?? 0;
  const ingressP95 = artifact.requestPath?.acceptLatencyMs?.p95 ?? 0;
  const resultThroughput = artifact.intentCreation?.createdThroughputPerSecond ?? 0;
  const projectionLag =
    artifact.projections?.checkpointLagEvents ?? artifact.projections?.projectionLagEvents;
  const measurements: BenchmarkMeasurement[] = [];

  if (requested > 0 && benchmarkStyle !== "steady_state") {
    measurements.push({
      key: "accepted_rate",
      label: "accepted rate",
      unit: "%",
      value: (accepted / requested) * 100,
      definition: "How much of the requested burst the ingress path admitted.",
      calculation: "accepted / requestedBuyClicks",
      interpretation:
        "Useful for burst-style runs. If this drops, the ingress path is rejecting or losing work before durable queueing.",
    });
  }

  measurements.push({
    key: "ingress_throughput",
    label:
      scenarioName.startsWith("buy-intent-") && createdBoundary === "kafka_seckill_result"
        ? "queued/sec"
        : scenarioName.startsWith("buy-intent-")
          ? "accept/sec"
          : "request/sec",
    unit: "/s",
    value: ingressThroughput,
    definition:
      benchmarkStyle === "steady_state"
        ? "Ingress throughput during the steady-state measurement window."
        : "Ingress throughput during the benchmark request burst.",
    calculation:
      benchmarkStyle === "steady_state"
        ? "acceptedDuringWindow / measureDurationSeconds"
        : "accepted / acceptDurationSeconds",
    interpretation:
      createdBoundary === "kafka_seckill_result"
        ? "Compare this with result topic throughput to see how much durable queued work reaches final output."
        : "Compare this with downstream throughput to see how much admitted work becomes durable business facts.",
  });

  measurements.push({
    key: "ingress_p95_latency",
    label: "p95 latency",
    unit: "ms",
    value: ingressP95,
    definition: "95th percentile latency at the ingress boundary.",
    calculation: "95th percentile of ingress latency samples",
    interpretation:
      "This is the slow tail at ingress. Spikes usually indicate queueing or saturation before processing.",
  });

  measurements.push({
    key: "result_throughput",
    label:
      createdBoundary === "kafka_seckill_result" ? "result topic throughput" : "intent created/sec",
    unit: "/s",
    value: resultThroughput,
    definition:
      createdBoundary === "kafka_seckill_result"
        ? "Final output throughput at the result topic boundary."
        : "Throughput of durable intent creation facts.",
    calculation:
      createdBoundary === "kafka_seckill_result"
        ? "finalOutputCount / throughputWindowSeconds"
        : "createdFacts / factWindowSeconds",
    interpretation:
      createdBoundary === "kafka_seckill_result"
        ? "Compare this with queued/sec. A large gap means queued work is not becoming final output fast enough."
        : "Compare this with ingress throughput to see where durable creation lags admission.",
  });

  measurements.push({
    key: "errors",
    label: "errors",
    unit: "",
    value: errors,
    definition: "Request failures observed by the benchmark client.",
    calculation: "requested work - accepted work",
    interpretation:
      "Use this with ingress throughput and status distributions to separate transport failures from application rejection.",
  });

  if (typeof projectionLag === "number") {
    measurements.push({
      key: "projection_lag",
      label: "projection lag",
      unit: "events",
      value: projectionLag,
      definition: "Distance between durable writes and projection checkpoint at verification time.",
      calculation: "eventStoreLastEventId - checkpointLastEventId",
      interpretation: "Zero means read models caught up by the end of verification.",
    });
  }

  return measurements;
}

function buildSeriesFromArtifact(artifact: BenchmarkArtifact): BenchmarkSeries[] {
  const measurements = artifact.measurements ?? [];
  const concurrency = artifact.scenarioTags?.concurrency ?? artifact.conditions?.workload?.httpConcurrency;

  if (typeof concurrency !== "number" || !Number.isFinite(concurrency) || concurrency <= 0) {
    return [];
  }

  return measurements.map((measurement) => ({
    key: `measurement.${measurement.key}.by_concurrency`,
    label: measurement.label,
    xKey: "concurrency",
    xLabel: "concurrency",
    xUnit: "",
    yUnit: measurement.unit,
    points: [
      {
        x: concurrency,
        y: measurement.value,
        runId: artifact.runId,
      },
    ],
    definition: measurement.definition,
    calculation: measurement.calculation,
    interpretation: measurement.interpretation,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
