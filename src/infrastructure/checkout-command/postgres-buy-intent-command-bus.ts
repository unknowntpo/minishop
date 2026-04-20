import "server-only";

import type { Pool } from "pg";

import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";

export function createPostgresBuyIntentCommandBus(pool: Pool): BuyIntentCommandBus {
  return {
    async publish(command: BuyIntentCommand) {
      await pool.query(
        `
          insert into staging_buy_intent_command (
            command_id,
            correlation_id,
            idempotency_key,
            aggregate_type,
            aggregate_id,
            payload_json,
            metadata_json
          )
          values ($1, $2, $3, 'checkout', $4, $5::jsonb, $6::jsonb)
        `,
        [
          command.command_id,
          command.correlation_id,
          command.idempotency_key ?? null,
          command.command_id,
          JSON.stringify(command),
          JSON.stringify(command.metadata),
        ],
      );
    },
  };
}
