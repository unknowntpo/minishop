export const checkoutStatuses = [
  "queued",
  "reserving",
  "reserved",
  "pending_payment",
  "confirmed",
  "rejected",
  "cancelled",
  "expired",
] as const;

export type CheckoutStatus = (typeof checkoutStatuses)[number];
