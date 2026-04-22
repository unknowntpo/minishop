import type { Pool } from "pg";

import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import type {
  SeckillBuyIntentCommand,
  SeckillBuyIntentRequest,
} from "@/src/domain/seckill/seckill-buy-intent-request";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";

type RoutingBuyIntentCommandBusOptions = {
  defaultBus: BuyIntentCommandBus;
  seckillBus: {
    publish(request: SeckillBuyIntentRequest): Promise<void>;
  };
  pool: Pool;
  bucketCount: number;
  maxProbe: number;
  seckillSkuConfigTtlMs: number;
};

type SeckillSkuRow = {
  seckill_enabled: boolean;
  seckill_stock_limit: number | null;
};

type CachedSeckillSkuConfig = {
  enabled: boolean;
  stockLimit: number | null;
  expiresAtMs: number;
};

export type SeckillRoutingDecision =
  | {
      kind: "default";
    }
  | {
      kind: "single_seckill";
      skuId: string;
      stockLimit: number;
    };

const seckillSkuConfigCache = new Map<string, CachedSeckillSkuConfig>();

export class MixedCartWithSeckillNotSupportedError extends Error {
  constructor() {
    super("Mixed cart with seckill SKU is not supported. Please checkout seckill items separately.");
    this.name = "MixedCartWithSeckillNotSupportedError";
  }
}

export function createRoutingBuyIntentCommandBus(options: RoutingBuyIntentCommandBusOptions): BuyIntentCommandBus {
  return {
    async publish(command: BuyIntentCommand) {
      const seckillRequest = await toSeckillRequest(
        command,
        options.pool,
        options.bucketCount,
        options.maxProbe,
        options.seckillSkuConfigTtlMs,
      );

      if (seckillRequest) {
        await options.seckillBus.publish(seckillRequest);
        return;
      }

      await options.defaultBus.publish(command);
    },
  };
}

export function invalidateSeckillSkuConfigCache(skuId?: string) {
  if (typeof skuId === "string" && skuId.trim()) {
    seckillSkuConfigCache.delete(skuId.trim());
    return;
  }

  seckillSkuConfigCache.clear();
}

export async function classifyBuyIntentItemsForSeckill(input: {
  items: BuyIntentCommand["items"];
  pool: Pool;
  seckillSkuConfigTtlMs: number;
}): Promise<SeckillRoutingDecision> {
  const { items, pool, seckillSkuConfigTtlMs } = input;

  if (items.length !== 1) {
    const hasSeckillSku = await containsSeckillSku(
      pool,
      items.map((item) => item.sku_id),
      seckillSkuConfigTtlMs,
    );

    if (hasSeckillSku) {
      throw new MixedCartWithSeckillNotSupportedError();
    }

    return {
      kind: "default",
    };
  }

  const [item] = items;
  const config = await readSeckillSkuConfig(pool, item.sku_id, seckillSkuConfigTtlMs);

  if (!config.enabled || config.stockLimit === null) {
    return {
      kind: "default",
    };
  }

  return {
    kind: "single_seckill",
    skuId: item.sku_id,
    stockLimit: config.stockLimit,
  };
}

async function toSeckillRequest(
  command: BuyIntentCommand,
  pool: Pool,
  bucketCount: number,
  maxProbe: number,
  seckillSkuConfigTtlMs: number,
) {
  const routing = await classifyBuyIntentItemsForSeckill({
    items: command.items,
    pool,
    seckillSkuConfigTtlMs,
  });

  if (routing.kind !== "single_seckill") {
    return null;
  }

  const [item] = command.items;
  const stableKey = command.idempotency_key ?? command.command_id;
  const primaryBucketId = selectPrimaryBucket(stableKey, bucketCount);

  return {
    sku_id: item.sku_id,
    quantity: item.quantity,
    seckill_stock_limit: routing.stockLimit,
    bucket_count: bucketCount,
    primary_bucket_id: primaryBucketId,
    bucket_id: primaryBucketId,
    attempt: 0,
    max_probe: maxProbe,
    processing_key: buildProcessingKey(item.sku_id, primaryBucketId),
    command: toSeckillCommand(command),
  } satisfies SeckillBuyIntentRequest;
}

function toSeckillCommand(command: BuyIntentCommand): SeckillBuyIntentCommand {
  return {
    command_id: command.command_id,
    correlation_id: command.correlation_id,
    buyer_id: command.buyer_id,
    items: command.items,
    ...(command.idempotency_key ? { idempotency_key: command.idempotency_key } : {}),
    metadata: {
      request_id: command.metadata.request_id,
      trace_id: command.metadata.trace_id,
      source: command.metadata.source,
      actor_id: command.metadata.actor_id,
    },
    issued_at: command.issued_at,
  };
}

async function readSeckillSkuConfig(pool: Pool, skuId: string, seckillSkuConfigTtlMs: number) {
  const now = Date.now();
  const cached = seckillSkuConfigCache.get(skuId);
  if (cached && cached.expiresAtMs > now) {
    return {
      enabled: cached.enabled,
      stockLimit: cached.stockLimit,
    };
  }

  const result = await pool.query<SeckillSkuRow>(
    `
      select seckill_enabled, seckill_stock_limit
      from sku
      where sku_id = $1
      limit 1
    `,
    [skuId],
  );

  const row = result.rows[0];
  const config = {
    enabled: row?.seckill_enabled ?? false,
    stockLimit: row?.seckill_stock_limit ?? null,
  };

  seckillSkuConfigCache.set(skuId, {
    ...config,
    expiresAtMs: now + seckillSkuConfigTtlMs,
  });

  return config;
}

async function containsSeckillSku(pool: Pool, skuIds: string[], seckillSkuConfigTtlMs: number) {
  const uniqueSkuIds = [...new Set(skuIds)];

  const uncachedSkuIds = uniqueSkuIds.filter((skuId) => {
    const cached = seckillSkuConfigCache.get(skuId);
    return !(cached && cached.expiresAtMs > Date.now());
  });

  if (uncachedSkuIds.length > 0) {
    const result = await pool.query<SeckillSkuRow & { sku_id: string }>(
      `
        select sku_id, seckill_enabled, seckill_stock_limit
        from sku
        where sku_id = any($1::text[])
      `,
      [uncachedSkuIds],
    );

    const rowsBySkuId = new Map(
      result.rows.map((row) => [
        row.sku_id,
        {
          enabled: row.seckill_enabled,
          stockLimit: row.seckill_stock_limit,
        },
      ]),
    );

    const now = Date.now();
    for (const skuId of uncachedSkuIds) {
      const config = rowsBySkuId.get(skuId) ?? {
        enabled: false,
        stockLimit: null,
      };

      seckillSkuConfigCache.set(skuId, {
        ...config,
        expiresAtMs: now + seckillSkuConfigTtlMs,
      });
    }
  }

  return uniqueSkuIds.some((skuId) => seckillSkuConfigCache.get(skuId)?.enabled === true);
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
