import type { CheckoutItem } from "@/src/domain/checkout/item";

export type DemoCheckoutIntent = {
  checkoutIntentId: string;
  buyerId: string;
  items: CheckoutItem[];
};

export type CheckoutDemoRepository = {
  findCheckoutIntent(checkoutIntentId: string): Promise<DemoCheckoutIntent | null>;
  getSkuOnHand(skuId: string): Promise<number | null>;
  listQueuedCheckoutIntentIds(limit: number): Promise<string[]>;
};
