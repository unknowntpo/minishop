import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";

export type BuyIntentCommandOrchestrator = {
  start(command: BuyIntentCommand): Promise<void>;
  markProcessing(commandId: string): Promise<void>;
  markCreated(input: {
    commandId: string;
    checkoutIntentId: string;
    eventId: string;
    isDuplicate: boolean;
  }): Promise<void>;
  markFailed(input: {
    commandId: string;
    failureCode: string;
    failureMessage: string;
  }): Promise<void>;
};
