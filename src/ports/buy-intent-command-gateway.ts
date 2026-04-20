import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { BuyIntentCommandStatus } from "@/src/domain/checkout-command/command-status";

export type AcceptedBuyIntentCommand = {
  commandId: string;
  correlationId: string;
  status: Extract<BuyIntentCommandStatus, "accepted">;
};

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
};

export type BuyIntentCommandGateway = {
  createAccepted(command: BuyIntentCommand): Promise<AcceptedBuyIntentCommand>;
  readStatus(commandId: string): Promise<BuyIntentCommandStatusView | null>;
  claimPendingBatch(input: { batchId: string; batchSize: number }): Promise<StagedBuyIntentCommand[]>;
  markProcessing(commandId: string): Promise<void>;
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
  markFailed(input: {
    stagingId: number;
    commandId: string;
    failureCode: string;
    failureMessage: string;
    dlq?: boolean;
  }): Promise<void>;
  markMergedDuplicateCommand(input: { stagingId: number; commandId: string }): Promise<void>;
};
