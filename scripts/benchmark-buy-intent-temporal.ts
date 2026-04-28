import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";
import { loadConfluentKafkaJsCompat } from "@/src/infrastructure/kafka/confluent-kafka";
import type { SeckillBuyIntentRequest } from "@/src/domain/seckill/seckill-buy-intent-request";

type BenchmarkConfig = {
  appUrl: string;
  appUrls: string[];
  ingressAppUrl: string;
  ingressAppUrls: string[];
  prometheusUrl?: string;
  databaseUrl: string;
  kafkaBrokers: string[];
  scenarioFamily?: string;
  seckillRequestTopic: string;
  seckillResultTopic: string;
  seckillDlqTopic: string;
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
  mode: "bypass";
  ingressSource: "http" | "direct_kafka";
  benchmarkStyle: "burst" | "steady_state";
  createdTimeoutMs: number;
  resetStateBeforeRun: boolean;
  createdSource: "postgres" | "kafka_seckill_result";
  ensureSeckillEnabled: boolean;
  seckillBucketCount: number;
  seckillMaxProbe: number;
  seckillWorkerReplicas?: number;
  seckillRoutingEpoch?: number;
  directKafkaBatchSize: number;
  kafkaClient: string;
  appPublishBatchSize: number;
  appPublishLingerMs: number;
  producerLingerMs: number;
  producerBatchNumMessages: number;
  steadyStateWarmupMs: number;
  steadyStateMeasureMs: number;
  steadyStateCooldownMs: number;
  ingressImpl?: string;
  benchmarkPath?: string;
  ingressHealthPath: string;
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
  completedAtMs?: number;
};

type SeckillSemanticAssertion = {
  message: string;
  stage: "semantic_assertion";
};

type SeckillCommandOutcome = {
  request: {
    commandId: string;
  };
  result: {
    commandId: string;
    status: "reserved" | "rejected";
    checkoutIntentId: string | null;
    eventId: string | null;
    duplicate: boolean;
  };
  processedAt: string;
};

type SteadyStateStats = {
  windowStartedAtMs: number;
  windowEndedAtMs: number;
  warmupDurationMs: number;
  measureDurationMs: number;
  cooldownDurationMs: number;
  acceptedDuringWindow: number;
  createdWithinWindow: number;
  createdByDrainEnd: number;
  acceptRequestsPerSecond: number;
  createdThroughputPerSecond: number;
};

type BenchmarkMeasurement = {
  key: string;
  label: string;
  unit: string;
  value: number;
  definition?: string;
  calculation?: string;
  interpretation?: string;
};

type BenchmarkSeries = {
  key: string;
  label: string;
  xKey: string;
  xLabel: string;
  xUnit: string;
  yUnit: string;
  points: Array<{
    x: number | string;
    y: number;
    runId?: string;
    pointLabel?: string;
  }>;
  definition?: string;
  calculation?: string;
  interpretation?: string;
};

type BenchmarkAssertion = {
  key: string;
  label: string;
  pass: boolean;
  severity: "info" | "warn" | "error";
  message?: string;
};

type BenchmarkDiagnostics = {
  assertions: BenchmarkAssertion[];
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

type BackendTimingSnapshot = {
  available: boolean;
  targets?: Array<{
    url: string;
    snapshot?: unknown;
    error?: string;
  }>;
};

type BackendTimingTargetSnapshot = {
  counts?: Record<string, number>;
  stages?: Record<string, unknown>;
};

type KafkaTopicSnapshot = {
  topic: string;
  partitions: number;
  totalOffset: number;
};

type PrometheusVectorSample = {
  metric?: Record<string, string>;
  value?: [number, string];
};

type PrometheusCounterSnapshot = {
  sampledAt: string;
  primaryRequestsTotal: number;
  retryScheduledTotal: number;
  retriedRequestsTotal: number;
  resultTotal: number;
  retryEdgeDistribution: Record<string, number>;
  retryAttemptDistribution: Record<string, number>;
  retrySourceBucketDistribution: Record<string, number>;
  retryTargetBucketDistribution: Record<string, number>;
};

type SeckillWorkerReport = {
  available: boolean;
  sampledAt?: string;
  primaryRequests?: number;
  retryScheduled?: number;
  retriedRequests?: number;
  results?: number;
  retryScheduledPerPrimary?: number;
  retriedPerPrimary?: number;
  resultPerPrimary?: number;
  retryEdgeDistribution?: Record<string, number>;
  retryAttemptDistribution?: Record<string, number>;
  retrySourceBucketDistribution?: Record<string, number>;
  retryTargetBucketDistribution?: Record<string, number>;
  error?: string;
};

type ConcurrencyObservation = {
  configured: number;
  workers: number;
  maxInFlight: number;
  totalStarted: number;
  totalCompleted: number;
};

const config = readConfig();

async function main() {
  const startedAtIso = new Date().toISOString();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 4,
  });
  if (config.ingressSource === "http") {
    await assertAppsReachable(config.ingressAppUrls, config.ingressHealthPath);
  }
  const kafkaBefore = await readKafkaBenchmarkSnapshot(config).catch(() => null);
  const seckillWorkerBefore = await readSeckillWorkerCounterSnapshot(config).catch(() => null);
  const seckillCollector =
    config.createdSource === "kafka_seckill_result"
      ? await startSeckillOutcomeCollector(config)
      : null;
  const directKafkaPublisher =
    config.ingressSource === "direct_kafka"
      ? await startDirectSeckillRequestPublisher(config)
      : null;

  try {
    if (config.ensureSeckillEnabled) {
      await ensureBenchmarkSeckillEnabled(pool, config);
      if (config.ingressSource === "http") {
        // Seckill routing is cached in each app process. Let stale false entries expire
        // before the run so the benchmark actually exercises the Kafka path.
        await sleep(5_500);
      }
    }

    if (config.resetStateBeforeRun) {
      await resetBuyIntentBenchmarkState(pool, config.mode);
    }
    await maybeResetBackendTimings();

    const inventory = await readInventory(pool, config.skuId);
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
    let steadyState: SteadyStateStats | null = null;
    let concurrencyObservation: ConcurrencyObservation | null = null;

    try {
      let pendingCreatedCommandIds: string[] = [];

      if (config.benchmarkStyle === "steady_state") {
        const steadyStateRun = await runSteadyStateSeckillBenchmark(
          directKafkaPublisher,
          seckillCollector,
        );
        acceptResults = steadyStateRun.acceptResults;
        accepted = steadyStateRun.accepted;
        createdResults = steadyStateRun.createdResults;
        pendingCreatedCommandIds = steadyStateRun.pendingCreatedCommandIds;
        steadyState = steadyStateRun.steadyState;
        acceptDurationMs = config.steadyStateMeasureMs;
      } else {
        if (config.ingressSource === "direct_kafka") {
          acceptResults = await publishSeckillRequestsDirectly(
            directKafkaPublisher,
            effectiveRequests,
            config,
          );
        } else {
          const observer = createConcurrencyObserver(effectiveRequests, config.httpConcurrency);
          acceptResults = await runWithConcurrency(
            effectiveRequests,
            config.httpConcurrency,
            async (index) => createBuyIntent(index),
            observer,
          );
          concurrencyObservation = observer.snapshot();
        }
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

        const createdBatch =
          config.createdSource === "kafka_seckill_result"
            ? await waitForCreatedSeckillOutcomes(seckillCollector, accepted)
            : await waitForCreatedStatuses(pool, accepted);
        createdResults = createdBatch.results;
        pendingCreatedCommandIds = createdBatch.pendingCommandIds;
      }

      const acceptedAtByCommandId = new Map(
        accepted.map((result) => [result.commandId, result.acceptedAtMs] as const),
      );

      displayReadyResults = [];

      const pendingPaymentCheckouts: CheckoutResult[] = [];
      const paymentSignalRun = { results: [], durationMs: 0 };
      paymentSignalResults = paymentSignalRun.results;
      const signalDurationMs = paymentSignalRun.durationMs;

      cancelledResults = [];

      const intentCreation =
        config.createdSource === "kafka_seckill_result"
          ? readIntentCreationMetricsFromCreatedResults(
              createdResults,
              accepted.map((entry) => ({
                commandId: entry.commandId,
                requestStartedAtMs: entry.requestStartedAtMs ?? null,
                acceptedAtMs: entry.acceptedAtMs,
              })),
            )
          : await readIntentCreationMetrics(
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
                    accepted.find((entry) => entry.commandId === result.commandId)
                      ?.requestStartedAtMs ?? null,
                })),
            );

      const natsSnapshot = await readNatsSnapshot();
      const kafkaAfter = await readKafkaBenchmarkSnapshot(config).catch(() => null);
      const seckillWorkerAfter = await readSeckillWorkerCounterSnapshot(config).catch(() => null);
      const backendTimings = await maybeReadBackendTimings();
      const kafkaDurableAccepted = readBackendTimingCount(
        backendTimings,
        "seckill_publish.delivery_success",
      );
      const kafkaDeliveryErrors = readBackendTimingCount(
        backendTimings,
        "seckill_publish.delivery_error",
      );
      profiling = await maybeStopProfiling(profilingPlan, profiling);
      const finishedAtIso = new Date().toISOString();
      const seckillSemanticAssertion = buildSeckillSemanticAssertion({
        config,
        accepted,
        createdResults,
        startingInventoryAvailable: inventory.available,
      });

      const report = {
        schemaVersion: 2,
        pass:
          acceptResults.length === accepted.length &&
          pendingCreatedCommandIds.length === 0 &&
          !seckillSemanticAssertion,
        scenarioName: config.scenarioName,
        scenarioFamily: readScenarioFamily(config),
        scenarioTags: buildScenarioTags(config),
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
        scenario: {
          requestedBuyClicks: config.requests,
          skuId: config.skuId,
          workloadType: "buy_intent_created_flow",
          quantityPerIntent: 1,
        },
        conditions: {
          workload: {
            scenarioName: config.scenarioName,
            architectureLane: "bypass",
            workloadType: "buy_intent_created_flow",
            requestedBuyClicks: config.requests,
            httpConcurrency: config.httpConcurrency,
            skuId: config.skuId,
            quantityPerIntent: 1,
            profilingEnabled: config.profilingEnabled,
            ingressSource: config.ingressSource,
            benchmarkStyle: config.benchmarkStyle,
          },
          requestedBuyIntents: config.requests,
          effectiveBuyIntents: effectiveRequests,
          httpConcurrency: config.httpConcurrency,
          buyerPrefix: config.buyerPrefix,
          unitPriceAmountMinor: config.unitPriceAmountMinor,
          currency: config.currency,
          startingInventoryAvailable: inventory.available,
          mode: config.mode,
          ingressSource: config.ingressSource,
          benchmarkStyle: config.benchmarkStyle,
        },
        kafka: buildKafkaReport(config, kafkaBefore, kafkaAfter),
        seckillWorker: buildSeckillWorkerReport(seckillWorkerBefore, seckillWorkerAfter),
        backendTimings,
        steadyState,
        requestPath: {
          accepted: accepted.length,
          errors: acceptResults.length - accepted.length,
          kafkaDurableAccepted,
          kafkaDeliveryErrors,
          kafkaDurableAcceptedRate:
            accepted.length > 0 ? kafkaDurableAccepted / accepted.length : null,
          concurrency: concurrencyObservation,
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
          statusDistribution: countBy(createdResults, (result) => result.status),
          pending: pendingCreatedCommandIds.length,
          duplicates: createdResults.filter((result) => result.isDuplicate).length,
          createdLatencyMs: summarizeLatencies(createdResults.map((result) => result.latencyMs)),
          createdThroughputPerSecond:
            config.createdSource === "kafka_seckill_result"
              ? intentCreation.createdThroughputPerSecond
              : ratePerSecond(
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
          config.createdSource === "kafka_seckill_result"
            ? "This benchmark measures the seckill Kafka path and treats durable output-topic results as the created boundary."
            : "This benchmark measures the async buy-intent path and stops at CheckoutIntentCreated.",
          "Bypass mode does not wait for projection queued state, so inventory availability is not used to cap request volume.",
          ...(pendingCreatedCommandIds.length > 0
            ? [
                `Created boundary did not fully converge before timeout; ${pendingCreatedCommandIds.length} accepted commands were still pending.`,
              ]
            : []),
        ],
        ...(seckillSemanticAssertion ??
        (pendingCreatedCommandIds.length > 0
          ? {
              failure: {
                message: `Created boundary did not fully converge before timeout: ${pendingCreatedCommandIds.slice(0, 10).join(", ")}${pendingCreatedCommandIds.length > 10 ? "..." : ""}`,
                stage: "created",
              },
            }
          : {})),
        diagnostics: {
          assertions: [] as BenchmarkAssertion[],
        },
        measurements: [] as BenchmarkMeasurement[],
        series: [] as BenchmarkSeries[],
      };
      report.diagnostics = buildDiagnosticsForReport(report);
      report.measurements = buildMeasurementsFromReport(report);
      report.series = buildSeriesFromReport(report);

      const artifactPath = await writeBenchmarkArtifact(report);

      console.log(JSON.stringify(report, null, 2));
      console.log(`Benchmark artifact written to ${artifactPath}`);
    } catch (error) {
      profiling = await maybeStopProfiling(profilingPlan, profiling);
      const natsSnapshot = await readNatsSnapshot().catch(() => ({ available: false }));
      const kafkaAfter = await readKafkaBenchmarkSnapshot(config).catch(() => null);
      const seckillWorkerAfter = await readSeckillWorkerCounterSnapshot(config).catch(() => null);
      const backendTimings = await maybeReadBackendTimings();
      const kafkaDurableAccepted = readBackendTimingCount(
        backendTimings,
        "seckill_publish.delivery_success",
      );
      const kafkaDeliveryErrors = readBackendTimingCount(
        backendTimings,
        "seckill_publish.delivery_error",
      );
      const finishedAtIso = new Date().toISOString();
      const failureMessage = error instanceof Error ? error.message : "unknown benchmark failure";
      const intentCreation =
        config.createdSource === "kafka_seckill_result"
          ? readIntentCreationMetricsFromCreatedResults(
              createdResults,
              accepted.map((entry) => ({
                commandId: entry.commandId,
                requestStartedAtMs: entry.requestStartedAtMs ?? null,
                acceptedAtMs: entry.acceptedAtMs,
              })),
            )
          : await readIntentCreationMetrics(
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
                    accepted.find((entry) => entry.commandId === result.commandId)
                      ?.requestStartedAtMs ?? null,
                })),
            );
      const report = {
        schemaVersion: 2,
        pass: false,
        scenarioName: config.scenarioName,
        scenarioFamily: readScenarioFamily(config),
        scenarioTags: buildScenarioTags(config),
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
        scenario: {
          requestedBuyClicks: config.requests,
          skuId: config.skuId,
          workloadType: "buy_intent_created_flow",
          quantityPerIntent: 1,
        },
        conditions: {
          workload: {
            scenarioName: config.scenarioName,
            architectureLane: "bypass",
            workloadType: "buy_intent_created_flow",
            requestedBuyClicks: config.requests,
            httpConcurrency: config.httpConcurrency,
            skuId: config.skuId,
            quantityPerIntent: 1,
            profilingEnabled: config.profilingEnabled,
            ingressSource: config.ingressSource,
          },
          requestedBuyIntents: config.requests,
          effectiveBuyIntents: effectiveRequests,
          httpConcurrency: config.httpConcurrency,
          buyerPrefix: config.buyerPrefix,
          unitPriceAmountMinor: config.unitPriceAmountMinor,
          currency: config.currency,
          startingInventoryAvailable: inventory.available,
          mode: config.mode,
          ingressSource: config.ingressSource,
          benchmarkStyle: config.benchmarkStyle,
        },
        kafka: buildKafkaReport(config, kafkaBefore, kafkaAfter),
        seckillWorker: buildSeckillWorkerReport(seckillWorkerBefore, seckillWorkerAfter),
        backendTimings,
        steadyState,
        requestPath: {
          accepted: accepted.length,
          errors: Math.max(acceptResults.length - accepted.length, 0),
          kafkaDurableAccepted,
          kafkaDeliveryErrors,
          kafkaDurableAcceptedRate:
            accepted.length > 0 ? kafkaDurableAccepted / accepted.length : null,
          concurrency: concurrencyObservation,
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
          statusDistribution: countBy(createdResults, (result) => result.status),
          duplicates: createdResults.filter((result) => result.isDuplicate).length,
          createdLatencyMs: summarizeLatencies(createdResults.map((result) => result.latencyMs)),
          createdThroughputPerSecond:
            config.createdSource === "kafka_seckill_result"
              ? intentCreation.createdThroughputPerSecond
              : ratePerSecond(
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
              : "Intent creation benchmark failure happened after partial progress; created-only throughput remains the primary signal.",
        ],
        diagnostics: {
          assertions: [] as BenchmarkAssertion[],
        },
        measurements: [] as BenchmarkMeasurement[],
        series: [] as BenchmarkSeries[],
      };
      report.diagnostics = buildDiagnosticsForReport(report);
      report.measurements = buildMeasurementsFromReport(report);
      report.series = buildSeriesFromReport(report);
      const artifactPath = await writeBenchmarkArtifact(report);
      console.error(`Benchmark artifact written to ${artifactPath}`);
      throw error;
    }
  } finally {
    await directKafkaPublisher?.stop();
    await seckillCollector?.stop();
    await pool.end();
  }
}

function createKafkaClientId() {
  return `benchmark-seckill-result-${config.runId}`;
}

function buildSeckillSemanticAssertion(input: {
  config: BenchmarkConfig;
  accepted: Array<AcceptResult & { commandId: string; acceptedAtMs: number }>;
  createdResults: CreatedResult[];
  startingInventoryAvailable: number;
}): { failure: SeckillSemanticAssertion } | null {
  const { config, accepted, createdResults, startingInventoryAvailable } = input;

  if (config.createdSource !== "kafka_seckill_result") {
    return null;
  }

  if (!config.scenarioName.includes("seckill")) {
    return null;
  }

  if (!config.ensureSeckillEnabled) {
    return null;
  }

  if (accepted.length === 0 || createdResults.length === 0) {
    return null;
  }

  const createdCount = createdResults.filter((result) => result.status === "created").length;
  const failedCount = createdResults.filter((result) => result.status === "failed").length;

  // In the benchmark seckill scenarios we intentionally seed a very large inventory.
  // If the worker still turns every result into a failure, the benchmark should fail
  // fast instead of reporting a healthy throughput number.
  if (startingInventoryAvailable >= accepted.length && createdCount === 0 && failedCount > 0) {
    return {
      failure: {
        message:
          `Seckill semantic assertion failed: starting inventory (${startingInventoryAvailable}) ` +
          `covered all accepted requests (${accepted.length}), but the result boundary produced ` +
          `0 created / ${failedCount} failed outcomes.`,
        stage: "semantic_assertion",
      },
    };
  }

  return null;
}

function buildDiagnosticsForReport(report: {
  pass: boolean;
  failure?: {
    message?: string;
    stage?: string;
  };
}) {
  const assertions: BenchmarkAssertion[] = [
    {
      key: "run.completed_successfully",
      label: "run completed successfully",
      pass: report.pass,
      severity: "error",
      message: report.failure?.message ?? (report.pass ? "Run completed without benchmark assertion failure." : "Artifact reported pass=false."),
    },
  ];

  if (report.failure?.stage || report.failure?.message) {
    assertions.push({
      key: `failure.${report.failure?.stage ?? "unknown"}`,
      label: (report.failure?.stage ?? "run failure").replace(/[_-]+/g, " "),
      pass: false,
      severity: "error",
      message: report.failure?.message,
    });
  }

  return {
    assertions,
  } satisfies BenchmarkDiagnostics;
}

async function readSeckillWorkerCounterSnapshot(
  config: BenchmarkConfig,
): Promise<PrometheusCounterSnapshot | null> {
  if (!config.scenarioName.includes("seckill") || !config.prometheusUrl) {
    return null;
  }

  try {
    const [
      primaryRequestsTotal,
      retryScheduledTotal,
      retriedRequestsTotal,
      resultTotal,
      retryEdgeDistribution,
      retryAttemptDistribution,
      retrySourceBucketDistribution,
      retryTargetBucketDistribution,
    ] = await Promise.all([
      readPrometheusScalar(config.prometheusUrl, "sum(minishop_seckill_bucket_primary_requests_total)"),
      readPrometheusScalar(config.prometheusUrl, "sum(minishop_seckill_bucket_retry_scheduled_total)"),
      readPrometheusScalar(config.prometheusUrl, "sum(minishop_seckill_bucket_retried_requests_total)"),
      readPrometheusScalar(config.prometheusUrl, "sum(minishop_seckill_bucket_result_total)"),
      readPrometheusDistribution(
        config.prometheusUrl,
        "sum by (from_bucket, to_bucket) (minishop_seckill_retry_edge_scheduled_total)",
        (metric) => `${metric.from_bucket ?? "?"}->${metric.to_bucket ?? "?"}`,
      ),
      readPrometheusDistribution(
        config.prometheusUrl,
        "sum by (attempt) (minishop_seckill_retry_edge_scheduled_total)",
        (metric) => `attempt_${metric.attempt ?? "?"}`,
      ),
      readPrometheusDistribution(
        config.prometheusUrl,
        "sum by (from_bucket) (minishop_seckill_retry_edge_scheduled_total)",
        (metric) => metric.from_bucket ?? "?",
      ),
      readPrometheusDistribution(
        config.prometheusUrl,
        "sum by (to_bucket) (minishop_seckill_retry_edge_scheduled_total)",
        (metric) => metric.to_bucket ?? "?",
      ),
    ]);

    return {
      sampledAt: new Date().toISOString(),
      primaryRequestsTotal,
      retryScheduledTotal,
      retriedRequestsTotal,
      resultTotal,
      retryEdgeDistribution,
      retryAttemptDistribution,
      retrySourceBucketDistribution,
      retryTargetBucketDistribution,
    };
  } catch (error) {
    console.warn(
      `[benchmark] failed to read seckill worker counters from Prometheus: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return null;
  }
}

async function readPrometheusScalar(prometheusUrl: string, query: string) {
  const samples = await readPrometheusVector(prometheusUrl, query);
  const first = samples[0]?.value?.[1];
  const parsed = first ? Number.parseFloat(first) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readPrometheusDistribution(
  prometheusUrl: string,
  query: string,
  keyForMetric: (metric: Record<string, string>) => string,
) {
  const samples = await readPrometheusVector(prometheusUrl, query);
  const distribution: Record<string, number> = {};

  for (const sample of samples) {
    const key = keyForMetric(sample.metric ?? {});
    const rawValue = sample.value?.[1];
    const parsed = rawValue ? Number.parseFloat(rawValue) : 0;
    if (!key || !Number.isFinite(parsed)) {
      continue;
    }
    distribution[key] = parsed;
  }

  return distribution;
}

async function readPrometheusVector(prometheusUrl: string, query: string) {
  const baseUrl = prometheusUrl.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/api/v1/query`);
  url.searchParams.set("query", query);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Prometheus query failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    status?: string;
    data?: { resultType?: string; result?: PrometheusVectorSample[] };
    error?: string;
  };

  if (body.status !== "success" || body.data?.resultType !== "vector") {
    throw new Error(body.error ?? "unexpected Prometheus response");
  }

  return body.data.result ?? [];
}

function buildSeckillWorkerReport(
  before: PrometheusCounterSnapshot | null,
  after: PrometheusCounterSnapshot | null,
): SeckillWorkerReport | null {
  if (!before || !after) {
    return null;
  }

  const primaryRequests = counterDelta(before.primaryRequestsTotal, after.primaryRequestsTotal);
  const retryScheduled = counterDelta(before.retryScheduledTotal, after.retryScheduledTotal);
  const retriedRequests = counterDelta(before.retriedRequestsTotal, after.retriedRequestsTotal);
  const results = counterDelta(before.resultTotal, after.resultTotal);

  return {
    available: true,
    sampledAt: after.sampledAt,
    primaryRequests,
    retryScheduled,
    retriedRequests,
    results,
    retryScheduledPerPrimary: ratio(retryScheduled, primaryRequests),
    retriedPerPrimary: ratio(retriedRequests, primaryRequests),
    resultPerPrimary: ratio(results, primaryRequests),
    retryEdgeDistribution: counterDistributionDelta(
      before.retryEdgeDistribution,
      after.retryEdgeDistribution,
    ),
    retryAttemptDistribution: counterDistributionDelta(
      before.retryAttemptDistribution,
      after.retryAttemptDistribution,
    ),
    retrySourceBucketDistribution: counterDistributionDelta(
      before.retrySourceBucketDistribution,
      after.retrySourceBucketDistribution,
    ),
    retryTargetBucketDistribution: counterDistributionDelta(
      before.retryTargetBucketDistribution,
      after.retryTargetBucketDistribution,
    ),
  };
}

function counterDistributionDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const delta: Record<string, number> = {};

  for (const key of keys) {
    const value = counterDelta(before[key] ?? 0, after[key] ?? 0);
    if (value > 0) {
      delta[key] = value;
    }
  }

  return delta;
}

function counterDelta(before: number, after: number) {
  return Math.max(0, after - before);
}

function ratio(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

async function startSeckillOutcomeCollector(config: BenchmarkConfig) {
  const { Kafka, logLevel } = await loadConfluentKafkaJsCompat();
  const kafka = new Kafka({
    kafkaJS: {
      clientId: createKafkaClientId(),
      brokers: config.kafkaBrokers,
      logLevel: logLevel.NOTHING,
    },
  });
  const admin = kafka.admin();
  const consumer = kafka.consumer({
    kafkaJS: {
      groupId: `${createKafkaClientId()}-group`,
    },
  });
  const outcomes = new Map<string, CreatedResult>();

  await admin.connect();
  await ensureKafkaTopics(admin, config);
  const startingOffsets = await admin.fetchTopicOffsets(config.seckillResultTopic);
  await admin.disconnect();

  await consumer.connect();
  await consumer.subscribe({
    topic: config.seckillResultTopic,
  });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) {
        return;
      }

      const outcome = JSON.parse(message.value.toString("utf8")) as SeckillCommandOutcome;
      const commandId = outcome.result.commandId || outcome.request.commandId;
      const completedAtMs =
        Number(message.timestamp) || Date.parse(outcome.processedAt || "") || Date.now();

      outcomes.set(commandId, {
        commandId,
        status: outcome.result.status === "reserved" ? "created" : "failed",
        checkoutIntentId: outcome.result.checkoutIntentId,
        eventId: outcome.result.eventId,
        isDuplicate: outcome.result.duplicate,
        latencyMs: completedAtMs,
        completedAtMs,
      });
    },
  });

  await sleep(500);

  for (const partitionOffset of startingOffsets) {
    consumer.seek({
      topic: config.seckillResultTopic,
      partition: partitionOffset.partition,
      offset: partitionOffset.offset,
    });
  }

  // Give the seeks time to take effect before we start issuing requests.
  await sleep(250);

  return {
    async waitForOutcomes(
      accepted: Array<AcceptResult & { commandId: string; acceptedAtMs: number }>,
      timeoutMs: number,
    ) {
      const acceptedAtByCommandId = new Map(
        accepted.map((result) => [result.commandId, result.acceptedAtMs] as const),
      );
      const pendingCommandIds = new Set(accepted.map((result) => result.commandId));
      const deadline = Date.now() + timeoutMs;
      const resultsByCommandId = new Map<string, CreatedResult>();

      while (Date.now() < deadline && pendingCommandIds.size > 0) {
        for (const commandId of [...pendingCommandIds]) {
          const outcome = outcomes.get(commandId);
          const acceptedAtMs = acceptedAtByCommandId.get(commandId);

          if (!outcome || typeof acceptedAtMs !== "number") {
            continue;
          }

          resultsByCommandId.set(commandId, {
            ...outcome,
            latencyMs: Math.max(0, outcome.latencyMs - acceptedAtMs),
            completedAtMs: outcome.completedAtMs,
          });
          pendingCommandIds.delete(commandId);
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
    },
    getOutcome(commandId: string) {
      return outcomes.get(commandId);
    },
    async stop() {
      await consumer.disconnect().catch(() => undefined);
    },
  };
}

async function createBuyIntent(index: number): Promise<AcceptResult> {
  const requestStartedAtMs = performance.timeOrigin + performance.now();
  const startedAt = performance.now();
  const appUrl = appUrlForIndex(index);

  try {
    const response = await fetch(`${appUrl}/api/buy-intents`, {
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

async function publishSeckillRequestsDirectly(
  publisher: Awaited<ReturnType<typeof startDirectSeckillRequestPublisher>> | null,
  total: number,
  config: BenchmarkConfig,
): Promise<AcceptResult[]> {
  if (!publisher) {
    throw new Error("Direct Kafka publisher is not initialized.");
  }

  const results: AcceptResult[] = [];

  for (const indices of chunked(
    Array.from({ length: total }, (_, index) => index),
    config.directKafkaBatchSize,
  )) {
    const requestStartedAtMs = performance.timeOrigin + performance.now();
    const startedAt = performance.now();
    const batchRequests = indices.map((index) => buildDirectSeckillRequest(index, config));

    try {
      await publisher.publish(batchRequests);
      const acceptedAtMs = performance.timeOrigin + performance.now();

      for (const request of batchRequests) {
        results.push({
          ok: true,
          status: 202,
          latencyMs: performance.now() - startedAt,
          requestStartedAtMs,
          commandId: request.command.command_id,
          acceptedAtMs,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "direct_kafka_publish_failed";

      for (const request of batchRequests) {
        results.push({
          ok: false,
          status: 0,
          latencyMs: performance.now() - startedAt,
          requestStartedAtMs,
          commandId: request.command.command_id,
          error: message,
        });
      }
    }
  }

  return results;
}

async function publishSeckillRequestsDirectlyUntil(
  publisher: Awaited<ReturnType<typeof startDirectSeckillRequestPublisher>> | null,
  config: BenchmarkConfig,
  durationMs: number,
  collectResults: boolean,
  startIndex = 0,
) {
  if (!publisher) {
    throw new Error("Direct Kafka publisher is not initialized.");
  }

  const results: AcceptResult[] = [];
  const deadline = performance.now() + durationMs;
  let nextIndex = startIndex;

  while (performance.now() < deadline) {
    const batchRequests = Array.from({ length: config.directKafkaBatchSize }, () =>
      buildDirectSeckillRequest(nextIndex++, config),
    );
    const requestStartedAtMs = performance.timeOrigin + performance.now();
    const startedAt = performance.now();

    try {
      await publisher.publish(batchRequests);
      const acceptedAtMs = performance.timeOrigin + performance.now();

      if (collectResults) {
        for (const request of batchRequests) {
          results.push({
            ok: true,
            status: 202,
            latencyMs: performance.now() - startedAt,
            requestStartedAtMs,
            commandId: request.command.command_id,
            acceptedAtMs,
          });
        }
      }
    } catch (error) {
      if (collectResults) {
        const message = error instanceof Error ? error.message : "direct_kafka_publish_failed";

        for (const request of batchRequests) {
          results.push({
            ok: false,
            status: 0,
            latencyMs: performance.now() - startedAt,
            requestStartedAtMs,
            commandId: request.command.command_id,
            error: message,
          });
        }
      }
    }
  }

  return {
    results,
    nextIndex,
  };
}

function buildDirectSeckillRequest(index: number, config: BenchmarkConfig): SeckillBuyIntentRequest {
  const commandId = crypto.randomUUID();
  const stableKey = `${config.runId}-${index}`;
  const primaryBucketId = selectPrimaryBucket(stableKey, config.seckillBucketCount);

  return {
    sku_id: config.skuId,
    quantity: 1,
    seckill_stock_limit: config.requests,
    bucket_count: config.seckillBucketCount,
    primary_bucket_id: primaryBucketId,
    bucket_id: primaryBucketId,
    attempt: 0,
    max_probe: config.seckillMaxProbe,
    processing_key: buildProcessingKey(config.skuId, primaryBucketId),
    command: {
      command_id: commandId,
      correlation_id: crypto.randomUUID(),
      buyer_id: `${config.buyerPrefix}_${index}`,
      items: [
        {
          sku_id: config.skuId,
          quantity: 1,
          unit_price_amount_minor: config.unitPriceAmountMinor,
          currency: config.currency,
        },
      ],
      idempotency_key: stableKey,
      metadata: {
        request_id: crypto.randomUUID(),
        trace_id: crypto.randomUUID(),
        source: "benchmark",
        actor_id: `${config.buyerPrefix}_${index}`,
      },
      issued_at: new Date().toISOString(),
    },
  };
}

async function startDirectSeckillRequestPublisher(config: BenchmarkConfig) {
  const { Kafka, logLevel } = await loadConfluentKafkaJsCompat();
  const kafka = new Kafka({
    kafkaJS: {
      clientId: `${createKafkaClientId()}-direct-publisher`,
      brokers: config.kafkaBrokers,
      logLevel: logLevel.NOTHING,
    },
  });
  const admin = kafka.admin();
  const producer = kafka.producer({
    "linger.ms": config.producerLingerMs,
    "batch.num.messages": config.producerBatchNumMessages,
  });

  await admin.connect();
  await ensureKafkaTopics(admin, config);
  await admin.disconnect();
  await producer.connect();

  return {
    async publish(requests: SeckillBuyIntentRequest[]) {
      await producer.sendBatch({
        topicMessages: [
          {
            topic: config.seckillRequestTopic,
            messages: requests.map((request) => ({
              partition: normalizeSeckillPartition(request.bucket_id),
              key: request.processing_key,
              value: JSON.stringify(request),
            })),
          },
        ],
      });
    },
    async stop() {
      await producer.disconnect().catch(() => undefined);
    },
  };
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
  const deadline = Date.now() + config.createdTimeoutMs;

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

async function waitForCreatedSeckillOutcomes(
  collector: Awaited<ReturnType<typeof startSeckillOutcomeCollector>> | null,
  accepted: Array<AcceptResult & { commandId: string; acceptedAtMs: number }>,
) {
  if (!collector) {
    throw new Error("Seckill outcome collector is not initialized.");
  }

  return collector.waitForOutcomes(accepted, config.createdTimeoutMs);
}

async function runSteadyStateSeckillBenchmark(
  directKafkaPublisher: Awaited<ReturnType<typeof startDirectSeckillRequestPublisher>> | null,
  seckillCollector: Awaited<ReturnType<typeof startSeckillOutcomeCollector>> | null,
) {
  if (config.createdSource !== "kafka_seckill_result") {
    throw new Error("steady_state benchmark style currently requires kafka_seckill_result.");
  }

  if (config.ingressSource === "direct_kafka") {
    let nextIndex = 0;
    await publishSeckillRequestsDirectlyUntil(
      directKafkaPublisher,
      config,
      config.steadyStateWarmupMs,
      false,
      nextIndex,
    ).then((result) => {
      nextIndex = result.nextIndex;
    });

    const windowStartedAtMs = performance.timeOrigin + performance.now();
    const measured = await publishSeckillRequestsDirectlyUntil(
      directKafkaPublisher,
      config,
      config.steadyStateMeasureMs,
      true,
      nextIndex,
    );
    const windowEndedAtMs = performance.timeOrigin + performance.now();
    nextIndex = measured.nextIndex;

    await sleep(config.steadyStateCooldownMs);

    const accepted = measured.results.filter(
      (result): result is AcceptResult & { commandId: string; acceptedAtMs: number } =>
        result.ok &&
        typeof result.commandId === "string" &&
        typeof result.acceptedAtMs === "number",
    );
    const createdBatch = await waitForCreatedSeckillOutcomes(seckillCollector, accepted);
    const createdWithinWindow = createdBatch.results.filter(
      (result) =>
        typeof result.completedAtMs === "number" &&
        result.completedAtMs >= windowStartedAtMs &&
        result.completedAtMs <= windowEndedAtMs,
    ).length;

    return {
      acceptResults: measured.results,
      accepted,
      createdResults: createdBatch.results,
      pendingCreatedCommandIds: createdBatch.pendingCommandIds,
      steadyState: {
        windowStartedAtMs,
        windowEndedAtMs,
        warmupDurationMs: config.steadyStateWarmupMs,
        measureDurationMs: config.steadyStateMeasureMs,
        cooldownDurationMs: config.steadyStateCooldownMs,
        acceptedDuringWindow: accepted.length,
        createdWithinWindow,
        createdByDrainEnd: createdBatch.results.length,
        acceptRequestsPerSecond: ratePerSecond(accepted.length, config.steadyStateMeasureMs),
        createdThroughputPerSecond: ratePerSecond(createdWithinWindow, config.steadyStateMeasureMs),
      } satisfies SteadyStateStats,
    };
  }

  let nextIndex = 0;
  const warmup = await runWithConcurrencyUntil(
    config.httpConcurrency,
    config.steadyStateWarmupMs,
    async (index) => createBuyIntent(nextIndex + index),
  );
  nextIndex += warmup.totalIssued;

  const windowStartedAtMs = performance.timeOrigin + performance.now();
  const measured = await runWithConcurrencyUntil(
    config.httpConcurrency,
    config.steadyStateMeasureMs,
    async (index) => createBuyIntent(nextIndex + index),
  );
  const windowEndedAtMs = performance.timeOrigin + performance.now();
  nextIndex += measured.totalIssued;

  await sleep(config.steadyStateCooldownMs);

  const accepted = measured.results.filter(
    (result): result is AcceptResult & { commandId: string; acceptedAtMs: number } =>
      result.ok &&
      typeof result.commandId === "string" &&
      typeof result.acceptedAtMs === "number",
  );
  const createdBatch = await waitForCreatedSeckillOutcomes(seckillCollector, accepted);
  const createdWithinWindow = createdBatch.results.filter(
    (result) =>
      typeof result.completedAtMs === "number" &&
      result.completedAtMs >= windowStartedAtMs &&
      result.completedAtMs <= windowEndedAtMs,
  ).length;

  return {
    acceptResults: measured.results,
    accepted,
    createdResults: createdBatch.results,
    pendingCreatedCommandIds: createdBatch.pendingCommandIds,
    steadyState: {
      windowStartedAtMs,
      windowEndedAtMs,
      warmupDurationMs: config.steadyStateWarmupMs,
      measureDurationMs: config.steadyStateMeasureMs,
      cooldownDurationMs: config.steadyStateCooldownMs,
      acceptedDuringWindow: accepted.length,
      createdWithinWindow,
      createdByDrainEnd: createdBatch.results.length,
      acceptRequestsPerSecond: ratePerSecond(accepted.length, config.steadyStateMeasureMs),
      createdThroughputPerSecond: ratePerSecond(createdWithinWindow, config.steadyStateMeasureMs),
    } satisfies SteadyStateStats,
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

async function readInventory(pool: Pool, skuId: string) {
  const result = await pool.query<{
    sku_id: string;
    available: number;
    on_hand: number;
    reserved: number;
    sold: number;
  }>(
    `
      select sku_id, available, on_hand, reserved, sold
      from sku_inventory_projection
      where sku_id = $1
      limit 1
    `,
    [skuId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Inventory read failed for ${skuId}: projection row not found.`);
  }

  return {
    skuId: row.sku_id,
    available: row.available,
    onHand: row.on_hand,
    reserved: row.reserved,
    sold: row.sold,
  };
}

async function readNatsSnapshot() {
  try {
    const monitorUrl = process.env.BENCHMARK_NATS_MONITOR_URL?.trim() || "http://localhost:8222";
    const jszResponse = await fetch(`${monitorUrl.replace(/\/+$/, "")}/jsz?streams=true&consumers=true`);

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
  const latencies: number[] = [];
  let minRequestStartedAtMs = Number.POSITIVE_INFINITY;
  let maxOccurredAtMs = 0;

  for (const entry of intents) {
    if (typeof entry.requestStartedAtMs === "number") {
      minRequestStartedAtMs = Math.min(minRequestStartedAtMs, entry.requestStartedAtMs);
    }

    const occurredAtMs = occurredAtByCheckoutIntentId.get(entry.checkoutIntentId);
    if (!occurredAtMs || entry.requestStartedAtMs === null) {
      continue;
    }

    maxOccurredAtMs = Math.max(maxOccurredAtMs, occurredAtMs);
    latencies.push(Math.max(0, occurredAtMs - entry.requestStartedAtMs));
  }

  return {
    created: result.rows.length,
    createdThroughputPerSecond:
      Number.isFinite(minRequestStartedAtMs) && maxOccurredAtMs >= minRequestStartedAtMs
        ? ratePerSecond(result.rows.length, Math.max(maxOccurredAtMs - minRequestStartedAtMs, 1))
        : 0,
    requestToCreatedLatencyMs: summarizeLatencies(latencies),
  };
}

function readIntentCreationMetricsFromCreatedResults(
  createdResults: CreatedResult[],
  accepted: Array<{ commandId: string; requestStartedAtMs: number | null; acceptedAtMs: number }>,
) {
  if (createdResults.length === 0) {
    return {
      created: 0,
      createdThroughputPerSecond: 0,
      requestToCreatedLatencyMs: summarizeLatencies([]),
    };
  }

  const acceptedByCommandId = new Map(
    accepted.map((entry) => [entry.commandId, entry] as const),
  );
  const latencies: number[] = [];
  let minRequestStartedAtMs = Number.POSITIVE_INFINITY;
  let maxCompletedAtMs = 0;

  for (const entry of accepted) {
    if (typeof entry.requestStartedAtMs === "number") {
      minRequestStartedAtMs = Math.min(minRequestStartedAtMs, entry.requestStartedAtMs);
    }
  }

  for (const result of createdResults) {
    const acceptedEntry = acceptedByCommandId.get(result.commandId);
    const completedAtMs = result.completedAtMs ?? 0;
    maxCompletedAtMs = Math.max(maxCompletedAtMs, completedAtMs);

    if (
      !acceptedEntry ||
      acceptedEntry.requestStartedAtMs === null ||
      typeof result.completedAtMs !== "number"
    ) {
      continue;
    }

    latencies.push(Math.max(0, result.completedAtMs - acceptedEntry.requestStartedAtMs));
  }

  return {
    created: createdResults.length,
    createdThroughputPerSecond:
      Number.isFinite(minRequestStartedAtMs) && maxCompletedAtMs >= minRequestStartedAtMs
        ? ratePerSecond(createdResults.length, Math.max(maxCompletedAtMs - minRequestStartedAtMs, 1))
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

async function assertAppReachable(appUrl: string, healthPath: string) {
  const response = await fetch(`${appUrl}${healthPath}`);

  if (!response.ok) {
    throw new Error(`Benchmark app preflight failed: ${appUrl}${healthPath} returned ${response.status}.`);
  }
}

async function assertAppsReachable(appUrls: string[], healthPath: string) {
  for (const appUrl of appUrls) {
    await assertAppReachable(appUrl, healthPath);
  }
}

function appUrlForIndex(index: number) {
  return config.ingressAppUrls[index % config.ingressAppUrls.length] ?? config.ingressAppUrl;
}

function summarizeLatencies(values: number[]) {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? 0 : values.reduce((max, value) => Math.max(max, value), 0),
  };
}

function ratePerSecond(total: number, durationMs: number) {
  return Number((total / Math.max(durationMs / 1000, 0.001)).toFixed(2));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
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

function buildMeasurementsFromReport(report: {
  runId: string;
  scenarioName?: string;
  scenarioTags?: Record<string, string | number | boolean>;
  scenario?: { requestedBuyClicks?: number };
  kafka?: { createdBoundary?: string };
  conditions?: {
    workload?: { benchmarkStyle?: "burst" | "steady_state"; [key: string]: unknown };
    benchmarkStyle?: "burst" | "steady_state";
  };
  requestPath?: {
    accepted?: number;
    errors?: number;
    kafkaDurableAccepted?: number;
    kafkaDeliveryErrors?: number;
    kafkaDurableAcceptedRate?: number | null;
    acceptRequestsPerSecond?: number;
    acceptLatencyMs?: { p95?: number };
  };
  intentCreation?: {
    createdThroughputPerSecond?: number;
  };
  seckillWorker?: {
    retryScheduledPerPrimary?: number;
    resultPerPrimary?: number;
  } | null;
  projections?: {
    checkpointLagEvents?: number;
    projectionLagEvents?: number;
  };
}): BenchmarkMeasurement[] {
  const scenarioName = report.scenarioName ?? "unknown";
  const benchmarkStyle =
    report.conditions?.workload?.benchmarkStyle ?? report.conditions?.benchmarkStyle ?? "burst";
  const createdBoundary = report.kafka?.createdBoundary;
  const accepted = report.requestPath?.accepted ?? 0;
  const kafkaDurableAccepted = report.requestPath?.kafkaDurableAccepted;
  const kafkaDeliveryErrors = report.requestPath?.kafkaDeliveryErrors;
  const kafkaDurableAcceptedRate = report.requestPath?.kafkaDurableAcceptedRate;
  const requested = report.scenario?.requestedBuyClicks ?? 0;
  const errors = report.requestPath?.errors ?? 0;
  const ingressThroughput = report.requestPath?.acceptRequestsPerSecond ?? 0;
  const ingressP95 = report.requestPath?.acceptLatencyMs?.p95 ?? 0;
  const resultThroughput = report.intentCreation?.createdThroughputPerSecond ?? 0;
  const retryPerPrimary = report.seckillWorker?.retryScheduledPerPrimary;
  const resultPerPrimary = report.seckillWorker?.resultPerPrimary;
  const projectionLag =
    report.projections?.checkpointLagEvents ?? report.projections?.projectionLagEvents;
  const measurements: BenchmarkMeasurement[] = [];

  if (requested > 0 && benchmarkStyle !== "steady_state") {
    measurements.push({
      key: "accepted_rate",
      label: "accepted rate",
      unit: "%",
      value: (accepted / requested) * 100,
      definition: "How much of the requested burst the ingress path admitted.",
      calculation: "accepted / requestedBuyClicks",
      interpretation:
        "Useful for burst-style runs. If this drops, the ingress path is rejecting or losing work before durable queueing.",
    });
  }

  measurements.push({
    key: "ingress_throughput",
    label:
      scenarioName.startsWith("buy-intent-") && createdBoundary === "kafka_seckill_result"
        ? "queued/sec"
        : scenarioName.startsWith("buy-intent-")
          ? "accept/sec"
          : "request/sec",
    unit: "/s",
    value: ingressThroughput,
    definition:
      benchmarkStyle === "steady_state"
        ? "Ingress throughput during the steady-state measurement window."
        : "Ingress throughput during the benchmark request burst.",
    calculation:
      benchmarkStyle === "steady_state"
        ? "acceptedDuringWindow / measureDurationSeconds"
        : "accepted / acceptDurationSeconds",
    interpretation:
      createdBoundary === "kafka_seckill_result"
        ? "Compare this with result topic throughput to see how much durable queued work reaches final output."
        : "Compare this with downstream throughput to see how much admitted work becomes durable business facts.",
  });

  if (typeof kafkaDurableAccepted === "number") {
    measurements.push({
      key: "kafka_durable_accepted",
      label: "Kafka durable accepted",
      unit: "",
      value: kafkaDurableAccepted,
      definition: "Records acknowledged by Kafka/Redpanda from the Go backend async producer callback.",
      calculation: "sum(backendTimings.counts['seckill_publish.delivery_success'])",
      interpretation:
        "Compare with HTTP accepted. A lower value means the HTTP layer returned accepted faster than Kafka acknowledged the queued work, or the timing snapshot missed some backend replicas.",
    });
  }

  if (typeof kafkaDurableAcceptedRate === "number") {
    measurements.push({
      key: "kafka_durable_accepted_rate",
      label: "Kafka durable accepted rate",
      unit: "",
      value: kafkaDurableAcceptedRate,
      definition: "Share of HTTP accepted requests that were acknowledged by Kafka/Redpanda.",
      calculation: "kafkaDurableAccepted / requestPath.accepted",
      interpretation:
        "Healthy single-API runs should stay near 1.0. For multi-replica runs this requires benchmark timing snapshots from every backend replica.",
    });
  }

  if (typeof kafkaDeliveryErrors === "number") {
    measurements.push({
      key: "kafka_delivery_errors",
      label: "Kafka delivery errors",
      unit: "",
      value: kafkaDeliveryErrors,
      definition: "Kafka/Redpanda delivery errors reported by the Go backend async producer callback.",
      calculation: "sum(backendTimings.counts['seckill_publish.delivery_error'])",
      interpretation:
        "Non-zero values mean HTTP accepted work later failed at the durable queue boundary.",
    });
  }

  if (typeof retryPerPrimary === "number") {
    measurements.push({
      key: "retry_per_primary",
      label: "retry per primary",
      unit: "",
      value: retryPerPrimary,
      definition: "Average number of retries the seckill worker scheduled for each primary request.",
      calculation: "retryScheduled / primaryRequests",
      interpretation:
        "Values near zero mean requests usually complete on the first probe. Values near maxProbe-1 mean nearly every request is rerouted through the full probe path.",
    });
  }

  if (typeof resultPerPrimary === "number") {
    measurements.push({
      key: "result_per_primary",
      label: "result per primary",
      unit: "",
      value: resultPerPrimary,
      definition: "Average number of final seckill results produced for each primary request.",
      calculation: "results / primaryRequests",
      interpretation:
        "Healthy runs should stay near 1.0. Lower values indicate work is accepted faster than the worker emits final outcomes.",
    });
  }

  measurements.push({
    key: "ingress_p95_latency",
    label: "p95 latency",
    unit: "ms",
    value: ingressP95,
    definition: "95th percentile latency at the ingress boundary.",
    calculation: "95th percentile of ingress latency samples",
    interpretation:
      "This is the slow tail at ingress. Spikes usually indicate queueing or saturation before processing.",
  });

  measurements.push({
    key: "result_throughput",
    label:
      createdBoundary === "kafka_seckill_result" ? "result topic throughput" : "intent created/sec",
    unit: "/s",
    value: resultThroughput,
    definition:
      createdBoundary === "kafka_seckill_result"
        ? "Final output throughput at the result topic boundary."
        : "Throughput of durable intent creation facts.",
    calculation:
      createdBoundary === "kafka_seckill_result"
        ? "finalOutputCount / throughputWindowSeconds"
        : "createdFacts / factWindowSeconds",
    interpretation:
      createdBoundary === "kafka_seckill_result"
        ? "Compare this with queued/sec. A large gap means queued work is not becoming final output fast enough."
        : "Compare this with ingress throughput to see where durable creation lags admission.",
  });

  measurements.push({
    key: "errors",
    label: "errors",
    unit: "",
    value: errors,
    definition: "Request failures observed by the benchmark client.",
    calculation: "requested work - accepted work",
    interpretation:
      "Use this with ingress throughput and status distributions to separate transport failures from application rejection.",
  });

  if (typeof projectionLag === "number") {
    measurements.push({
      key: "projection_lag",
      label: "projection lag",
      unit: "events",
      value: projectionLag,
      definition: "Distance between durable writes and projection checkpoint at verification time.",
      calculation: "eventStoreLastEventId - checkpointLastEventId",
      interpretation: "Zero means read models caught up by the end of verification.",
    });
  }

  return measurements;
}

function buildSeriesFromReport(report: {
  runId: string;
  scenarioTags?: Record<string, string | number | boolean>;
  measurements?: BenchmarkMeasurement[];
}): BenchmarkSeries[] {
  const measurements = report.measurements ?? [];
  const concurrency = report.scenarioTags?.concurrency;

  if (typeof concurrency !== "number" || !Number.isFinite(concurrency) || concurrency <= 0) {
    return [];
  }

  return measurements.map((measurement) => ({
    key: `measurement.${measurement.key}.by_concurrency`,
    label: measurement.label,
    xKey: "concurrency",
    xLabel: "concurrency",
    xUnit: "",
    yUnit: measurement.unit,
    points: [
      {
        x: concurrency,
        y: measurement.value,
        runId: report.runId,
      },
    ],
    definition: measurement.definition,
    calculation: measurement.calculation,
    interpretation: measurement.interpretation,
  }));
}

function chunked<T>(values: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function createConcurrencyObserver(total: number, configured: number) {
  let inFlight = 0;
  let maxInFlight = 0;
  let totalStarted = 0;
  let totalCompleted = 0;
  const workers = Math.max(1, Math.min(configured, total));

  return {
    start() {
      inFlight += 1;
      totalStarted += 1;
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }
    },
    finish() {
      inFlight -= 1;
      totalCompleted += 1;
    },
    snapshot(): ConcurrencyObservation {
      return {
        configured,
        workers,
        maxInFlight,
        totalStarted,
        totalCompleted,
      };
    },
  };
}

async function runWithConcurrency<T>(
  total: number,
  concurrency: number,
  taskFor: (index: number) => Promise<T>,
  observer?: ReturnType<typeof createConcurrencyObserver>,
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

      observer?.start();
      try {
        results[currentIndex] = await taskFor(currentIndex);
      } finally {
        observer?.finish();
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, () => worker()),
  );

  return results;
}

async function runWithConcurrencyUntil<T>(
  concurrency: number,
  durationMs: number,
  taskFor: (index: number) => Promise<T>,
) {
  const results: T[] = [];
  const deadline = performance.now() + durationMs;
  let nextIndex = 0;

  async function worker() {
    while (performance.now() < deadline) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results.push(await taskFor(currentIndex));
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return {
    results,
    totalIssued: nextIndex,
  };
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
      target: "go-backend-process",
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
    target: "go-backend-process",
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
      target: "go-backend-process",
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

async function maybeResetBackendTimings() {
  if (config.ingressSource !== "http") {
    return;
  }
  await Promise.all(
    uniqueStrings(config.ingressAppUrls).map((url) =>
      fetch(`${trimTrailingSlash(url)}/api/internal/benchmarks/timings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": `req_${config.runId}_timings_reset`,
          "x-trace-id": `trace_${config.runId}`,
        },
        body: JSON.stringify({ action: "reset", runId: config.runId }),
      }).catch(() => undefined),
    ),
  );
}

async function maybeReadBackendTimings(): Promise<BackendTimingSnapshot> {
  if (config.ingressSource !== "http") {
    return { available: false };
  }

  const targets = await Promise.all(
    uniqueStrings(config.ingressAppUrls).map(async (url) => {
      try {
        const response = await fetch(`${trimTrailingSlash(url)}/api/internal/benchmarks/timings`, {
          headers: {
            "x-request-id": `req_${config.runId}_timings_snapshot`,
            "x-trace-id": `trace_${config.runId}`,
          },
        });
        if (!response.ok) {
          return { url, error: `HTTP ${response.status}` };
        }
        return { url, snapshot: await response.json() };
      } catch (error) {
        return {
          url,
          error: error instanceof Error ? error.message : "unknown backend timing error",
        };
      }
    }),
  );

  return {
    available: targets.some((target) => target.snapshot),
    targets,
  };
}

function readBackendTimingCount(snapshot: BackendTimingSnapshot, name: string): number {
  if (!snapshot.available || !snapshot.targets?.length) {
    return 0;
  }

  return snapshot.targets.reduce((total, target) => {
    const targetSnapshot = asBackendTimingTargetSnapshot(target.snapshot);
    const value = targetSnapshot?.counts?.[name];
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function asBackendTimingTargetSnapshot(value: unknown): BackendTimingTargetSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as BackendTimingTargetSnapshot;
}

function readConfig(): BenchmarkConfig {
  const scenarioName = process.env.BENCHMARK_SCENARIO_NAME ?? defaultScenarioName();
  const appUrls = (
    process.env.BENCHMARK_APP_URLS ??
    process.env.BENCHMARK_APP_URL ??
    "http://localhost:3005"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const ingressAppUrls = (
    process.env.BENCHMARK_INGRESS_APP_URLS ??
    process.env.BENCHMARK_APP_URLS ??
    process.env.BENCHMARK_INGRESS_APP_URL ??
    process.env.BENCHMARK_APP_URL ??
    "http://localhost:3005"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const createdSource =
    (process.env.BENCHMARK_CREATED_SOURCE as BenchmarkConfig["createdSource"] | undefined) ??
    (scenarioName.includes("seckill") ? "kafka_seckill_result" : "postgres");

  return {
    appUrl: appUrls[0] ?? "http://localhost:3005",
    appUrls,
    ingressAppUrl: ingressAppUrls[0] ?? appUrls[0] ?? "http://localhost:3005",
    ingressAppUrls,
    prometheusUrl: process.env.BENCHMARK_PROMETHEUS_URL?.trim() || "http://localhost:9090",
    databaseUrl: requiredEnv("DATABASE_URL"),
    scenarioFamily: process.env.BENCHMARK_SCENARIO_FAMILY?.trim() || undefined,
    kafkaBrokers: (process.env.BENCHMARK_KAFKA_BROKERS ?? "localhost:19092")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    seckillRequestTopic:
      process.env.BENCHMARK_KAFKA_SECKILL_REQUEST_TOPIC ??
      process.env.KAFKA_SECKILL_REQUEST_TOPIC ??
      "inventory.seckill.requested",
    seckillResultTopic:
      process.env.BENCHMARK_KAFKA_SECKILL_RESULT_TOPIC ??
      process.env.KAFKA_SECKILL_RESULT_TOPIC ??
      "inventory.seckill.result",
    seckillDlqTopic:
      process.env.BENCHMARK_KAFKA_SECKILL_DLQ_TOPIC ??
      process.env.KAFKA_SECKILL_DLQ_TOPIC ??
      "inventory.seckill.dlq",
    requests: readPositiveIntegerEnv("BENCHMARK_REQUESTS", 20),
    httpConcurrency: readPositiveIntegerEnv("BENCHMARK_HTTP_CONCURRENCY", 10),
    profilingEnabled: process.env.BENCHMARK_PROFILE === "1",
    skuId: process.env.BENCHMARK_SKU_ID ?? "sku_hot_001",
    unitPriceAmountMinor: readPositiveIntegerEnv("BENCHMARK_UNIT_PRICE_MINOR", 1200),
    currency: process.env.BENCHMARK_CURRENCY ?? "TWD",
    buyerPrefix: process.env.BENCHMARK_BUYER_PREFIX ?? "benchmark_buyer",
    runId: process.env.BENCHMARK_RUN_ID ?? `bench_${Date.now()}`,
    resultsDir: process.env.BENCHMARK_RESULTS_DIR ?? "benchmark-results",
    scenarioName,
    mode: "bypass",
    ingressSource:
      (process.env.BENCHMARK_INGRESS_SOURCE as BenchmarkConfig["ingressSource"] | undefined) ??
      "http",
    benchmarkStyle:
      (process.env.BENCHMARK_STYLE as BenchmarkConfig["benchmarkStyle"] | undefined) ?? "burst",
    createdTimeoutMs: readPositiveIntegerEnv("BENCHMARK_CREATED_TIMEOUT_MS", 60_000),
    resetStateBeforeRun: readBooleanWithDefault("BENCHMARK_RESET_STATE", true),
    createdSource,
    ensureSeckillEnabled:
      process.env.BENCHMARK_ENSURE_SECKILL_ENABLED === "1" ||
      (process.env.BENCHMARK_ENSURE_SECKILL_ENABLED !== "0" && scenarioName.includes("seckill")),
    seckillBucketCount: readPositiveIntegerEnv(
      "BENCHMARK_SECKILL_BUCKET_COUNT",
      readPositiveIntegerEnv("SECKILL_BUCKET_COUNT", 4),
    ),
    seckillMaxProbe: readPositiveIntegerEnv("BENCHMARK_SECKILL_MAX_PROBE", 4),
    seckillWorkerReplicas: readOptionalPositiveIntegerEnv("BENCHMARK_SECKILL_WORKER_REPLICAS"),
    seckillRoutingEpoch: readOptionalPositiveIntegerEnv("BENCHMARK_SECKILL_ROUTING_EPOCH"),
    directKafkaBatchSize: readPositiveIntegerEnv("BENCHMARK_DIRECT_KAFKA_BATCH_SIZE", 500),
    kafkaClient: process.env.BENCHMARK_KAFKA_CLIENT ?? "confluent-kafka-javascript",
    appPublishBatchSize: readPositiveIntegerEnv("KAFKA_SECKILL_PUBLISH_BATCH_SIZE", 64),
    appPublishLingerMs: readPositiveIntegerEnv("KAFKA_SECKILL_PUBLISH_LINGER_MS", 2),
    producerLingerMs: readPositiveIntegerEnv("KAFKA_SECKILL_CLIENT_LINGER_MS", 1),
    producerBatchNumMessages: readPositiveIntegerEnv(
      "KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES",
      10000,
    ),
    steadyStateWarmupMs: readPositiveIntegerEnv("BENCHMARK_STEADY_STATE_WARMUP_MS", 5_000),
    steadyStateMeasureMs: readPositiveIntegerEnv("BENCHMARK_STEADY_STATE_MEASURE_MS", 15_000),
    steadyStateCooldownMs: readPositiveIntegerEnv("BENCHMARK_STEADY_STATE_COOLDOWN_MS", 5_000),
    ingressImpl: process.env.BENCHMARK_IMPL?.trim() || undefined,
    benchmarkPath: process.env.BENCHMARK_PATH_TAG?.trim() || undefined,
    ingressHealthPath: process.env.BENCHMARK_INGRESS_HEALTH_PATH?.trim() || "/products",
  };
}

function defaultScenarioName() {
  return "buy-intent-hot-seckill";
}

function readScenarioFamily(config: BenchmarkConfig) {
  if (config.scenarioFamily) {
    return config.scenarioFamily;
  }

  return config.scenarioName;
}

function buildScenarioTags(config: BenchmarkConfig) {
  const tags: Record<string, string | number | boolean> = {
    concurrency: config.httpConcurrency,
    ingress: config.ingressSource,
    style: config.benchmarkStyle,
  };

  if (config.scenarioName.includes("seckill")) {
    tags.bucket = config.seckillBucketCount;
    tags.maxProbe = config.seckillMaxProbe;
    if (config.seckillWorkerReplicas !== undefined) {
      tags.workerReplicas = config.seckillWorkerReplicas;
    }
    if (config.seckillRoutingEpoch !== undefined) {
      tags.routingEpoch = config.seckillRoutingEpoch;
    }
  }
  if (config.ingressImpl) {
    tags.impl = config.ingressImpl;
  }
  if (config.benchmarkPath) {
    tags.path = config.benchmarkPath;
  }

  if (config.benchmarkStyle === "steady_state") {
    tags.warmupMs = config.steadyStateWarmupMs;
    tags.measureMs = config.steadyStateMeasureMs;
    tags.cooldownMs = config.steadyStateCooldownMs;
  }

  return tags;
}

async function readKafkaBenchmarkSnapshot(config: BenchmarkConfig) {
  if (config.kafkaBrokers.length === 0) {
    return null;
  }

  const { Kafka, logLevel } = await loadConfluentKafkaJsCompat();
  const kafka = new Kafka({
    kafkaJS: {
      clientId: `${createKafkaClientId()}-admin`,
      brokers: config.kafkaBrokers,
      logLevel: logLevel.NOTHING,
    },
  });
  const admin = kafka.admin();

  await admin.connect();

  try {
    await ensureKafkaTopics(admin, config);
    const [requestTopic, resultTopic, dlqTopic] = await Promise.all([
      readKafkaTopicSnapshot(admin, config.seckillRequestTopic),
      readKafkaTopicSnapshot(admin, config.seckillResultTopic),
      readKafkaTopicSnapshot(admin, config.seckillDlqTopic),
    ]);

    return { requestTopic, resultTopic, dlqTopic };
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

async function readKafkaTopicSnapshot(
  admin: { fetchTopicOffsets(topic: string): Promise<Array<{ partition: number; offset: string }>> },
  topic: string,
): Promise<KafkaTopicSnapshot> {
  const offsets = await admin.fetchTopicOffsets(topic).catch(() => []);

  return {
    topic,
    partitions: offsets.length,
    totalOffset: offsets.reduce(
      (sum, entry) => sum + Number.parseInt(entry.offset ?? "0", 10),
      0,
    ),
  };
}

async function ensureKafkaTopics(
  admin: {
    createTopics(args: {
      topics: Array<{ topic: string; numPartitions?: number; replicationFactor?: number }>;
    }): Promise<boolean>;
  },
  config: BenchmarkConfig,
) {
  const topicPartitions = readPositiveIntegerEnv(
    "KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS",
    config.seckillBucketCount,
  );
  const resultTopicPartitions = readPositiveIntegerEnv(
    "KAFKA_SECKILL_RESULT_TOPIC_PARTITIONS",
    config.seckillBucketCount,
  );
  const dlqTopicPartitions = readPositiveIntegerEnv(
    "KAFKA_SECKILL_DLQ_TOPIC_PARTITIONS",
    config.seckillBucketCount,
  );

  await admin.createTopics({
    topics: [
      {
        topic: config.seckillRequestTopic,
        numPartitions: topicPartitions,
        replicationFactor: 1,
      },
      {
        topic: config.seckillResultTopic,
        numPartitions: resultTopicPartitions,
        replicationFactor: 1,
      },
      {
        topic: config.seckillDlqTopic,
        numPartitions: dlqTopicPartitions,
        replicationFactor: 1,
      },
    ],
  });
}

function buildKafkaReport(
  config: BenchmarkConfig,
  before: { requestTopic: KafkaTopicSnapshot; resultTopic: KafkaTopicSnapshot; dlqTopic: KafkaTopicSnapshot } | null,
  after: { requestTopic: KafkaTopicSnapshot; resultTopic: KafkaTopicSnapshot; dlqTopic: KafkaTopicSnapshot } | null,
) {
  return {
    client: config.kafkaClient,
    brokers: config.kafkaBrokers,
    ingressSource: config.ingressSource,
    benchmarkStyle: config.benchmarkStyle,
    requestTopic: config.seckillRequestTopic,
    resultTopic: config.seckillResultTopic,
    dlqTopic: config.seckillDlqTopic,
    createdBoundary: config.createdSource,
    seckill: {
      bucketCount: config.seckillBucketCount,
      maxProbe: config.seckillMaxProbe,
      directKafkaBatchSize:
        config.ingressSource === "direct_kafka" ? config.directKafkaBatchSize : undefined,
      steadyState:
        config.benchmarkStyle === "steady_state"
          ? {
              warmupMs: config.steadyStateWarmupMs,
              measureMs: config.steadyStateMeasureMs,
              cooldownMs: config.steadyStateCooldownMs,
            }
          : undefined,
    },
    appPublish: {
      batchSize: config.appPublishBatchSize,
      lingerMs: config.appPublishLingerMs,
    },
    producer: {
      lingerMs: config.producerLingerMs,
      batchNumMessages: config.producerBatchNumMessages,
    },
    requestTopicOffsets: formatKafkaTopicOffsets(before?.requestTopic, after?.requestTopic),
    resultTopicOffsets: formatKafkaTopicOffsets(before?.resultTopic, after?.resultTopic),
    dlqTopicOffsets: formatKafkaTopicOffsets(before?.dlqTopic, after?.dlqTopic),
  };
}

function selectPrimaryBucket(stableKey: string, bucketCount: number) {
  const hash = fnv1a32(stableKey);
  return hash % bucketCount;
}

function buildProcessingKey(skuId: string, bucketId: number) {
  return `${skuId}#${bucketId.toString().padStart(2, "0")}`;
}

function normalizeSeckillPartition(bucketId: number) {
  return Number.isInteger(bucketId) && bucketId >= 0 ? bucketId : 0;
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function formatKafkaTopicOffsets(
  before: KafkaTopicSnapshot | undefined,
  after: KafkaTopicSnapshot | undefined,
) {
  if (!before || !after) {
    return null;
  }

  return {
    partitions: after.partitions,
    startOffset: before.totalOffset,
    endOffset: after.totalOffset,
    delta: Math.max(0, after.totalOffset - before.totalOffset),
  };
}

function requiredEnv(name: string) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    throw new Error(`${name} is required.`);
  }

  return raw;
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

function readOptionalPositiveIntegerEnv(name: string) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function readBooleanWithDefault(name: string, fallback: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();

  if (!raw) {
    return fallback;
  }

  return raw === "1" || raw === "true" || raw === "yes";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetBuyIntentBenchmarkState(pool: Pool, _mode: "bypass") {
  const aggregateTypes = ["checkout"];

  await pool.query("begin");

  try {
    await pool.query(`delete from staged_buy_intent_command`);
    await pool.query(`delete from command_status`);
    await pool.query(`delete from seckill_command_result`);
    await pool.query(`delete from checkout_intent_projection`);
    await pool.query(`delete from order_projection`);
    await pool.query(
      `
        delete from projection_checkpoint
        where projection_name = 'main'
      `,
    );
    await pool.query(
      `
        delete from event_store
        where aggregate_type = any($1::text[])
      `,
      [aggregateTypes],
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }

  await sleep(500);
}

async function ensureBenchmarkSeckillEnabled(pool: Pool, config: BenchmarkConfig) {
  await pool.query(
    `
      update sku
      set
        seckill_enabled = true,
        seckill_stock_limit = greatest(coalesce(seckill_stock_limit, 0), $2::integer)
      where sku_id = $1
    `,
    [config.skuId, config.requests],
  );
}


main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
