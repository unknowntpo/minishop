export type CheckoutItem = {
  sku_id: string;
  quantity: number;
  unit_price_amount_minor: number;
  currency: string;
};

export function isCheckoutItem(value: unknown): value is CheckoutItem {
  if (!isRecord(value)) {
    return false;
  }

  const quantity = value.quantity;
  const unitPriceAmountMinor = value.unit_price_amount_minor;

  return (
    isNonEmptyString(value.sku_id) &&
    Number.isInteger(quantity) &&
    typeof quantity === "number" &&
    quantity > 0 &&
    Number.isInteger(unitPriceAmountMinor) &&
    typeof unitPriceAmountMinor === "number" &&
    unitPriceAmountMinor >= 0 &&
    isNonEmptyString(value.currency)
  );
}

export function assertCheckoutItems(items: unknown): asserts items is CheckoutItem[] {
  if (!Array.isArray(items) || items.length === 0 || !items.every(isCheckoutItem)) {
    throw new Error("Checkout items must be a non-empty array of valid SKU items.");
  }

  const [firstItem] = items;
  const hasMixedCurrency = items.some((item) => item.currency !== firstItem.currency);

  if (hasMixedCurrency) {
    throw new Error("Checkout items must use one currency.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
