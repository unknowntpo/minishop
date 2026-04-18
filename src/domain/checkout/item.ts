import { isCheckoutItemJson, isCheckoutItemJsonList } from "@/src/domain/schema-rules";

export type CheckoutItem = {
  sku_id: string;
  quantity: number;
  unit_price_amount_minor: number;
  currency: string;
};

export function isCheckoutItem(value: unknown): value is CheckoutItem {
  return isCheckoutItemJson(value);
}

export function assertCheckoutItems(items: unknown): asserts items is CheckoutItem[] {
  if (!isCheckoutItemJsonList(items)) {
    throw new Error("Checkout items must be a non-empty array of valid SKU items.");
  }
}
