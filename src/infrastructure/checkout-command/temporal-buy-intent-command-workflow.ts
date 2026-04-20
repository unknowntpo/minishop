import { condition, defineSignal, setHandler } from "@temporalio/workflow";

import {
  buyIntentTemporalSignals,
  type BuyIntentTemporalWorkflowInput,
  type BuyIntentTemporalWorkflowResult,
} from "@/src/domain/checkout-command/temporal-contract";

const processingSignal = defineSignal<[string]>(buyIntentTemporalSignals.processing);
const createdSignal = defineSignal<
  [
    {
      checkoutIntentId: string;
      eventId: string;
      isDuplicate: boolean;
    },
  ]
>(buyIntentTemporalSignals.created);
const failedSignal = defineSignal<
  [
    {
      failureCode: string;
      failureMessage: string;
    },
  ]
>(buyIntentTemporalSignals.failed);

export async function buyIntentCommandWorkflow(
  input: BuyIntentTemporalWorkflowInput,
): Promise<BuyIntentTemporalWorkflowResult> {
  let state: "accepted" | "processing" = "accepted";
  let terminalResult: BuyIntentTemporalWorkflowResult | null = null;

  setHandler(processingSignal, () => {
    if (state === "accepted") {
      state = "processing";
    }
  });

  setHandler(createdSignal, ({ checkoutIntentId, eventId, isDuplicate }) => {
    terminalResult = {
      commandId: input.commandId,
      status: "created",
      checkoutIntentId,
      eventId,
      isDuplicate,
    };
  });

  setHandler(failedSignal, ({ failureCode, failureMessage }) => {
    terminalResult = {
      commandId: input.commandId,
      status: "failed",
      failureCode,
      failureMessage,
    };
  });

  await condition(() => terminalResult !== null);

  if (!terminalResult) {
    throw new Error("Workflow completed without terminal result.");
  }

  return terminalResult;
}
