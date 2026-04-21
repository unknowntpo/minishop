import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { BuyIntentCommandStatus } from "@/src/domain/checkout-command/command-status";
import type { TraceCarrier } from "@/src/ports/trace-carrier";

export type BuyIntentCommandStatusView = {
  commandId: string;
  correlationId: string;
  status: BuyIntentCommandStatus;
  checkoutIntentId: string | null;
  eventId: string | null;
  isDuplicate: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StagedBuyIntentCommand = {
  stagingId: number;
  commandId: string;
  correlationId: string;
  idempotencyKey?: string;
  payload: BuyIntentCommand;
  traceCarrier?: TraceCarrier;
};

export type StagedBuyIntentCommandInput = {
  command: BuyIntentCommand;
  traceCarrier?: TraceCarrier;
};

export type BuyIntentCommandGateway = {
  readStatus(commandId: string): Promise<BuyIntentCommandStatusView | null>;
  readStatuses(commandIds: string[]): Promise<BuyIntentCommandStatusView[]>;
  stage(input: StagedBuyIntentCommandInput): Promise<void>;
  stageBatch(inputs: StagedBuyIntentCommandInput[]): Promise<void>;
  ensureAcceptedBatch(
    commands: Array<{
      commandId: string;
      correlationId: string;
      idempotencyKey?: string;
    }>,
  ): Promise<void>;
  claimPendingBatch(input: { batchId: string; batchSize: number }): Promise<StagedBuyIntentCommand[]>;
  markProcessing(commandId: string): Promise<void>;
  markProcessingBatch(commandIds: string[]): Promise<void>;
  markPublishFailed(input: {
    commandId: string;
    failureCode: string;
    failureMessage: string;
  }): Promise<void>;
  markCreated(input: {
    stagingId: number;
    commandId: string;
    checkoutIntentId: string;
    eventId: string;
    isDuplicate: boolean;
  }): Promise<void>;
  markCreatedBatch(
    inputs: Array<{
      stagingId: number;
      commandId: string;
      checkoutIntentId: string;
      eventId: string;
      isDuplicate: boolean;
    }>,
  ): Promise<void>;
  markFailed(input: {
    stagingId: number;
    commandId: string;
    failureCode: string;
    failureMessage: string;
    dlq?: boolean;
  }): Promise<void>;
  markFailedBatch(
    inputs: Array<{
      stagingId: number;
      commandId: string;
      failureCode: string;
      failureMessage: string;
      dlq?: boolean;
    }>,
  ): Promise<void>;
  markMergedDuplicateCommand(input: { stagingId: number; commandId: string }): Promise<void>;
  markMergedDuplicateCommands(inputs: Array<{ stagingId: number; commandId: string }>): Promise<void>;
};
