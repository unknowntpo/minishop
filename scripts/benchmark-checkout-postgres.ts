import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";

const scenarioName = "checkout-postgres-baseline";

type BenchmarkConfig = {
  appUrl: string;
  databaseUrl: string;
  requests: number;
  httpConcurrency: number;
  appInstanceCount: number;
  nextMode: string;
  postgresInstanceCount: number;
  postgresPoolMax: number;
  projectionBatchSize: number;
  skuId: string;
  buyerPrefix: string;
  runId: string;
  resultsDir: string;
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

type EventTypeDistributionRow = {
  event_type: string;
  count: string | number;
};

const config = readConfig();

async function main() {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.postgresPoolMax,
  });
  const startedAtIso = new Date().toISOString();

  try {
    const beforeEventCount = await readEventCount(pool);
    const startedAt = performance.now();
    // Keep the load shape explicit: the benchmark may submit many requests, but
    // only up to BENCHMARK_HTTP_CONCURRENCY should be in flight at once.
    const results = await runWithConcurrency(config.requests, config.httpConcurrency, (index) =>
      createCheckoutIntent(index),
    );
    const totalMs = performance.now() - startedAt;
    const duplicateReplay = await replayDuplicateIdempotencyKey();

    const projectionProcessing = await processProjectionUntilCaughtUp(pool);

    const [afterEventCount, eventTypeDistribution, statusDistribution, inventory, checkpoint] =
      await Promise.all([
        readEventCount(pool),
        readEventTypeDistribution(pool),
        readStatusDistribution(pool),
        readInventory(pool, config.skuId),
        readCheckpoint(pool),
      ]);

    const accepted = results.filter((result) => result.ok).length;
    const errors = results.filter((result) => !result.ok).length;
    const latencies = results.map((result) => result.latencyMs);
    const appendedEvents = afterEventCount - beforeEventCount;
    const finishedAtIso = new Date().toISOString();
    const pass =
      errors === 0 &&
      appendedEvents === accepted &&
      Math.max(0, afterEventCount - checkpoint) === 0;

    const report = {
      schemaVersion: 1,
      runId: config.runId,
      scenarioName,
      startedAt: startedAtIso,
      finishedAt: finishedAtIso,
      environment: {
        runtime: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        cpuCount: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        totalMemoryBytes: os.totalmem(),
        appUrl: config.appUrl,
        database: "postgresql",
        kafka: "disabled",
        redis: "disabled",
        paymentProvider: "disabled",
      },
      conditions: buildRunConditions(),
      pass,
      scenario: {
        skuId: config.skuId,
        workloadType: "single_sku_direct_buy",
        requestedBuyClicks: config.requests,
        httpConcurrency: config.httpConcurrency,
        cartSkuCount: 1,
        quantityPerIntent: 1,
      },
      requestPath: {
        accepted,
        errors,
        statusDistribution: countBy(results, (result) => String(result.status)),
        errorDistribution: countBy(
          results.filter((result) => !result.ok),
          (result) => result.error ?? `HTTP ${result.status}`,
        ),
        duplicateReplay: {
          status: duplicateReplay.status,
          idempotentReplay: duplicateReplay.idempotentReplay ?? false,
          checkoutIntentId: duplicateReplay.checkoutIntentId ?? null,
        },
        p50LatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
        p99LatencyMs: percentile(latencies, 99),
        maxLatencyMs: Math.max(0, ...latencies),
        totalDurationMs: Math.round(totalMs),
        requestsPerSecond: Number((results.length / (totalMs / 1000)).toFixed(2)),
      },
      eventStore: {
        beforeEventCount,
        afterEventCount,
        appendedEvents,
        appendThroughputPerSecond: Number((appendedEvents / (totalMs / 1000)).toFixed(2)),
        eventTypeDistribution,
      },
      projections: {
        processedEvents: projectionProcessing.processedEvents,
        processRuns: projectionProcessing.runs,
        checkpointLastEventId: checkpoint,
        eventStoreLastEventId: afterEventCount,
        checkpointLagEvents: Math.max(0, afterEventCount - checkpoint),
        projectionDurationMs: projectionProcessing.durationMs,
        projectionThroughputEventsPerSecond: Number(
          (
            projectionProcessing.processedEvents /
            Math.max(projectionProcessing.durationMs / 1000, 0.001)
          ).toFixed(2),
        ),
        checkoutProjectionCount: Object.values(statusDistribution).reduce(
          (total, count) => total + count,
          0,
        ),
        checkoutStatusDistribution: statusDistribution,
        skuInventory: inventory,
      },
      notes: [
        "Kafka, Redis, SSE, WebSocket, and real payment providers are intentionally excluded.",
        "Until reservation workers are wired end-to-end, accepted intents may remain queued.",
      ],
    };

    const artifactPath = await writeBenchmarkArtifact(report);

    console.log(JSON.stringify(report, null, 2));
    console.log(`Benchmark artifact written to ${artifactPath}`);

    if (!pass) {
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
  const response = await fetch(`${config.appUrl}/api/internal/projections/process`, {
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

  if (!response.ok) {
    throw new Error(`Projection process request failed with HTTP ${response.status}.`);
  }

  return (await response.json()) as {
    locked: boolean;
    processedEvents: number;
  };
}

async function processProjectionUntilCaughtUp(pool: Pool) {
  const startedAt = performance.now();
  let processedEvents = 0;
  let runs = 0;

  while (true) {
    const beforeEventCount = await readEventCount(pool);
    const checkpointBefore = await readCheckpoint(pool);

    if (checkpointBefore >= beforeEventCount) {
      break;
    }

    const result = await processProjectionBatch();
    runs += 1;

    if (!result.locked) {
      throw new Error("Projection processor could not acquire the advisory lock during benchmark.");
    }

    processedEvents += result.processedEvents;

    if (result.processedEvents < config.projectionBatchSize) {
      break;
    }
  }

  return {
    processedEvents,
    runs,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function readEventCount(pool: Pool) {
  const result = await pool.query<EventCountRow>("select count(*) as count from event_store");
  return Number(result.rows[0]?.count ?? 0);
}

async function readEventTypeDistribution(pool: Pool) {
  const result = await pool.query<EventTypeDistributionRow>(`
    select event_type, count(*) as count
    from event_store
    group by event_type
    order by event_type
  `);

  return Object.fromEntries(result.rows.map((row) => [row.event_type, Number(row.count)]));
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

function buildRunConditions() {
  const parsedDatabaseUrl = new URL(config.databaseUrl);

  return {
    hardware: {
      platform: `${os.platform()} ${os.arch()}`,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      totalMemoryBytes: os.totalmem(),
    },
    software: {
      node: process.version,
      nextMode: config.nextMode,
      packageManager: "pnpm",
      loadGenerator: "node-fetch-concurrency-runner",
    },
    services: {
      nextjs: {
        appUrl: config.appUrl,
        instanceCount: config.appInstanceCount,
      },
      postgres: {
        host: parsedDatabaseUrl.hostname,
        port: Number(parsedDatabaseUrl.port || 5432),
        database: parsedDatabaseUrl.pathname.replace(/^\//, ""),
        instanceCount: config.postgresInstanceCount,
        poolMax: config.postgresPoolMax,
      },
      redis: {
        enabled: false,
        instanceCount: 0,
      },
      kafka: {
        enabled: false,
        brokerCount: 0,
      },
      paymentProvider: {
        enabled: false,
      },
    },
    workload: {
      scenarioName,
      workloadType: "single_sku_direct_buy",
      requestedBuyClicks: config.requests,
      httpConcurrency: config.httpConcurrency,
      skuId: config.skuId,
      cartSkuCount: 1,
      quantityPerIntent: 1,
      projectionBatchSize: config.projectionBatchSize,
    },
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

function countBy<T>(values: T[], keyFor: (value: T) => string) {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = keyFor(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function runWithConcurrency<T>(
  total: number,
  concurrency: number,
  taskFor: (index: number) => Promise<T>,
) {
  const results = new Array<T>(total);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= total) {
        return;
      }

      results[currentIndex] = await taskFor(currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, () => worker()),
  );

  return results;
}

async function writeBenchmarkArtifact(report: object) {
  const directory = path.join(config.resultsDir, scenarioName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(directory, `${timestamp}_${config.runId}.json`);

  await mkdir(directory, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return filePath;
}

function readConfig(): BenchmarkConfig {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for checkout-postgres-baseline benchmark.");
  }

  return {
    appUrl: process.env.BENCHMARK_APP_URL ?? "http://localhost:3000",
    databaseUrl,
    requests: readPositiveIntegerEnv("BENCHMARK_REQUESTS", 1000),
    httpConcurrency: readPositiveIntegerEnv("BENCHMARK_HTTP_CONCURRENCY", 1000),
    appInstanceCount: readPositiveIntegerEnv("BENCHMARK_NEXTJS_INSTANCES", 1),
    nextMode: process.env.BENCHMARK_NEXT_MODE ?? "next dev",
    postgresInstanceCount: readPositiveIntegerEnv("BENCHMARK_POSTGRES_INSTANCES", 1),
    postgresPoolMax: readPositiveIntegerEnv("BENCHMARK_POSTGRES_POOL_MAX", 5),
    projectionBatchSize: readPositiveIntegerEnv("BENCHMARK_PROJECTION_BATCH_SIZE", 1000),
    skuId: process.env.BENCHMARK_SKU_ID ?? "sku_hot_001",
    buyerPrefix: process.env.BENCHMARK_BUYER_PREFIX ?? "benchmark_buyer",
    runId: process.env.BENCHMARK_RUN_ID ?? `bench_${Date.now()}`,
    resultsDir: process.env.BENCHMARK_RESULTS_DIR ?? "benchmark-results",
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
