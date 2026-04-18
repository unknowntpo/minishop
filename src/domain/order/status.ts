export const orderStatuses = ["pending_payment", "confirmed", "cancelled"] as const;

export type OrderStatus = (typeof orderStatuses)[number];
