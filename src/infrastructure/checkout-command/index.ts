import { getPool } from "@/db/client";
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
