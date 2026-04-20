import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";

export type BuyIntentCommandBus = {
  publish(command: BuyIntentCommand): Promise<void>;
};
