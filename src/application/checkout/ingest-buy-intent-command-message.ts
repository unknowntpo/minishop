import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { StagedBuyIntentCommandInput } from "@/src/ports/buy-intent-command-gateway";

export type IngestBuyIntentCommandMessageDeps = {
  decode(data: Uint8Array): BuyIntentCommand;
  stage(input: StagedBuyIntentCommandInput): Promise<void>;
  publishDlq(input: {
    reason: string;
    sourceSubject: string;
    data: Uint8Array;
  }): Promise<void>;
};

export type IngestBuyIntentCommandMessageResult =
  | {
      outcome: "ack";
      staged: true;
      dlqPublished: false;
    }
  | {
      outcome: "ack";
      staged: false;
      dlqPublished: true;
    }
  | {
      outcome: "nak";
      staged: false;
      dlqPublished: false;
    };

export async function ingestBuyIntentCommandMessage(
  input: { data: Uint8Array; sourceSubject: string },
  deps: IngestBuyIntentCommandMessageDeps,
): Promise<IngestBuyIntentCommandMessageResult> {
  let command: BuyIntentCommand;

  try {
    command = deps.decode(input.data);
  } catch (error) {
    if (!isCodecError(error)) {
      throw error;
    }

    await deps.publishDlq({
      reason: "invalid_buy_intent_command",
      sourceSubject: input.sourceSubject,
      data: input.data,
    });

    return {
      outcome: "ack",
      staged: false,
      dlqPublished: true,
    };
  }

  try {
    await deps.stage({ command });
    return {
      outcome: "ack",
      staged: true,
      dlqPublished: false,
    };
  } catch {
    return {
      outcome: "nak",
      staged: false,
      dlqPublished: false,
    };
  }
}

function isCodecError(error: unknown) {
  return error instanceof Error && /JSON|unexpected|invalid/i.test(error.message);
}
