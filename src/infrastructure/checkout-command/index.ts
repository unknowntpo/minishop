import { getPool } from "@/db/client";
import { createPostgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-gateway";
import type { BuyIntentCommandGateway } from "@/src/ports/buy-intent-command-gateway";

export const postgresBuyIntentCommandGateway: BuyIntentCommandGateway = createPostgresBuyIntentCommandGateway(
  getPool(),
);
