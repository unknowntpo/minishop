import "dotenv/config";

import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type BenchmarkArtifact = {
  scenarioName?: string;
  runId: string;
  pass?: boolean;
  startedAt?: string;
  finishedAt?: string;
  requestPath?: {
    accepted?: number;
    errors?: number;
    acceptRequestsPerSecond?: number;
    acceptLatencyMs?: {
      p50?: number;
      p95?: number;
      p99?: number;
      max?: number;
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
  commandLifecycle?: {
    created?: number;
    createdThroughputPerSecond?: number;
    createdLatencyMs?: {
      p50?: number;
      p95?: number;
      p99?: number;
      max?: number;
    };
  };
  failure?: {
    message?: string;
    stage?: string;
  };
};

const workdir = process.cwd();
const runningInContainer = process.env.BENCHMARK_IN_CONTAINER === "1";
const appUrl =
  process.env.BENCHMARK_APP_URL ??
  (runningInContainer ? "http://go-backend:3000" : "http://localhost:3005");
const scenarioName = process.env.BENCHMARK_SCENARIO_NAME ?? "buy-intent-bypass-created";
const resultsRoot = process.env.BENCHMARK_RESULTS_DIR ?? "benchmark-results";
const requests = readPositiveIntegerEnv("BENCHMARK_REQUESTS", 10000);
const createdTimeoutMs = readPositiveIntegerEnv("BENCHMARK_CREATED_TIMEOUT_MS", 120000);
const hotSkuUnits = readPositiveIntegerEnv("BENCHMARK_HOT_SKU_UNITS", 1000000);
const appReplicas = readPositiveIntegerEnv("BENCHMARK_APP_REPLICAS", 1);
const concurrencies = readConcurrencyList(process.env.BENCHMARK_SWEEP_CONCURRENCIES ?? "50,100,200,400,800,1000");

async function main() {
  if (!runningInContainer) {
    execSync("docker compose up -d postgres nats", {
      cwd: workdir,
      stdio: "inherit",
      env: process.env,
    });
  }

  const summary: Array<{
    concurrency: number;
    accepted: number;
    created: number;
    acceptRps: number;
    createdRps: number;
    acceptP95Ms: number;
    createdP95Ms: number;
    requestToCreatedP95Ms: number;
    pass: boolean;
    artifact: string;
    failureStage?: string;
  }> = [];

  for (const concurrency of concurrencies) {
    console.log(`[benchmark:sweep] resetting state for concurrency=${concurrency}`);
    execSync(
      "MINISHOP_ALLOW_DB_RESET=1 npx tsx scripts/reset-dev-db.ts && pnpm --config.engine-strict=false db:migrate && npx tsx scripts/seed-dev-catalog.ts",
      {
        cwd: workdir,
        stdio: "inherit",
        env: {
          ...process.env,
          SEED_DEV_CATALOG_ON_HAND_OVERRIDES: `sku_hot_001:${hotSkuUnits}`,
        },
      },
    );

    if (!runningInContainer) {
      console.log(`[benchmark:sweep] starting production services for concurrency=${concurrency}`);
      execSync(
        "docker compose --profile benchmark up -d --build go-backend worker-buy-intents-ingest worker-staged-buy-intents-process worker-projections",
        {
          cwd: workdir,
          stdio: "inherit",
          env: {
            ...process.env,
            BUY_INTENT_COMMAND_ORCHESTRATOR_MODE: "noop",
          },
        },
      );
    }

    await assertAppReachable(appUrl);

    console.log(`[benchmark:sweep] running requests=${requests} concurrency=${concurrency}`);
    execSync("pnpm --config.engine-strict=false benchmark:buy-intent", {
      cwd: workdir,
      stdio: "inherit",
      env: {
        ...process.env,
        BENCHMARK_SCENARIO_NAME: scenarioName,
        BENCHMARK_REQUESTS: String(requests),
        BENCHMARK_HTTP_CONCURRENCY: String(concurrency),
        BENCHMARK_CREATED_TIMEOUT_MS: String(createdTimeoutMs),
      },
    });

    const artifact = await readLatestArtifact(resultsRoot, scenarioName);

    if (!artifact) {
      throw new Error(`No benchmark artifact found for ${scenarioName}.`);
    }

    const report = JSON.parse(await readFile(artifact, "utf8")) as BenchmarkArtifact;

    summary.push({
      concurrency,
      accepted: report.requestPath?.accepted ?? 0,
      created: report.intentCreation?.created ?? report.commandLifecycle?.created ?? 0,
      acceptRps: report.requestPath?.acceptRequestsPerSecond ?? 0,
      createdRps:
        report.intentCreation?.createdThroughputPerSecond ??
        report.commandLifecycle?.createdThroughputPerSecond ??
        0,
      acceptP95Ms: report.requestPath?.acceptLatencyMs?.p95 ?? 0,
      createdP95Ms: report.commandLifecycle?.createdLatencyMs?.p95 ?? 0,
      requestToCreatedP95Ms: report.intentCreation?.requestToCreatedLatencyMs?.p95 ?? 0,
      pass: report.pass ?? false,
      artifact,
      ...(report.failure?.stage ? { failureStage: report.failure.stage } : {}),
    });
  }

  const outDir = path.join(workdir, resultsRoot, "buy-intent-bypass-sweep");
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_summary.json`);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    outFile,
    `${JSON.stringify({ requests, hotSkuUnits, appReplicas, concurrencies, summary }, null, 2)}\n`,
    "utf8",
  );

  console.log("[benchmark:sweep] summary");
  console.table(
    summary.map((row) => ({
      concurrency: row.concurrency,
      accepted: row.accepted,
      created: row.created,
      acceptRps: row.acceptRps,
      createdRps: row.createdRps,
      acceptP95Ms: row.acceptP95Ms,
      createdP95Ms: row.createdP95Ms,
      requestToCreatedP95Ms: row.requestToCreatedP95Ms,
      pass: row.pass,
      failureStage: row.failureStage ?? "",
    })),
  );
  console.log(`Sweep summary written to ${outFile}`);
}

async function assertAppReachable(baseUrl: string) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/products`);

      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Benchmark app preflight failed: ${baseUrl}/products did not become reachable.`);
}

async function readLatestArtifact(root: string, scenario: string) {
  const { readdir } = await import("node:fs/promises");
  const directory = path.join(workdir, root, scenario);
  const files = (await readdir(directory).catch(() => []))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();

  return files[0] ? path.join(directory, files[0]) : null;
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function readConcurrencyList(raw: string) {
  const values = raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (values.length === 0) {
    throw new Error("BENCHMARK_SWEEP_CONCURRENCIES must contain at least one positive integer.");
  }

  return values;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
