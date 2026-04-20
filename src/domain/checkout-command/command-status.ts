export const buyIntentCommandStatuses = [
  "accepted",
  "processing",
  "created",
  "failed",
] as const;

export type BuyIntentCommandStatus = (typeof buyIntentCommandStatuses)[number];
