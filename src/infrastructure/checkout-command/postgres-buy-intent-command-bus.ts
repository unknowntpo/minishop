import "server-only";

import type { Pool } from "pg";

import { createPostgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-gateway";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";

export function createPostgresBuyIntentCommandBus(pool: Pool): BuyIntentCommandBus {
  const gateway = createPostgresBuyIntentCommandGateway(pool);

  return {
    async publish(command) {
      await gateway.stage(command);
    },
  };
}
