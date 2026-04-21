import type { SeckillBuyIntentRequest } from "@/src/domain/seckill/seckill-buy-intent-request";

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

export type SeckillCommandOutcome = {
  request: SeckillBuyIntentRequest;
  result: SeckillCommandResult;
  processedAt: string;
};
