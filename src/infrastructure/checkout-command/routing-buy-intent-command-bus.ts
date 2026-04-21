import type { Pool } from "pg";

import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type { SeckillBuyIntentRequest } from "@/src/domain/seckill/seckill-buy-intent-request";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";

type RoutingBuyIntentCommandBusOptions = {
  defaultBus: BuyIntentCommandBus;
  seckillBus: {
    publish(request: SeckillBuyIntentRequest): Promise<void>;
  };
  pool: Pool;
};

type SeckillSkuRow = {
  seckill_enabled: boolean;
  seckill_stock_limit: number | null;
};

export function createRoutingBuyIntentCommandBus(options: RoutingBuyIntentCommandBusOptions): BuyIntentCommandBus {
  return {
    async publish(command: BuyIntentCommand) {
      const seckillRequest = await toSeckillRequest(command, options.pool);

      if (seckillRequest) {
        await options.seckillBus.publish(seckillRequest);
        return;
      }

      await options.defaultBus.publish(command);
    },
  };
}

async function toSeckillRequest(command: BuyIntentCommand, pool: Pool) {
  if (command.items.length !== 1) {
    return null;
  }

  const [item] = command.items;

  const result = await pool.query<SeckillSkuRow>(
    `
      select seckill_enabled, seckill_stock_limit
      from sku
      where sku_id = $1
      limit 1
    `,
    [item.sku_id],
  );

  const row = result.rows[0];

  if (!row?.seckill_enabled || row.seckill_stock_limit === null) {
    return null;
  }

  return {
    sku_id: item.sku_id,
    quantity: item.quantity,
    seckill_stock_limit: row.seckill_stock_limit,
    command,
  } satisfies SeckillBuyIntentRequest;
}
