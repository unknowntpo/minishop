import type { CheckoutItem } from "@/src/domain/checkout/item";
import type { EventMetadata } from "@/src/domain/events/event-metadata";

export type BuyIntentCommand = {
  command_id: string;
  correlation_id: string;
  buyer_id: string;
  items: CheckoutItem[];
  idempotency_key?: string;
  metadata: EventMetadata;
  issued_at: string;
};
