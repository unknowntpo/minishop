import "dotenv/config";

import { processStagedBuyIntentCommandBatch } from "@/src/application/checkout/process-staged-buy-intent-command-batch";
import {
  buyIntentCommandOrchestrator,
  postgresBuyIntentCommandGateway,
} from "@/src/infrastructure/checkout-command";
import { postgresEventStore } from "@/src/infrastructure/event-store";
import { systemClock } from "@/src/ports/clock";
import { cryptoIdGenerator } from "@/src/ports/id-generator";

async function main() {
  const batchSize = readPositiveIntegerEnv("BUY_INTENT_BATCH_SIZE", 100);
  const processConcurrency = readPositiveIntegerEnv("BUY_INTENT_PROCESS_CONCURRENCY", 1);
  const pollIntervalMs = readPositiveIntegerEnv("BUY_INTENT_PROCESS_POLL_INTERVAL_MS", 1000);

  while (true) {
    const result = await processStagedBuyIntentCommandBatch(
      { batchSize, processConcurrency },
      {
        gateway: postgresBuyIntentCommandGateway,
        orchestrator: buyIntentCommandOrchestrator,
        eventStore: postgresEventStore,
        idGenerator: cryptoIdGenerator,
        clock: systemClock,
      },
    );

    console.log(JSON.stringify(result, null, 2));

    if (result.claimedCount === 0) {
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("buy_intent_command_batch_loop_failed", error);
  process.exitCode = 1;
});
