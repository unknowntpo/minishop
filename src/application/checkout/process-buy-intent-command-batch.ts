import { createCheckoutIntent } from "@/src/application/checkout/create-checkout-intent";
import type { Clock } from "@/src/ports/clock";
import type { BuyIntentCommandGateway } from "@/src/ports/buy-intent-command-gateway";
import type { EventStore } from "@/src/ports/event-store";
import type { IdGenerator } from "@/src/ports/id-generator";

export type ProcessBuyIntentCommandBatchDeps = {
  gateway: BuyIntentCommandGateway;
  eventStore: EventStore;
  idGenerator: IdGenerator;
  clock: Clock;
};

export type ProcessBuyIntentCommandBatchResult = {
  batchId: string;
  claimedCount: number;
  createdCount: number;
  failedCount: number;
  duplicateCommandCount: number;
};

export async function processBuyIntentCommandBatch(
  input: { batchSize?: number },
  deps: ProcessBuyIntentCommandBatchDeps,
): Promise<ProcessBuyIntentCommandBatchResult> {
  const batchSize = Math.max(1, input.batchSize ?? 100);
  const batchId = deps.idGenerator.randomUuid();
  const claimed = await deps.gateway.claimPendingBatch({ batchId, batchSize });

  let createdCount = 0;
  let failedCount = 0;
  let duplicateCommandCount = 0;

  for (const row of claimed) {
    const existing = await deps.gateway.readStatus(row.commandId);

    if (!existing) {
      await deps.gateway.markFailed({
        stagingId: row.stagingId,
        commandId: row.commandId,
        failureCode: "missing_command_status",
        failureMessage: "Command status row was not found for claimed staging entry.",
      });
      failedCount += 1;
      continue;
    }

    if (existing.status === "created" || existing.status === "failed") {
      await deps.gateway.markMergedDuplicateCommand({
        stagingId: row.stagingId,
        commandId: row.commandId,
      });
      duplicateCommandCount += 1;
      continue;
    }

    await deps.gateway.markProcessing(row.commandId);

    try {
      const result = await createCheckoutIntent(
        {
          buyer_id: row.payload.buyer_id,
          items: row.payload.items,
          ...(row.payload.idempotency_key ? { idempotency_key: row.payload.idempotency_key } : {}),
          metadata: row.payload.metadata,
        },
        {
          eventStore: deps.eventStore,
          idGenerator: deps.idGenerator,
          clock: deps.clock,
        },
      );

      await deps.gateway.markCreated({
        stagingId: row.stagingId,
        commandId: row.commandId,
        checkoutIntentId: result.checkoutIntentId,
        eventId: result.eventId,
        isDuplicate: result.idempotentReplay,
      });
      createdCount += 1;
    } catch (error) {
      await deps.gateway.markFailed({
        stagingId: row.stagingId,
        commandId: row.commandId,
        failureCode: "merge_failed",
        failureMessage: error instanceof Error ? error.message : "Unknown merge failure.",
      });
      failedCount += 1;
    }
  }

  return {
    batchId,
    claimedCount: claimed.length,
    createdCount,
    failedCount,
    duplicateCommandCount,
  };
}
