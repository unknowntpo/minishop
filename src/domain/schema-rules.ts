export type RecordValue = Record<string, unknown>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stableTextIdentifierPattern = /^[a-z][a-z0-9_-]{1,127}$/;
const currencyCodePattern = /^[A-Z]{3}$/;

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function optionalNonEmptyString(value: unknown) {
  return value === undefined || isNonEmptyString(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function isStableTextIdentifier(value: unknown): value is string {
  return typeof value === "string" && stableTextIdentifierPattern.test(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && currencyCodePattern.test(value);
}

export function isCheckoutItemJson(value: unknown) {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isStableTextIdentifier(value.sku_id) &&
    isPositiveInteger(value.quantity) &&
    isNonNegativeInteger(value.unit_price_amount_minor) &&
    isCurrencyCode(value.currency)
  );
}

export function isCheckoutItemJsonList(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isCheckoutItemJson)) {
    return false;
  }

  const [firstItem] = value;
  return value.every((item) => item.currency === firstItem.currency);
}

export function isEventMetadataJson(value: unknown) {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.request_id) &&
    isNonEmptyString(value.trace_id) &&
    ["web", "api", "worker", "benchmark"].includes(String(value.source)) &&
    isNonEmptyString(value.actor_id) &&
    optionalNonEmptyString(value.traceparent) &&
    optionalNonEmptyString(value.tracestate) &&
    optionalNonEmptyString(value.baggage)
  );
}

export function isReservationIdentityPayload(value: unknown) {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isUuid(value.checkout_intent_id) &&
    isUuid(value.reservation_id) &&
    isStableTextIdentifier(value.sku_id) &&
    isPositiveInteger(value.quantity)
  );
}
