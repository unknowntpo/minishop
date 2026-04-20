import "dotenv/config";

import { processProjections } from "@/src/application/projections/process-projections";
import { postgresProjectionRepository } from "@/src/infrastructure/projections";

async function main() {
  const projectionName = readStringEnv("PROJECTION_NAME", "main");
  const batchSize = readPositiveIntegerEnv("PROJECTION_BATCH_SIZE", 100);
  const pollIntervalMs = readPositiveIntegerEnv("PROJECTION_POLL_INTERVAL_MS", 1000);

  while (true) {
    const result = await processProjections(
      {
        projectionName,
        batchSize,
      },
      {
        projectionRepository: postgresProjectionRepository,
      },
    );

    console.log(JSON.stringify(result, null, 2));

    if (!result.locked || result.processedEvents < batchSize) {
      await sleep(pollIntervalMs);
    }
  }
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readStringEnv(name: string, fallback: string) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("projection_batch_loop_failed", error);
  process.exitCode = 1;
});
