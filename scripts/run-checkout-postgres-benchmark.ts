import "dotenv/config";

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scenarioName = "checkout-postgres-baseline";

async function main() {
  const appUrl = process.env.BENCHMARK_APP_URL ?? "http://localhost:3000";
  const shouldReset = process.env.BENCHMARK_RESET === "1";

  await assertAppReachable(appUrl);

  if (shouldReset) {
    console.log("[benchmark] resetting local benchmark database");
    await runPnpm(["db:reset:dev"]);
  }

  console.log("[benchmark] running checkout-postgres-baseline");
  await runPnpm(["benchmark:checkout:postgres:raw"]);

  const artifact = await readLatestArtifact(
    process.env.BENCHMARK_RESULTS_DIR ?? "benchmark-results",
    scenarioName,
  );

  if (!artifact) {
    throw new Error("Benchmark completed but no result artifact was found.");
  }

  const report = JSON.parse(await readFile(artifact, "utf8")) as BenchmarkArtifact;

  console.log("[benchmark] latest summary");
  console.log(
    JSON.stringify(
      {
        runId: report.runId,
        pass: report.pass,
        scenario: report.scenarioName,
        requests: report.requestPath?.accepted + report.requestPath?.errors,
        accepted: report.requestPath?.accepted,
        errors: report.requestPath?.errors,
        p95LatencyMs: report.requestPath?.p95LatencyMs,
        appendThroughputPerSecond: report.eventStore?.appendThroughputPerSecond,
        projectionLagEvents: report.projections?.checkpointLagEvents,
        artifact,
      },
      null,
      2,
    ),
  );
}

async function assertAppReachable(appUrl: string) {
  const response = await fetch(`${appUrl}/products`);

  if (!response.ok) {
    throw new Error(
      `Benchmark app preflight failed: ${appUrl}/products returned HTTP ${response.status}.`,
    );
  }
}

async function runPnpm(args: string[]) {
  const { stdout, stderr } = await execFileAsync("pnpm", args, {
    cwd: process.cwd(),
    env: process.env,
  });

  if (stdout.trim().length > 0) {
    process.stdout.write(stdout);
  }

  if (stderr.trim().length > 0) {
    process.stderr.write(stderr);
  }
}

async function readLatestArtifact(resultsRoot: string, scenario: string) {
  const directory = path.join(process.cwd(), resultsRoot, scenario);
  const files = (await readdir(directory).catch(() => []))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();

  return files[0] ? path.join(directory, files[0]) : null;
}

type BenchmarkArtifact = {
  runId: string;
  scenarioName: string;
  pass: boolean;
  requestPath: {
    accepted: number;
    errors: number;
    p95LatencyMs: number;
  };
  eventStore: {
    appendThroughputPerSecond: number;
  };
  projections: {
    checkpointLagEvents: number;
  };
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
