import type { CheckoutItem } from "@/src/domain/checkout/item";

export type ConfirmOrderCommand = {
  order_id: string;
  checkout_intent_id: string;
  buyer_id: string;
  items: CheckoutItem[];
  total_amount_minor: number;
};

export type CancelOrderCommand = {
  order_id: string;
  checkout_intent_id: string;
  reason: string;
};
