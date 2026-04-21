import type { CheckoutItem } from "@/src/domain/checkout/item";
import type { EventMetadata } from "@/src/domain/events/event-metadata";

export type SeckillCommandResult = {
  commandId: string;
  correlationId: string;
  skuId: string;
  checkoutIntentId: string | null;
  status: "reserved" | "rejected";
  requestedQuantity: number;
  seckillStockLimit: number;
  failureReason: string | null;
  eventId: string | null;
  duplicate: boolean;
};

export type SeckillCommandOutcomeRequest = {
  commandId: string;
  correlationId: string;
  buyerId: string;
  items: CheckoutItem[];
  idempotencyKey?: string | null;
  metadata: EventMetadata;
};

export type SeckillCommandOutcome = {
  request: SeckillCommandOutcomeRequest;
  result: SeckillCommandResult;
  processedAt: string;
};
