import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";

export type SeckillBuyIntentRequest = {
  sku_id: string;
  quantity: number;
  seckill_stock_limit: number;
  command: BuyIntentCommand;
};
