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
  bucketCount: number;
  maxProbe: number;
};

type SeckillSkuRow = {
  seckill_enabled: boolean;
  seckill_stock_limit: number | null;
};

export function createRoutingBuyIntentCommandBus(options: RoutingBuyIntentCommandBusOptions): BuyIntentCommandBus {
  return {
    async publish(command: BuyIntentCommand) {
      const seckillRequest = await toSeckillRequest(command, options.pool, options.bucketCount, options.maxProbe);

      if (seckillRequest) {
        await options.seckillBus.publish(seckillRequest);
        return;
      }

      await options.defaultBus.publish(command);
    },
  };
}

async function toSeckillRequest(
  command: BuyIntentCommand,
  pool: Pool,
  bucketCount: number,
  maxProbe: number,
) {
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

  const stableKey = command.idempotency_key ?? command.command_id;
  const primaryBucketId = selectPrimaryBucket(stableKey, bucketCount);

  return {
    sku_id: item.sku_id,
    quantity: item.quantity,
    seckill_stock_limit: row.seckill_stock_limit,
    bucket_count: bucketCount,
    primary_bucket_id: primaryBucketId,
    bucket_id: primaryBucketId,
    attempt: 0,
    max_probe: maxProbe,
    processing_key: buildProcessingKey(item.sku_id, primaryBucketId),
    command,
  } satisfies SeckillBuyIntentRequest;
}

function selectPrimaryBucket(stableKey: string, bucketCount: number) {
  const hash = fnv1a32(stableKey);
  return hash % bucketCount;
}

function buildProcessingKey(skuId: string, bucketId: number) {
  return `${skuId}#${bucketId.toString().padStart(2, "0")}`;
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}
