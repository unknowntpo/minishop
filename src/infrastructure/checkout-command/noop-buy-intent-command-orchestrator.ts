import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { BuyIntentCommandOrchestrator } from "@/src/ports/buy-intent-command-orchestrator";

export function createNoopBuyIntentCommandOrchestrator(): BuyIntentCommandOrchestrator {
  return {
    async start(_command: BuyIntentCommand) {},
    async markProcessing(_commandId: string) {},
    async markCreated(_input) {},
    async markFailed(_input) {},
  };
}
