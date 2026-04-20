import "dotenv/config";

import { execSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workdir = "/Users/unknowntpo/repo/unknowntpo/minishop/main";
const appUrl = process.env.BENCHMARK_APP_URL ?? "http://localhost:3000";
const resultsRoot = process.env.BENCHMARK_RESULTS_DIR ?? "benchmark-results";
const requests = process.env.BENCHMARK_REQUESTS ?? "50";
const concurrency = process.env.BENCHMARK_HTTP_CONCURRENCY ?? "20";

async function main() {
  const temporalScenario = "buy-intent-temporal-payment-fail";
  const bypassScenario = "buy-intent-bypass-created";

  execSync("docker compose up -d postgres nats temporal", {
    cwd: workdir,
    stdio: "inherit",
    env: process.env,
  });

  const temporalArtifact = await runLane({
    mode: "temporal",
    scenarioName: temporalScenario,
    services: ["app", "worker-buy-intents-ingest", "worker-buy-intents-temporal", "worker-projections"],
    stopServices: ["worker-buy-intents-process"],
  });

  const bypassArtifact = await runLane({
    mode: "bypass",
    scenarioName: bypassScenario,
    services: ["app", "worker-buy-intents-ingest", "worker-buy-intents-process", "worker-projections"],
    stopServices: ["worker-buy-intents-temporal"],
  });

  const temporal = JSON.parse(await readFile(temporalArtifact, "utf8")) as BenchmarkArtifact;
  const bypass = JSON.parse(await readFile(bypassArtifact, "utf8")) as BenchmarkArtifact;

  console.log("[benchmark] buy-intent temporal compare");
  console.log(
    JSON.stringify(
      {
        requests: Number(requests),
        concurrency: Number(concurrency),
        temporal: summarize(temporal),
        bypass: summarize(bypass),
        delta: {
          acceptRps: round2(
            (temporal.requestPath.acceptRequestsPerSecond ?? 0) -
              (bypass.requestPath.acceptRequestsPerSecond ?? 0),
          ),
          createdP95Ms: round2(
            (temporal.commandLifecycle.createdLatencyMs?.p95 ?? 0) -
              (bypass.commandLifecycle.createdLatencyMs?.p95 ?? 0),
          ),
          displayReadyP95Ms: round2(
            (temporal.checkoutLifecycle.displayReadyLatencyMs?.p95 ?? 0) -
              (bypass.checkoutLifecycle.displayReadyLatencyMs?.p95 ?? 0),
          ),
        },
        artifacts: {
          temporal: temporalArtifact,
          bypass: bypassArtifact,
        },
      },
      null,
      2,
    ),
  );
}

async function runLane(input: {
  mode: "temporal" | "bypass";
  scenarioName: string;
  services: string[];
  stopServices: string[];
}) {
  console.log(`[benchmark] resetting database for ${input.mode}`);
  execSync(
    "MINISHOP_ALLOW_DB_RESET=1 npx tsx scripts/reset-dev-db.ts && pnpm --config.engine-strict=false db:migrate && npx tsx scripts/seed-dev-catalog.ts",
    {
      cwd: workdir,
      stdio: "inherit",
      env: process.env,
    },
  );

  console.log(`[benchmark] starting services for ${input.mode}`);
  execSync(`docker compose up -d --build ${input.services.join(" ")}`, {
    cwd: workdir,
    stdio: "inherit",
    env: {
      ...process.env,
      BUY_INTENT_COMMAND_ORCHESTRATOR_MODE: input.mode === "temporal" ? "temporal" : "noop",
    },
  });

  if (input.stopServices.length > 0) {
    execSync(`docker compose stop ${input.stopServices.join(" ")}`, {
      cwd: workdir,
      stdio: "inherit",
      env: process.env,
    });
  }

  await assertAppReachable(appUrl);

  console.log(`[benchmark] running ${input.mode} lane`);
  execSync("pnpm --config.engine-strict=false benchmark:buy-intent:temporal", {
    cwd: workdir,
    stdio: "inherit",
    env: {
      ...process.env,
      BENCHMARK_REQUESTS: requests,
      BENCHMARK_HTTP_CONCURRENCY: concurrency,
      BENCHMARK_TEMPORAL_MODE: input.mode,
      BENCHMARK_SCENARIO_NAME: input.scenarioName,
    },
  });

  const artifact = await readLatestArtifact(resultsRoot, input.scenarioName);

  if (!artifact) {
    throw new Error(`No benchmark artifact found for ${input.scenarioName}.`);
  }

  return artifact;
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

    await sleep(1_000);
  }

  throw new Error(`Benchmark app preflight failed: ${baseUrl}/products did not become reachable.`);
}

async function readLatestArtifact(root: string, scenario: string) {
  const directory = path.join(workdir, root, scenario);
  const files = (await readdir(directory).catch(() => []))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();

  return files[0] ? path.join(directory, files[0]) : null;
}

function summarize(report: BenchmarkArtifact) {
  return {
    acceptRps: report.requestPath.acceptRequestsPerSecond,
    acceptP95Ms: report.requestPath.acceptLatencyMs?.p95 ?? 0,
    createdP95Ms: report.commandLifecycle.createdLatencyMs?.p95 ?? 0,
    displayReady: report.checkoutLifecycle.displayReadyStatusDistribution,
    displayReadyP95Ms: report.checkoutLifecycle.displayReadyLatencyMs?.p95 ?? 0,
    resolvedStatusDistribution: report.checkoutLifecycle.resolvedStatusDistribution ?? {},
  };
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type BenchmarkArtifact = {
  requestPath: {
    acceptRequestsPerSecond?: number;
    acceptLatencyMs?: { p95?: number };
  };
  commandLifecycle: {
    createdLatencyMs?: { p95?: number };
  };
  checkoutLifecycle: {
    displayReadyStatusDistribution?: Record<string, number>;
    displayReadyLatencyMs?: { p95?: number };
    resolvedStatusDistribution?: Record<string, number>;
  };
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
