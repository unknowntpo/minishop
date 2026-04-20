export const buyIntentTemporalWorkflowName = "buy-intent-command-workflow";
export const buyIntentTemporalTaskQueue = "buy-intent-command-orchestration";

export const buyIntentTemporalActivities = {
  markAccepted: "buy-intent-mark-accepted",
  markProcessing: "buy-intent-mark-processing",
  markCreated: "buy-intent-mark-created",
  markFailed: "buy-intent-mark-failed",
  stageCommand: "buy-intent-stage-command",
  mergeBatch: "buy-intent-merge-batch",
} as const;

export const buyIntentTemporalSignals = {
  processing: "buy-intent-processing",
  created: "buy-intent-created",
  failed: "buy-intent-failed",
} as const;

export function buyIntentTemporalWorkflowId(commandId: string) {
  return `buy-intent-command/${commandId}`;
}

export type BuyIntentTemporalWorkflowInput = {
  commandId: string;
  correlationId: string;
  issuedAt: string;
};

export type BuyIntentTemporalWorkflowResult =
  | {
      commandId: string;
      status: "created";
      checkoutIntentId: string;
      eventId: string;
      isDuplicate: boolean;
    }
  | {
      commandId: string;
      status: "failed";
      failureCode: string;
      failureMessage: string;
    };
