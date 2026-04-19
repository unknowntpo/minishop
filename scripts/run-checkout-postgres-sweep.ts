import "dotenv/config";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const defaultConcurrencySteps = [50, 100, 250, 500, 1000];

async function main() {
  const appUrl = process.env.BENCHMARK_APP_URL ?? "http://localhost:3000";
  const lane = process.env.BENCHMARK_ARCHITECTURE_LANE ?? "postgres-baseline";
  const concurrencySteps = readConcurrencySteps();

  await assertAppReachable(appUrl);

  console.log("[benchmark:sweep] starting production-only concurrency sweep");
  console.log(
    JSON.stringify(
      {
        appUrl,
        architectureLane: lane,
        requests: process.env.BENCHMARK_REQUESTS ?? 1000,
        concurrencySteps,
      },
      null,
      2,
    ),
  );

  for (const concurrency of concurrencySteps) {
    console.log(`[benchmark:sweep] running concurrency=${concurrency}`);

    await runPnpm(["benchmark:checkout:postgres:reset"], {
      ...process.env,
      BENCHMARK_APP_URL: appUrl,
      BENCHMARK_ARCHITECTURE_LANE: lane,
      BENCHMARK_HTTP_CONCURRENCY: String(concurrency),
      BENCHMARK_NEXT_MODE: "next start",
    });
  }
}

async function assertAppReachable(appUrl: string) {
  const response = await fetch(`${appUrl}/products`);

  if (!response.ok) {
    throw new Error(
      `Benchmark sweep preflight failed: ${appUrl}/products returned HTTP ${response.status}.`,
    );
  }
}

async function runPnpm(args: string[], env: NodeJS.ProcessEnv) {
  const { stdout, stderr } = await execFileAsync("pnpm", args, {
    cwd: process.cwd(),
    env,
  });

  if (stdout.trim().length > 0) {
    process.stdout.write(stdout);
  }

  if (stderr.trim().length > 0) {
    process.stderr.write(stderr);
  }
}

function readConcurrencySteps() {
  const raw = process.env.BENCHMARK_SWEEP_CONCURRENCY;

  if (!raw) {
    return defaultConcurrencySteps;
  }

  const parsed = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (parsed.length === 0) {
    throw new Error("BENCHMARK_SWEEP_CONCURRENCY must contain positive integers.");
  }

  return [...new Set(parsed)];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
