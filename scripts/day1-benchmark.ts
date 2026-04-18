import "dotenv/config";

import { Pool } from "pg";

type BenchmarkConfig = {
  appUrl: string;
  databaseUrl: string;
  requests: number;
  projectionBatchSize: number;
  skuId: string;
  buyerPrefix: string;
  runId: string;
};

type RequestResult = {
  ok: boolean;
  status: number;
  latencyMs: number;
  checkoutIntentId?: string;
  idempotentReplay?: boolean;
  error?: string;
};

type StatusDistributionRow = {
  status: string;
  count: string | number;
};

type InventoryRow = {
  sku_id: string;
  on_hand: number;
  reserved: number;
  sold: number;
  available: number;
  last_event_id: string | number;
  aggregate_version: string | number;
};

type CheckpointRow = {
  last_event_id: string | number;
};

type EventCountRow = {
  count: string | number;
};

const config = readConfig();

async function main() {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 5,
  });

  try {
    const beforeEventCount = await readEventCount(pool);
    const startedAt = performance.now();
    const results = await Promise.all(
      Array.from({ length: config.requests }, (_, index) => createCheckoutIntent(index)),
    );
    const totalMs = performance.now() - startedAt;
    const duplicateReplay = await replayDuplicateIdempotencyKey();

    await processProjectionBatch();

    const [afterEventCount, statusDistribution, inventory, checkpoint] = await Promise.all([
      readEventCount(pool),
      readStatusDistribution(pool),
      readInventory(pool, config.skuId),
      readCheckpoint(pool),
    ]);

    const accepted = results.filter((result) => result.ok).length;
    const errors = results.filter((result) => !result.ok).length;
    const latencies = results.map((result) => result.latencyMs);
    const appendedEvents = afterEventCount - beforeEventCount;

    const report = {
      runId: config.runId,
      scenario: {
        skuId: config.skuId,
        requestedBuyClicks: config.requests,
        quantityPerIntent: 1,
      },
      requestPath: {
        accepted,
        errors,
        duplicateReplay: {
          status: duplicateReplay.status,
          idempotentReplay: duplicateReplay.idempotentReplay ?? false,
          checkoutIntentId: duplicateReplay.checkoutIntentId ?? null,
        },
        p95LatencyMs: percentile(latencies, 95),
        totalDurationMs: Math.round(totalMs),
      },
      eventStore: {
        appendedEvents,
        appendThroughputPerSecond: Number((appendedEvents / (totalMs / 1000)).toFixed(2)),
      },
      projections: {
        checkpointLastEventId: checkpoint,
        eventStoreLastEventId: afterEventCount,
        checkpointLagEvents: Math.max(0, afterEventCount - checkpoint),
        checkoutStatusDistribution: statusDistribution,
        skuInventory: inventory,
      },
      notes: [
        "Kafka, Redis, SSE, WebSocket, and real payment providers are intentionally excluded.",
        "Until reservation workers are wired end-to-end, accepted intents may remain queued.",
      ],
    };

    console.log(JSON.stringify(report, null, 2));

    if (errors > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

async function createCheckoutIntent(index: number): Promise<RequestResult> {
  const idempotencyKey = `${config.runId}-idem-${index}`;
  return postCheckoutIntent(index, idempotencyKey);
}

async function replayDuplicateIdempotencyKey() {
  return postCheckoutIntent(0, `${config.runId}-idem-0`);
}

async function postCheckoutIntent(index: number, idempotencyKey: string): Promise<RequestResult> {
  const startedAt = performance.now();

  try {
    const response = await fetch(`${config.appUrl}/api/checkout-intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-request-id": `req_${config.runId}_${index}`,
        "x-trace-id": `trace_${config.runId}`,
      },
      body: JSON.stringify({
        buyerId: `${config.buyerPrefix}_${index}`,
        items: [
          {
            skuId: config.skuId,
            quantity: 1,
            unitPriceAmountMinor: 100000,
            currency: "TWD",
          },
        ],
      }),
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    const body = (await response.json().catch(() => null)) as {
      checkoutIntentId?: string;
      idempotentReplay?: boolean;
      error?: string;
    } | null;

    return {
      ok: response.ok,
      status: response.status,
      latencyMs,
      checkoutIntentId: body?.checkoutIntentId,
      idempotentReplay: body?.idempotentReplay,
      error: body?.error,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

async function processProjectionBatch() {
  await fetch(`${config.appUrl}/api/internal/projections/process`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": `req_${config.runId}_projection`,
      "x-trace-id": `trace_${config.runId}`,
    },
    body: JSON.stringify({
      projectionName: "main",
      batchSize: config.projectionBatchSize,
    }),
  });
}

async function readEventCount(pool: Pool) {
  const result = await pool.query<EventCountRow>("select count(*) as count from event_store");
  return Number(result.rows[0]?.count ?? 0);
}

async function readStatusDistribution(pool: Pool) {
  const result = await pool.query<StatusDistributionRow>(`
    select status, count(*) as count
    from checkout_intent_projection
    group by status
    order by status
  `);

  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
}

async function readInventory(pool: Pool, skuId: string) {
  const result = await pool.query<InventoryRow>(
    `
      select sku_id, on_hand, reserved, sold, available, last_event_id, aggregate_version
      from sku_inventory_projection
      where sku_id = $1
    `,
    [skuId],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    skuId: row.sku_id,
    onHand: row.on_hand,
    reserved: row.reserved,
    sold: row.sold,
    available: row.available,
    lastEventId: Number(row.last_event_id),
    aggregateVersion: Number(row.aggregate_version),
    noOversell: row.available >= 0 && row.reserved >= 0 && row.sold >= 0,
  };
}

async function readCheckpoint(pool: Pool) {
  const result = await pool.query<CheckpointRow>(
    "select last_event_id from projection_checkpoint where projection_name = 'main'",
  );

  return Number(result.rows[0]?.last_event_id ?? 0);
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
}

function readConfig(): BenchmarkConfig {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Day 1 benchmark.");
  }

  return {
    appUrl: process.env.BENCHMARK_APP_URL ?? "http://localhost:3000",
    databaseUrl,
    requests: readPositiveIntegerEnv("BENCHMARK_REQUESTS", 1000),
    projectionBatchSize: readPositiveIntegerEnv("BENCHMARK_PROJECTION_BATCH_SIZE", 1000),
    skuId: process.env.BENCHMARK_SKU_ID ?? "sku_hot_001",
    buyerPrefix: process.env.BENCHMARK_BUYER_PREFIX ?? "benchmark_buyer",
    runId: process.env.BENCHMARK_RUN_ID ?? `bench_${Date.now()}`,
  };
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
