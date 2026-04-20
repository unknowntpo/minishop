import "dotenv/config";

import type { PoolClient } from "pg";

import { getPool } from "@/db/client";
import { completeDemoCheckout } from "@/src/application/checkout/complete-demo-checkout";
import { postgresCheckoutDemoRepository } from "@/src/infrastructure/checkout-demo";
import { postgresEventStore } from "@/src/infrastructure/event-store";
import { systemClock } from "@/src/ports/clock";
import { cryptoIdGenerator } from "@/src/ports/id-generator";

const checkoutWorkerLockKey = 42_420_002;

async function main() {
  const batchSize = readPositiveIntegerEnv("CHECKOUT_INTENT_BATCH_SIZE", 20);
  const pollIntervalMs = readPositiveIntegerEnv("CHECKOUT_INTENT_POLL_INTERVAL_MS", 1000);
  const lockClient = await getPool().connect();

  try {
    while (true) {
      const hasLock = await tryAcquireWorkerLock(lockClient);

      if (!hasLock) {
        await sleep(pollIntervalMs);
        continue;
      }

      const checkoutIntentIds = await postgresCheckoutDemoRepository.listQueuedCheckoutIntentIds(
        batchSize,
      );

      if (checkoutIntentIds.length === 0) {
        await sleep(pollIntervalMs);
        continue;
      }

      for (const checkoutIntentId of checkoutIntentIds) {
        const result = await completeDemoCheckout(
          {
            checkoutIntentId,
            metadata: {
              request_id: crypto.randomUUID(),
              trace_id: crypto.randomUUID(),
              source: "worker",
              actor_id: "checkout-intent-worker",
            },
          },
          {
            checkoutDemoRepository: postgresCheckoutDemoRepository,
            eventStore: postgresEventStore,
            idGenerator: cryptoIdGenerator,
            clock: systemClock,
          },
        );

        console.log(
          JSON.stringify(
            {
              checkoutIntentId,
              status: result.status,
              orderId: result.orderId ?? null,
              paymentId: result.paymentId ?? null,
              reason: result.reason ?? null,
            },
            null,
            2,
          ),
        );
      }
    }
  } finally {
    try {
      await lockClient.query("select pg_advisory_unlock($1)", [checkoutWorkerLockKey]);
    } catch {}
    lockClient.release();
  }
}

async function tryAcquireWorkerLock(client: PoolClient) {
  const result = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1) as locked",
    [checkoutWorkerLockKey],
  );

  return result.rows[0]?.locked === true;
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
  console.error("checkout_intent_batch_loop_failed", error);
  process.exitCode = 1;
});
