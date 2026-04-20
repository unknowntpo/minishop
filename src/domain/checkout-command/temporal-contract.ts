export const buyIntentTemporalWorkflowName = "buy-intent-command-workflow";

export const buyIntentTemporalActivities = {
  markAccepted: "buy-intent-mark-accepted",
  markProcessing: "buy-intent-mark-processing",
  markCreated: "buy-intent-mark-created",
  markFailed: "buy-intent-mark-failed",
  stageCommand: "buy-intent-stage-command",
  mergeBatch: "buy-intent-merge-batch",
} as const;
