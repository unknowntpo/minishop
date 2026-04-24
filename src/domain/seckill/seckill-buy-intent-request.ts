import type { CheckoutItem } from "@/src/domain/checkout/item";

export type SeckillEventMetadata = {
  request_id: string;
  trace_id: string;
  source: "web" | "api" | "worker" | "benchmark";
  actor_id: string;
};

export type SeckillBuyIntentCommand = {
  command_id: string;
  correlation_id: string;
  buyer_id: string;
  items: CheckoutItem[];
  idempotency_key?: string;
  metadata: SeckillEventMetadata;
  issued_at: string;
};

export type SeckillBuyIntentRequest = {
  sku_id: string;
  quantity: number;
  seckill_stock_limit: number;
  bucket_count: number;
  primary_bucket_id: number;
  bucket_id: number;
  attempt: number;
  max_probe: number;
  processing_key: string;
  command: SeckillBuyIntentCommand;
};
