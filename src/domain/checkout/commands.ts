import type { CheckoutItem } from "@/src/domain/checkout/item";
import type { EventMetadata } from "@/src/domain/events/event-metadata";

export type CreateCheckoutIntentCommand = {
  buyer_id: string;
  items: CheckoutItem[];
  idempotency_key?: string;
  metadata: EventMetadata;
};
