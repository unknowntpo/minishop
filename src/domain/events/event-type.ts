export const eventTypes = [
  "CheckoutIntentCreated",
  "InventoryReservationRequested",
  "InventoryReserved",
  "InventoryReservationRejected",
  "PaymentRequested",
  "PaymentSucceeded",
  "PaymentFailed",
  "InventoryReservationReleased",
  "OrderConfirmed",
  "OrderCancelled",
] as const;

export type EventType = (typeof eventTypes)[number];

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && eventTypes.includes(value as EventType);
}
