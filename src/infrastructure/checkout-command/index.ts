import { getPool } from "@/db/client";
import { createNatsBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/nats-buy-intent-command-bus";
import { createPostgresBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-bus";
import { createPostgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-gateway";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";
import type { BuyIntentCommandGateway } from "@/src/ports/buy-intent-command-gateway";

export const postgresBuyIntentCommandGateway: BuyIntentCommandGateway = createPostgresBuyIntentCommandGateway(
  getPool(),
);

export const postgresBuyIntentCommandBus: BuyIntentCommandBus = createPostgresBuyIntentCommandBus(
  getPool(),
);

export const buyIntentCommandBus: BuyIntentCommandBus = process.env.NATS_URL?.trim()
  ? createNatsBuyIntentCommandBus({
      servers: process.env.NATS_URL,
      streamName: process.env.NATS_BUY_INTENT_STREAM?.trim() || "BUY_INTENT_COMMANDS",
      subject: process.env.NATS_BUY_INTENT_SUBJECT?.trim() || "buy-intent.command",
      retrySubject: process.env.NATS_BUY_INTENT_RETRY_SUBJECT?.trim() || "buy-intent.retry",
      dlqSubject: process.env.NATS_BUY_INTENT_DLQ_SUBJECT?.trim() || "buy-intent.dlq",
    })
  : postgresBuyIntentCommandBus;
