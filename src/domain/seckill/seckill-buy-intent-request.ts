import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";

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
  command: BuyIntentCommand;
};
