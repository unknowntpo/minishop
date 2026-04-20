import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";

type BenchmarkConfig = {
  appUrl: string;
  databaseUrl: string;
  requests: number;
  httpConcurrency: number;
  profilingEnabled: boolean;
  skuId: string;
  unitPriceAmountMinor: number;
  currency: string;
  buyerPrefix: string;
  runId: string;
  resultsDir: string;
  scenarioName: string;
  mode: "temporal" | "bypass";
};

type AcceptResult = {
  ok: boolean;
  status: number;
  latencyMs: number;
  requestStartedAtMs?: number;
  commandId?: string;
  error?: string;
  acceptedAtMs?: number;
};

type CreatedResult = {
  commandId: string;
  status: string;
  checkoutIntentId: string | null;
  eventId: string | null;
  isDuplicate: boolean;
  latencyMs: number;
};

type CheckoutResult = {
  checkoutIntentId: string;
  status: string;
  paymentId: string | null;
  orderId: string | null;
  latencyMs: number;
};

type PaymentSignalResult = {
  commandId: string;
  status: number;
  latencyMs: number;
  signaledAtMs: number;
};

type BenchmarkProfilingMetadata = {
  enabled: boolean;
  status: "disabled" | "captured" | "failed";
  target?: string;
  scope?: string;
  format?: string;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
  files?: Array<{
    kind: "cpu";
    path: string;
    label: string;
  }>;
};

const config = readConfig();

async function main() {
  const startedAtIso = new Date().toISOString();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 4,
  });
  await assertAppReachable(config.appUrl);

  try {
    const inventory = await readInventory(config.skuId);
    const effectiveRequests =
      config.mode === "bypass" ? config.requests : Math.min(config.requests, inventory.available);

    if (effectiveRequests < 1) {
      throw new Error(
        `No available inventory for ${config.skuId}. Current available units: ${inventory.available}.`,
      );
    }

    const profilingPlan = createProfilingPlan();
    let profiling = await maybeStartProfiling();
    const acceptStartedAt = performance.now();
    let acceptResults: AcceptResult[] = [];
    let accepted: Array<AcceptResult & { commandId: string; acceptedAtMs: number }> = [];
    let createdResults: CreatedResult[] = [];
    let displayReadyResults: CheckoutResult[] = [];
    let paymentSignalResults: PaymentSignalResult[] = [];
    let cancelledResults: CheckoutResult[] = [];
    let acceptDurationMs = 0;

    try {
      acceptResults = await runWithConcurrency(
        effectiveRequests,
        config.httpConcurrency,
        async (index) => createBuyIntent(index),
      );
      acceptDurationMs = performance.now() - acceptStartedAt;

      accepted = acceptResults.filter(
        (result): result is AcceptResult & { commandId: string; acceptedAtMs: number } =>
          result.ok &&
          typeof result.commandId === "string" &&
          typeof result.acceptedAtMs === "number",
      );

      if (accepted.length === 0) {
        throw new Error("No benchmark requests were accepted.");
      }

      const createdBatch = await waitForCreatedStatuses(pool, accepted);
      createdResults = createdBatch.results;

      if (createdBatch.pendingCommandIds.length > 0) {
        throw new Error(
          `Commands did not reach terminal status in time: ${createdBatch.pendingCommandIds.slice(0, 10).join(", ")}${createdBatch.pendingCommandIds.length > 10 ? "..." : ""}`,
        );
      }

      const acceptedAtByCommandId = new Map(
        accepted.map((result) => [result.commandId, result.acceptedAtMs] as const),
      );

      displayReadyResults =
        config.mode === "temporal"
          ? await Promise.all(
              createdResults
                .filter(
                  (result) =>
                    typeof result.checkoutIntentId === "string" && result.checkoutIntentId.length > 0,
                )
                .map((result) =>
                  waitForCheckoutStatus(
                    result.checkoutIntentId as string,
                    acceptedAtByCommandId.get(result.commandId) ?? performance.now(),
                    (status) => status === "pending_payment" || status === "rejected",
                    "pending_payment or rejected",
                  ),
                ),
            )
          : [];

      const pendingPaymentCheckouts =
        config.mode === "temporal"
          ? displayReadyResults.filter((result) => result.status === "pending_payment")
          : [];
      const paymentSignalRun =
        config.mode === "temporal"
          ? await runPaymentFailureSignals(pendingPaymentCheckouts, createdResults)
          : { results: [], durationMs: 0 };
      paymentSignalResults = paymentSignalRun.results;
      const signalDurationMs = paymentSignalRun.durationMs;

      cancelledResults =
        config.mode === "temporal"
          ? await Promise.all(
              paymentSignalResults.map((signalResult) => {
                const checkout = pendingPaymentCheckouts.find((entry) => {
                  const command = createdResults.find(
                    (result) => result.checkoutIntentId === entry.checkoutIntentId,
                  );
                  return command?.commandId === signalResult.commandId;
                });

                if (!checkout) {
                  throw new Error(
                    `Missing checkout for payment signal command ${signalResult.commandId}.`,
                  );
                }

                return waitForCheckoutStatus(
                  checkout.checkoutIntentId,
                  signalResult.signaledAtMs,
                  (status) => status === "cancelled" || status === "expired",
                  "cancelled or expired",
                );
              }),
            )
          : [];

      const intentCreation = await readIntentCreationMetrics(
        pool,
        createdResults
          .filter(
            (result) =>
              result.status === "created" &&
              typeof result.checkoutIntentId === "string" &&
              result.checkoutIntentId,
          )
          .map((result) => ({
            checkoutIntentId: result.checkoutIntentId as string,
            requestStartedAtMs:
              accepted.find((entry) => entry.commandId === result.commandId)?.requestStartedAtMs ??
              null,
          }))
      );

      const natsSnapshot = await readNatsSnapshot();
      profiling = await maybeStopProfiling(profilingPlan, profiling);
      const finishedAtIso = new Date().toISOString();

      const report = {
        schemaVersion: 1,
        pass: true,
        scenarioName: config.scenarioName,
        runId: config.runId,
        startedAt: startedAtIso,
        finishedAt: finishedAtIso,
        environment: {
          runtime: process.version,
          platform: `${os.platform()} ${os.arch()}`,
          cpuCount: os.cpus().length,
          cpuModel: os.cpus()[0]?.model ?? "unknown",
          totalMemoryBytes: os.totalmem(),
          appUrl: config.appUrl,
          skuId: config.skuId,
        },
        conditions: {
          workload: {
            scenarioName: config.scenarioName,
            architectureLane: config.mode === "temporal" ? "temporal" : "bypass",
            workloadType: "buy_intent_temporal_flow",
            requestedBuyClicks: config.requests,
            httpConcurrency: config.httpConcurrency,
            skuId: config.skuId,
            quantityPerIntent: 1,
            profilingEnabled: config.profilingEnabled,
          },
          requestedBuyIntents: config.requests,
          effectiveBuyIntents: effectiveRequests,
          httpConcurrency: config.httpConcurrency,
          buyerPrefix: config.buyerPrefix,
          unitPriceAmountMinor: config.unitPriceAmountMinor,
          currency: config.currency,
          startingInventoryAvailable: inventory.available,
          mode: config.mode,
        },
        requestPath: {
          accepted: accepted.length,
          errors: acceptResults.length - accepted.length,
          acceptDurationMs: Math.round(acceptDurationMs),
          acceptRequestsPerSecond: ratePerSecond(accepted.length, acceptDurationMs),
          acceptLatencyMs: summarizeLatencies(acceptResults.map((result) => result.latencyMs)),
          errorDistribution: countBy(
            acceptResults.filter((result) => !result.ok),
            (result) => result.error ?? `HTTP ${result.status}`,
          ),
        },
        intentCreation,
        commandLifecycle: {
          created: createdResults.filter((result) => result.status === "created").length,
          duplicates: createdResults.filter((result) => result.isDuplicate).length,
          createdLatencyMs: summarizeLatencies(createdResults.map((result) => result.latencyMs)),
          createdThroughputPerSecond: ratePerSecond(
            createdResults.length,
            Math.max(...createdResults.map((result) => result.latencyMs)),
          ),
        },
        checkoutLifecycle: {
          displayReadyStatusDistribution: countBy(displayReadyResults, (result) => result.status),
          displayReadyLatencyMs: summarizeLatencies(displayReadyResults.map((result) => result.latencyMs)),
          pendingPayment: displayReadyResults.filter(
            (result) => result.status === "pending_payment",
          ).length,
          rejected: displayReadyResults.filter((result) => result.status === "rejected").length,
          queued: displayReadyResults.filter((result) => result.status === "queued").length,
          paymentFailureSignals: paymentSignalResults.length,
          paymentSignalDurationMs: Math.round(signalDurationMs),
          paymentSignalRequestsPerSecond: ratePerSecond(paymentSignalResults.length, signalDurationMs),
          paymentSignalLatencyMs: summarizeLatencies(
            paymentSignalResults.map((result) => result.latencyMs),
          ),
          resolved: cancelledResults.length,
          resolvedStatusDistribution: countBy(cancelledResults, (result) => result.status),
          resolutionLatencyMs: summarizeLatencies(cancelledResults.map((result) => result.latencyMs)),
          resolutionThroughputPerSecond: ratePerSecond(
            cancelledResults.length,
            Math.max(...cancelledResults.map((result) => result.latencyMs), 1),
          ),
        },
        profiling,
        nats: natsSnapshot,
        notes: [
          config.mode === "temporal"
            ? "This benchmark measures the current async buy-intent + Temporal + pending_payment demo path."
            : "This benchmark measures the async buy-intent path with Temporal orchestration bypassed and stops at CheckoutIntentCreated.",
          config.mode === "temporal"
            ? "The benchmark intentionally uses payment failure signals so reserved inventory is released after each run."
            : "Bypass mode does not wait for projection queued state, so inventory availability is not used to cap request volume.",
        ],
      };

      const artifactPath = await writeBenchmarkArtifact(report);

      console.log(JSON.stringify(report, null, 2));
      console.log(`Benchmark artifact written to ${artifactPath}`);
    } catch (error) {
      profiling = await maybeStopProfiling(profilingPlan, profiling);
      const natsSnapshot = await readNatsSnapshot().catch(() => ({ available: false }));
      const finishedAtIso = new Date().toISOString();
      const failureMessage = error instanceof Error ? error.message : "unknown benchmark failure";
      const intentCreation = await readIntentCreationMetrics(
        pool,
        createdResults
          .filter(
            (result) =>
              result.status === "created" &&
              typeof result.checkoutIntentId === "string" &&
              result.checkoutIntentId,
          )
          .map((result) => ({
            checkoutIntentId: result.checkoutIntentId as string,
            requestStartedAtMs:
              accepted.find((entry) => entry.commandId === result.commandId)?.requestStartedAtMs ??
              null,
          }))
      );
      const artifactPath = await writeBenchmarkArtifact({
        schemaVersion: 1,
        pass: false,
        scenarioName: config.scenarioName,
        runId: config.runId,
        startedAt: startedAtIso,
        finishedAt: finishedAtIso,
        environment: {
          runtime: process.version,
          platform: `${os.platform()} ${os.arch()}`,
          cpuCount: os.cpus().length,
          cpuModel: os.cpus()[0]?.model ?? "unknown",
          totalMemoryBytes: os.totalmem(),
          appUrl: config.appUrl,
          skuId: config.skuId,
        },
        conditions: {
          workload: {
            scenarioName: config.scenarioName,
            architectureLane: config.mode === "temporal" ? "temporal" : "bypass",
            workloadType: "buy_intent_temporal_flow",
            requestedBuyClicks: config.requests,
            httpConcurrency: config.httpConcurrency,
            skuId: config.skuId,
            quantityPerIntent: 1,
            profilingEnabled: config.profilingEnabled,
          },
          requestedBuyIntents: config.requests,
          effectiveBuyIntents: effectiveRequests,
          httpConcurrency: config.httpConcurrency,
          buyerPrefix: config.buyerPrefix,
          unitPriceAmountMinor: config.unitPriceAmountMinor,
          currency: config.currency,
          startingInventoryAvailable: inventory.available,
          mode: config.mode,
        },
        requestPath: {
          accepted: accepted.length,
          errors: Math.max(acceptResults.length - accepted.length, 0),
          acceptDurationMs: Math.round(acceptDurationMs),
          acceptRequestsPerSecond: ratePerSecond(accepted.length, acceptDurationMs),
          acceptLatencyMs: summarizeLatencies(acceptResults.map((result) => result.latencyMs)),
          errorDistribution: countBy(
            acceptResults.filter((result) => !result.ok),
            (result) => result.error ?? `HTTP ${result.status}`,
          ),
        },
        intentCreation,
        commandLifecycle: {
          created: createdResults.filter((result) => result.status === "created").length,
          duplicates: createdResults.filter((result) => result.isDuplicate).length,
          createdLatencyMs: summarizeLatencies(createdResults.map((result) => result.latencyMs)),
          createdThroughputPerSecond: ratePerSecond(
            createdResults.length,
            Math.max(...createdResults.map((result) => result.latencyMs), 1),
          ),
        },
        checkoutLifecycle: {
          displayReadyStatusDistribution: countBy(displayReadyResults, (result) => result.status),
          displayReadyLatencyMs: summarizeLatencies(displayReadyResults.map((result) => result.latencyMs)),
          pendingPayment: displayReadyResults.filter(
            (result) => result.status === "pending_payment",
          ).length,
          rejected: displayReadyResults.filter((result) => result.status === "rejected").length,
          queued: displayReadyResults.filter((result) => result.status === "queued").length,
          paymentFailureSignals: paymentSignalResults.length,
          paymentSignalDurationMs: 0,
          paymentSignalRequestsPerSecond: 0,
          paymentSignalLatencyMs: summarizeLatencies(
            paymentSignalResults.map((result) => result.latencyMs),
          ),
          resolved: cancelledResults.length,
          resolvedStatusDistribution: countBy(cancelledResults, (result) => result.status),
          resolutionLatencyMs: summarizeLatencies(cancelledResults.map((result) => result.latencyMs)),
          resolutionThroughputPerSecond: 0,
        },
        profiling,
        nats: natsSnapshot,
        failure: {
          message: failureMessage,
          stage:
            config.mode === "bypass"
              ? createdResults.length < accepted.length
                ? "created"
                : "accept"
              : cancelledResults.length < paymentSignalResults.length
                ? "resolution"
                : paymentSignalResults.length <
                      displayReadyResults.filter((result) => result.status === "pending_payment").length
                  ? "payment_signal"
                  : displayReadyResults.length <
                        createdResults.filter((result) => result.checkoutIntentId).length
                    ? "display_ready"
                    : createdResults.length < accepted.length
                      ? "created"
                      : "accept",
        },
        notes: [
          "This artifact was written from a failed benchmark run so the dashboard can still show partial progress and profiling evidence.",
          config.mode === "bypass"
            ? "Bypass mode failure happened after intent creation; created-only throughput remains the primary signal."
            : "Temporal mode failure happened after intent creation; checkout progression needs separate analysis.",
        ],
      });
      console.error(`Benchmark artifact written to ${artifactPath}`);
      throw error;
    }
  } finally {
    await pool.end();
  }
}

async function createBuyIntent(index: number): Promise<AcceptResult> {
  const requestStartedAtMs = performance.timeOrigin + performance.now();
  const startedAt = performance.now();

  try {
    const response = await fetch(`${config.appUrl}/api/buy-intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${config.runId}-${index}`,
        "x-request-id": crypto.randomUUID(),
        "x-trace-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        buyerId: `${config.buyerPrefix}_${index}`,
        items: [
          {
            skuId: config.skuId,
            quantity: 1,
            unitPriceAmountMinor: config.unitPriceAmountMinor,
            currency: config.currency,
          },
        ],
      }),
    });

    const latencyMs = performance.now() - startedAt;

    if (response.status !== 202) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        error: `HTTP ${response.status}`,
      };
    }

    const body = (await response.json()) as { commandId: string };

    return {
      ok: true,
      status: response.status,
      latencyMs,
      requestStartedAtMs,
      commandId: body.commandId,
      acceptedAtMs: performance.timeOrigin + performance.now(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: performance.now() - startedAt,
      requestStartedAtMs,
      error: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

async function waitForCreatedStatuses(
  pool: Pool,
  accepted: Array<AcceptResult & { commandId: string; acceptedAtMs: number }>,
) {
  const acceptedAtByCommandId = new Map(
    accepted.map((result) => [result.commandId, result.acceptedAtMs] as const),
  );
  const pendingCommandIds = new Set(accepted.map((result) => result.commandId));
  const resultsByCommandId = new Map<string, CreatedResult>();
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline && pendingCommandIds.size > 0) {
    const rows = await readCommandStatusBatch(pool, [...pendingCommandIds]);

    for (const row of rows) {
      if (row.status !== "created" && row.status !== "failed") {
        continue;
      }

      const acceptedAtMs = acceptedAtByCommandId.get(row.commandId);
      if (typeof acceptedAtMs !== "number") {
        continue;
      }

      resultsByCommandId.set(row.commandId, {
        commandId: row.commandId,
        status: row.status,
        checkoutIntentId: row.checkoutIntentId,
        eventId: row.eventId,
        isDuplicate: row.isDuplicate,
        latencyMs: Math.max(0, row.updatedAtMs - acceptedAtMs),
      });
      pendingCommandIds.delete(row.commandId);
    }

    if (pendingCommandIds.size === 0) {
      break;
    }

    await sleep(100);
  }

  return {
    results: accepted
      .map((result) => resultsByCommandId.get(result.commandId))
      .filter((result): result is CreatedResult => typeof result !== "undefined"),
    pendingCommandIds: [...pendingCommandIds],
  };
}

async function waitForCheckoutStatus(
  checkoutIntentId: string,
  startedAtMs: number,
  predicate: (status: string) => boolean,
  expectedDescription: string,
): Promise<CheckoutResult> {
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    await fetch(`${config.appUrl}/api/internal/projections/process`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectionName: "main",
        batchSize: 200,
      }),
    }).catch(() => undefined);

    const response = await fetch(`${config.appUrl}/api/checkout-intents/${checkoutIntentId}`, {
      cache: "no-store",
    });

    if (response.ok) {
      const body = (await response.json()) as {
        status: string;
        paymentId: string | null;
        orderId: string | null;
      };

      if (predicate(body.status)) {
        return {
          checkoutIntentId,
          status: body.status,
          paymentId: body.paymentId,
          orderId: body.orderId,
          latencyMs: performance.now() - startedAtMs,
        };
      }
    }

    await sleep(100);
  }

  throw new Error(
    `Checkout intent ${checkoutIntentId} did not reach ${expectedDescription} in time.`,
  );
}

async function failPayment(commandId: string): Promise<PaymentSignalResult> {
  const startedAt = performance.now();
  const response = await fetch(`${config.appUrl}/api/internal/buy-intent-commands/${commandId}/payment-demo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      outcome: "failed",
    }),
  });

  return {
    commandId,
    status: response.status,
    latencyMs: performance.now() - startedAt,
    signaledAtMs: performance.now(),
  };
}

async function runPaymentFailureSignals(
  pendingPaymentCheckouts: CheckoutResult[],
  createdResults: CreatedResult[],
) {
  const signalStartedAt = performance.now();
  const results = await runWithConcurrency(
    pendingPaymentCheckouts.length,
    config.httpConcurrency,
    async (index) => {
      const checkout = pendingPaymentCheckouts[index];

      if (!checkout) {
        throw new Error(`Missing checkout for payment signal index ${index}.`);
      }

      const command = createdResults.find((result) => result.checkoutIntentId === checkout.checkoutIntentId);

      if (!command) {
        throw new Error(`Missing command for checkout ${checkout.checkoutIntentId}.`);
      }

      return failPayment(command.commandId);
    },
  );

  const durationMs = performance.now() - signalStartedAt;
  return {
    results,
    durationMs,
  };
}

async function readInventory(skuId: string) {
  const response = await fetch(`${config.appUrl}/api/skus/${skuId}/inventory`);

  if (!response.ok) {
    throw new Error(`Inventory read failed with HTTP ${response.status} for ${skuId}.`);
  }

  return (await response.json()) as {
    skuId: string;
    available: number;
    onHand: number;
    reserved: number;
    sold: number;
  };
}

async function readNatsSnapshot() {
  try {
    const jszResponse = await fetch("http://localhost:8222/jsz?streams=true&consumers=true");

    if (!jszResponse.ok) {
      return {
        available: false,
        status: jszResponse.status,
      };
    }

    const body = (await jszResponse.json()) as {
      memory?: number;
      storage?: number;
      api?: { total?: number; errors?: number };
      account_details?: Array<{
        stream_detail?: Array<{
          name?: string;
          state?: {
            messages?: number;
            bytes?: number;
          };
          consumer_detail?: Array<{
            name?: string;
            ack_pending?: number | null;
            num_pending?: number;
          }>;
        }>;
      }>;
    };

    const streamDetail = body.account_details?.[0]?.stream_detail ?? [];

    return {
      available: true,
      memory: body.memory ?? 0,
      storage: body.storage ?? 0,
      apiTotal: body.api?.total ?? 0,
      apiErrors: body.api?.errors ?? 0,
      streams: streamDetail.map((stream) => ({
        name: stream.name ?? "unknown",
        messages: stream.state?.messages ?? 0,
        bytes: stream.state?.bytes ?? 0,
        consumers:
          stream.consumer_detail?.map((consumer) => ({
            name: consumer.name ?? "unknown",
            ackPending: consumer.ack_pending ?? 0,
            numPending: consumer.num_pending ?? 0,
          })) ?? [],
      })),
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

async function readIntentCreationMetrics(
  pool: Pool,
  intents: Array<{ checkoutIntentId: string; requestStartedAtMs: number | null }>,
) {
  if (intents.length === 0) {
    return {
      created: 0,
      createdThroughputPerSecond: 0,
      requestToCreatedLatencyMs: summarizeLatencies([]),
    };
  }

  const checkoutIntentIds = intents.map((entry) => entry.checkoutIntentId);
  const result = await pool.query<{ aggregate_id: string; occurred_at: string }>(
    `
      select aggregate_id, occurred_at
      from event_store
      where aggregate_type = 'checkout'
        and event_type = 'CheckoutIntentCreated'
        and aggregate_id = any($1::text[])
      order by occurred_at asc
    `,
    [checkoutIntentIds],
  );

  const occurredAtByCheckoutIntentId = new Map(
    result.rows.map((row) => [row.aggregate_id, Date.parse(row.occurred_at)] as const),
  );
  const latencies = intents
    .map((entry) => {
      const occurredAtMs = occurredAtByCheckoutIntentId.get(entry.checkoutIntentId);
      if (!occurredAtMs || entry.requestStartedAtMs === null) {
        return null;
      }

      return Math.max(0, occurredAtMs - entry.requestStartedAtMs);
    })
    .filter((value): value is number => value !== null);
  const minRequestStartedAtMs = Math.min(
    ...intents
      .map((entry) => entry.requestStartedAtMs)
      .filter((value): value is number => typeof value === "number"),
  );
  const maxOccurredAtMs = Math.max(...result.rows.map((row) => Date.parse(row.occurred_at)), 0);

  return {
    created: result.rows.length,
    createdThroughputPerSecond:
      Number.isFinite(minRequestStartedAtMs) && maxOccurredAtMs >= minRequestStartedAtMs
        ? ratePerSecond(result.rows.length, Math.max(maxOccurredAtMs - minRequestStartedAtMs, 1))
        : 0,
    requestToCreatedLatencyMs: summarizeLatencies(latencies),
  };
}

async function readCommandStatusBatch(pool: Pool, commandIds: string[]) {
  if (commandIds.length === 0) {
    return [];
  }

  const rows: Array<{
    commandId: string;
    status: string;
    checkoutIntentId: string | null;
    eventId: string | null;
    isDuplicate: boolean;
    updatedAtMs: number;
  }> = [];

  for (const chunk of chunked(commandIds, 1_000)) {
    const result = await pool.query<{
      command_id: string;
      status: string;
      checkout_intent_id: string | null;
      event_id: string | null;
      is_duplicate: boolean;
      updated_at: string;
    }>(
      `
        select
          command_id::text,
          status,
          checkout_intent_id::text,
          event_id::text,
          is_duplicate,
          updated_at
        from command_status
        where command_id = any($1::uuid[])
      `,
      [chunk],
    );

    rows.push(
      ...result.rows.map((row) => ({
        commandId: row.command_id,
        status: row.status,
        checkoutIntentId: row.checkout_intent_id,
        eventId: row.event_id,
        isDuplicate: row.is_duplicate,
        updatedAtMs: Date.parse(row.updated_at),
      })),
    );
  }

  return rows;
}

async function assertAppReachable(appUrl: string) {
  const response = await fetch(`${appUrl}/products`);

  if (!response.ok) {
    throw new Error(`Benchmark app preflight failed: ${appUrl}/products returned ${response.status}.`);
  }
}

function summarizeLatencies(values: number[]) {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.max(0, ...values),
  };
}

function ratePerSecond(total: number, durationMs: number) {
  return Number((total / Math.max(durationMs / 1000, 0.001)).toFixed(2));
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return Number((sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0).toFixed(2));
}

function countBy<T>(values: T[], keyFor: (value: T) => string) {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = keyFor(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function chunked<T>(values: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
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
  const directory = path.join(config.resultsDir, config.scenarioName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(directory, `${timestamp}_${config.runId}.json`);

  await mkdir(directory, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return filePath;
}

function createProfilingPlan() {
  const directory = path.join(config.resultsDir, config.scenarioName, "profiles");
  const fileName = `${config.runId}.app.cpuprofile`;

  return {
    directory,
    absolutePath: path.join(directory, fileName),
    relativePath: path.join(config.scenarioName, "profiles", fileName),
  };
}

async function maybeStartProfiling(): Promise<BenchmarkProfilingMetadata> {
  if (!config.profilingEnabled) {
    return {
      enabled: false,
      status: "disabled",
    };
  }

  const response = await fetch(`${config.appUrl}/api/internal/benchmarks/profiling`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": `req_${config.runId}_profiling_start`,
      "x-trace-id": `trace_${config.runId}`,
    },
    body: JSON.stringify({
      action: "start",
      runId: config.runId,
      label: `${config.scenarioName} app cpu`,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;

    return {
      enabled: true,
      status: "failed",
      target: "nextjs-app-process",
      scope: "buy-intent-benchmark",
      error: body?.error ?? `HTTP ${response.status}`,
    };
  }

  const body = (await response.json()) as {
    startedAt: string;
  };

  return {
    enabled: true,
    status: "captured",
    target: "nextjs-app-process",
    scope: "buy-intent-benchmark",
    startedAt: body.startedAt,
    files: [],
  };
}

async function maybeStopProfiling(
  plan: ReturnType<typeof createProfilingPlan>,
  current: BenchmarkProfilingMetadata,
): Promise<BenchmarkProfilingMetadata> {
  if (!config.profilingEnabled || current.status === "failed") {
    return current;
  }

  try {
    const response = await fetch(`${config.appUrl}/api/internal/benchmarks/profiling`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": `req_${config.runId}_profiling_stop`,
        "x-trace-id": `trace_${config.runId}`,
      },
      body: JSON.stringify({
        action: "stop",
        runId: config.runId,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;

      return {
        ...current,
        status: "failed",
        error: body?.error ?? `HTTP ${response.status}`,
      };
    }

    const body = (await response.json()) as {
      format: "cpuprofile";
      profile: object;
      startedAt: string;
      stoppedAt: string;
    };

    await mkdir(plan.directory, { recursive: true });
    await writeFile(plan.absolutePath, `${JSON.stringify(body.profile)}\n`, "utf8");

    return {
      enabled: true,
      status: "captured",
      target: "nextjs-app-process",
      scope: "buy-intent-benchmark",
      format: body.format,
      startedAt: body.startedAt,
      stoppedAt: body.stoppedAt,
      files: [
        {
          kind: "cpu",
          path: plan.relativePath,
          label: "app CPU profile",
        },
      ],
    };
  } catch (error) {
    return {
      ...current,
      status: "failed",
      error: error instanceof Error ? error.message : "unknown profiling failure",
    };
  }
}

function readConfig(): BenchmarkConfig {
  return {
    appUrl: process.env.BENCHMARK_APP_URL ?? "http://localhost:3000",
    databaseUrl: requiredEnv("DATABASE_URL"),
    requests: readPositiveIntegerEnv("BENCHMARK_REQUESTS", 20),
    httpConcurrency: readPositiveIntegerEnv("BENCHMARK_HTTP_CONCURRENCY", 10),
    profilingEnabled: process.env.BENCHMARK_PROFILE === "1",
    skuId: process.env.BENCHMARK_SKU_ID ?? "sku_hot_001",
    unitPriceAmountMinor: readPositiveIntegerEnv("BENCHMARK_UNIT_PRICE_MINOR", 1200),
    currency: process.env.BENCHMARK_CURRENCY ?? "TWD",
    buyerPrefix: process.env.BENCHMARK_BUYER_PREFIX ?? "benchmark_buyer_temporal",
    runId: process.env.BENCHMARK_RUN_ID ?? `bench_${Date.now()}`,
    resultsDir: process.env.BENCHMARK_RESULTS_DIR ?? "benchmark-results",
    scenarioName:
      process.env.BENCHMARK_SCENARIO_NAME ??
      (readMode() === "temporal" ? "buy-intent-temporal-payment-fail" : "buy-intent-bypass-created"),
    mode: readMode(),
  };
}

function requiredEnv(name: string) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    throw new Error(`${name} is required.`);
  }

  return raw;
}

function readMode(): "temporal" | "bypass" {
  const raw = process.env.BENCHMARK_TEMPORAL_MODE?.trim();

  if (!raw || raw === "temporal") {
    return "temporal";
  }

  if (raw === "bypass") {
    return "bypass";
  }

  throw new Error("BENCHMARK_TEMPORAL_MODE must be temporal or bypass.");
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
