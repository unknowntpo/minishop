import { getPool } from "@/db/client";
import { createPostgresCheckoutDemoRepository } from "@/src/infrastructure/checkout-demo/postgres-checkout-demo-repository";
import type { CheckoutDemoRepository } from "@/src/ports/checkout-demo-repository";

export const postgresCheckoutDemoRepository: CheckoutDemoRepository = {
  findCheckoutIntent(checkoutIntentId) {
    return createPostgresCheckoutDemoRepository(getPool()).findCheckoutIntent(checkoutIntentId);
  },
  getSkuOnHand(skuId) {
    return createPostgresCheckoutDemoRepository(getPool()).getSkuOnHand(skuId);
  },
  listQueuedCheckoutIntentIds(limit) {
    return createPostgresCheckoutDemoRepository(getPool()).listQueuedCheckoutIntentIds(limit);
  },
};
