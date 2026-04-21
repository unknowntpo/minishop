import type { Pool } from "pg";

import { assertValidBuyIntentCommandContract } from "@/src/contracts/buy-intent-command-contract";
import { createPostgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-gateway";
import { injectTraceCarrier, withSpan } from "@/src/infrastructure/telemetry/otel";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";

export function createPostgresBuyIntentCommandBus(pool: Pool): BuyIntentCommandBus {
  const gateway = createPostgresBuyIntentCommandGateway(pool);

  return {
    async publish(command) {
      assertValidBuyIntentCommandContract(command);
      await withSpan(
        "buy_intent.stage_direct",
        {
          attributes: {
            "messaging.system": "postgres",
            "messaging.destination.name": "staged_buy_intent_command",
            "buy_intent.command_id": command.command_id,
          },
        },
        async () => {
          await gateway.stage({
            command,
            traceCarrier: injectTraceCarrier(),
          });
        },
      );
    },
  };
}
