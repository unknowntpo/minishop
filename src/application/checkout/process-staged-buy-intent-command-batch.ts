import { SpanStatusCode } from "@opentelemetry/api";

import { createCheckoutIntent } from "@/src/application/checkout/create-checkout-intent";
import {
  extractContextFromTraceCarrier,
  setSpanAttributes,
  withSpan,
} from "@/src/infrastructure/telemetry/otel";
import type { Clock } from "@/src/ports/clock";
import type { BuyIntentCommandGateway } from "@/src/ports/buy-intent-command-gateway";
import type { BuyIntentCommandOrchestrator } from "@/src/ports/buy-intent-command-orchestrator";
import type { EventStore } from "@/src/ports/event-store";
import type { IdGenerator } from "@/src/ports/id-generator";

export type ProcessStagedBuyIntentCommandBatchDeps = {
  gateway: BuyIntentCommandGateway;
  orchestrator: BuyIntentCommandOrchestrator;
  eventStore: EventStore;
  idGenerator: IdGenerator;
  clock: Clock;
};

export type ProcessStagedBuyIntentCommandBatchResult = {
  batchId: string;
  claimedCount: number;
  createdCount: number;
  failedCount: number;
  duplicateCommandCount: number;
};

export async function processStagedBuyIntentCommandBatch(
  input: { batchSize?: number; processConcurrency?: number },
  deps: ProcessStagedBuyIntentCommandBatchDeps,
): Promise<ProcessStagedBuyIntentCommandBatchResult> {
  const batchSize = Math.max(1, input.batchSize ?? 100);
  const processConcurrency = Math.max(1, input.processConcurrency ?? 1);
  const batchId = deps.idGenerator.randomUuid();
  const claimed = await deps.gateway.claimPendingBatch({ batchId, batchSize });
  const batchParentContext = extractContextFromTraceCarrier(claimed[0]?.traceCarrier);

  return withSpan(
    "buy_intent.process_staged_batch",
    {
      attributes: {
        "buy_intent.batch_size.requested": batchSize,
        "buy_intent.process_concurrency": processConcurrency,
        "buy_intent.batch_id": batchId,
        "buy_intent.claimed_count": claimed.length,
      },
    },
    async (batchSpan) => {
      await deps.gateway.ensureAcceptedBatch(
        claimed.map((row) => ({
          commandId: row.commandId,
          correlationId: row.correlationId,
          ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
        })),
      );
      const existingByCommandId = new Map(
        (await deps.gateway.readStatuses(claimed.map((row) => row.commandId))).map((status) => [
          status.commandId,
          status,
        ]),
      );

      const missingStatuses = claimed.filter((row) => !existingByCommandId.has(row.commandId));
      if (missingStatuses.length > 0) {
        await deps.gateway.markFailedBatch(
          missingStatuses.map((row) => ({
            stagingId: row.stagingId,
            commandId: row.commandId,
            failureCode: "missing_command_status",
            failureMessage: "Command status row was not found for claimed staging entry.",
          })),
        );
      }

      const duplicateCommands = claimed.filter((row) => {
        const existing = existingByCommandId.get(row.commandId);
        return existing?.status === "created" || existing?.status === "failed";
      });
      if (duplicateCommands.length > 0) {
        await deps.gateway.markMergedDuplicateCommands(
          duplicateCommands.map((row) => ({
            stagingId: row.stagingId,
            commandId: row.commandId,
          })),
        );
      }

      const readyToProcess = claimed.filter((row) => {
        const existing = existingByCommandId.get(row.commandId);
        return existing && existing.status !== "created" && existing.status !== "failed";
      });

      await deps.gateway.markProcessingBatch(readyToProcess.map((row) => row.commandId));
      await Promise.all(
        readyToProcess.map((row) => notifyProcessing(deps.orchestrator, row.commandId)),
      );

      const outcomes = await runWithConcurrency(readyToProcess, processConcurrency, async (row) =>
        withSpan(
          "buy_intent.process_staged_command",
          {
            attributes: {
              "buy_intent.command_id": row.commandId,
              "buy_intent.staging_id": row.stagingId,
            },
          },
          async (commandSpan) => {
            try {
              const result = await createCheckoutIntent(
                {
                  buyer_id: row.payload.buyer_id,
                  items: row.payload.items,
                  ...(row.payload.idempotency_key
                    ? { idempotency_key: row.payload.idempotency_key }
                    : {}),
                  metadata: row.payload.metadata,
                },
                {
                  eventStore: deps.eventStore,
                  idGenerator: deps.idGenerator,
                  clock: deps.clock,
                },
              );

              setSpanAttributes(commandSpan, {
                "buy_intent.checkout_intent_id": result.checkoutIntentId,
                "buy_intent.event_id": result.eventId,
                "buy_intent.is_duplicate": result.idempotentReplay,
              });

              return {
                type: "created" as const,
                stagingId: row.stagingId,
                commandId: row.commandId,
                checkoutIntentId: result.checkoutIntentId,
                eventId: result.eventId,
                isDuplicate: result.idempotentReplay,
              };
            } catch (error) {
              const failureMessage = error instanceof Error ? error.message : "Unknown merge failure.";
              commandSpan.setStatus({ code: SpanStatusCode.ERROR, message: failureMessage });
              return {
                type: "failed" as const,
                stagingId: row.stagingId,
                commandId: row.commandId,
                failureCode: "merge_failed",
                failureMessage,
              };
            }
          },
          extractContextFromTraceCarrier(row.traceCarrier),
        ),
      );

      const createdOutcomes = outcomes.filter(
        (outcome): outcome is Extract<(typeof outcomes)[number], { type: "created" }> =>
          outcome.type === "created",
      );
      const failedOutcomes = outcomes.filter(
        (outcome): outcome is Extract<(typeof outcomes)[number], { type: "failed" }> =>
          outcome.type === "failed",
      );

      await deps.gateway.markCreatedBatch(createdOutcomes);
      await deps.gateway.markFailedBatch(failedOutcomes);
      await Promise.all(
        createdOutcomes.map((outcome) =>
          notifyCreated(deps.orchestrator, {
            commandId: outcome.commandId,
            checkoutIntentId: outcome.checkoutIntentId,
            eventId: outcome.eventId,
            isDuplicate: outcome.isDuplicate,
          }),
        ),
      );
      await Promise.all(
        failedOutcomes.map((outcome) =>
          notifyFailed(deps.orchestrator, {
            commandId: outcome.commandId,
            failureCode: outcome.failureCode,
            failureMessage: outcome.failureMessage,
          }),
        ),
      );

      const createdCount = createdOutcomes.length;
      const failedCount = missingStatuses.length + failedOutcomes.length;
      const duplicateCommandCount = duplicateCommands.length;

      setSpanAttributes(batchSpan, {
        "buy_intent.created_count": createdCount,
        "buy_intent.failed_count": failedCount,
        "buy_intent.duplicate_count": duplicateCommandCount,
      });

      return {
        batchId,
        claimedCount: claimed.length,
        createdCount,
        failedCount,
        duplicateCommandCount,
      };
    },
    batchParentContext,
  );
}

async function notifyProcessing(orchestrator: BuyIntentCommandOrchestrator, commandId: string) {
  try {
    await orchestrator.markProcessing(commandId);
  } catch (error) {
    console.error("buy_intent_command_orchestrator_mark_processing", {
      commandId,
      error,
    });
  }
}

async function runWithConcurrency<TInput, TOutput>(
  values: TInput[],
  concurrency: number,
  taskFor: (value: TInput) => Promise<TOutput>,
) {
  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= values.length) {
        return;
      }

      results[currentIndex] = await taskFor(values[currentIndex] as TInput);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, () => worker()),
  );

  return results;
}

async function notifyCreated(
  orchestrator: BuyIntentCommandOrchestrator,
  input: {
    commandId: string;
    checkoutIntentId: string;
    eventId: string;
    isDuplicate: boolean;
  },
) {
  try {
    await orchestrator.markCreated(input);
  } catch (error) {
    console.error("buy_intent_command_orchestrator_mark_created", {
      commandId: input.commandId,
      error,
    });
  }
}

async function notifyFailed(
  orchestrator: BuyIntentCommandOrchestrator,
  input: {
    commandId: string;
    failureCode: string;
    failureMessage: string;
  },
) {
  try {
    await orchestrator.markFailed(input);
  } catch (error) {
    console.error("buy_intent_command_orchestrator_mark_failed", {
      commandId: input.commandId,
      failureCode: input.failureCode,
      error,
    });
  }
}
