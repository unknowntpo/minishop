import "dotenv/config";

import { NativeConnection, Runtime, Worker } from "@temporalio/worker";

import { buyIntentTemporalTaskQueue } from "@/src/domain/checkout-command/temporal-contract";

async function main() {
  const address = readRequiredEnv("TEMPORAL_ADDRESS");
  const namespace = process.env.TEMPORAL_NAMESPACE?.trim();
  const taskQueue = process.env.TEMPORAL_BUY_INTENT_TASK_QUEUE?.trim() || buyIntentTemporalTaskQueue;

  Runtime.install({});
  const connection = await NativeConnection.connect({
    address,
  });

  const worker = await Worker.create({
    connection,
    ...(namespace ? { namespace } : {}),
    taskQueue,
    workflowsPath: new URL(
      "../src/infrastructure/checkout-command/temporal-buy-intent-command-workflow.ts",
      import.meta.url,
    ).pathname,
  });

  console.log(
    JSON.stringify(
      {
        temporalAddress: address,
        namespace: namespace || "default",
        taskQueue,
        status: "buy_intent_temporal_worker_started",
      },
      null,
      2,
    ),
  );

  await worker.run();
}

function readRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

main().catch((error) => {
  console.error("buy_intent_temporal_worker_failed", error);
  process.exitCode = 1;
});
