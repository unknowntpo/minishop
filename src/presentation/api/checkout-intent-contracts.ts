import type { CheckoutItem } from "@/src/domain/checkout/item";

export type CreateCheckoutIntentRequest = {
  buyerId: string;
  items: Array<{
    skuId: string;
    quantity: number;
    unitPriceAmountMinor: number;
    currency: string;
  }>;
  idempotencyKey?: string;
};

export type CreateCheckoutIntentResponse = {
  checkoutIntentId: string;
  eventId: string;
  status: "queued";
  idempotentReplay: boolean;
};

export function parseCreateCheckoutIntentRequest(value: unknown): CreateCheckoutIntentRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object.");
  }

  if (!isNonEmptyString(value.buyerId)) {
    throw new Error("buyerId is required.");
  }

  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw new Error("items must be a non-empty array.");
  }

  const items = value.items.map(parseRequestItem);

  if (value.idempotencyKey !== undefined && !isNonEmptyString(value.idempotencyKey)) {
    throw new Error("idempotencyKey must be non-empty when provided.");
  }

  return {
    buyerId: value.buyerId,
    items,
    ...(value.idempotencyKey ? { idempotencyKey: value.idempotencyKey } : {}),
  };
}

export function toCheckoutItems(items: CreateCheckoutIntentRequest["items"]): CheckoutItem[] {
  return items.map((item) => ({
    sku_id: item.skuId,
    quantity: item.quantity,
    unit_price_amount_minor: item.unitPriceAmountMinor,
    currency: item.currency,
  }));
}

function parseRequestItem(value: unknown): CreateCheckoutIntentRequest["items"][number] {
  if (!isRecord(value)) {
    throw new Error("Checkout item must be an object.");
  }

  if (!isNonEmptyString(value.skuId)) {
    throw new Error("item.skuId is required.");
  }

  const quantity = value.quantity;
  const unitPriceAmountMinor = value.unitPriceAmountMinor;

  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("item.quantity must be a positive integer.");
  }

  if (
    typeof unitPriceAmountMinor !== "number" ||
    !Number.isInteger(unitPriceAmountMinor) ||
    unitPriceAmountMinor < 0
  ) {
    throw new Error("item.unitPriceAmountMinor must be a non-negative integer.");
  }

  if (!isNonEmptyString(value.currency)) {
    throw new Error("item.currency is required.");
  }

  return {
    skuId: value.skuId,
    quantity,
    unitPriceAmountMinor,
    currency: value.currency,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
