export const paymentStatuses = [
  "not_requested",
  "requested",
  "succeeded",
  "failed",
  "timeout",
] as const;

export type PaymentStatus = (typeof paymentStatuses)[number];
