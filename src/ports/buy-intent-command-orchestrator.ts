import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";

export type BuyIntentCommandOrchestrator = {
  start(command: BuyIntentCommand): Promise<void>;
};
