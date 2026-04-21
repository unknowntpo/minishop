import type { SeckillBuyIntentRequest } from "@/src/domain/seckill/seckill-buy-intent-request";
import {
  KafkaSeckillProducer,
  type KafkaSeckillProducerOptions,
} from "@/src/infrastructure/seckill/kafka-seckill-producer";
import { SeckillPublishBatcher } from "@/src/infrastructure/seckill/seckill-publish-batcher";
import { injectTraceCarrier, withSpan } from "@/src/infrastructure/telemetry/otel";

type KafkaSeckillCommandBusOptions = KafkaSeckillProducerOptions & {
  batchSize: number;
  lingerMs: number;
};

let sharedProducer: KafkaSeckillProducer | null = null;
let sharedBatcher: SeckillPublishBatcher | null = null;

function toKafkaHeaders() {
  const carrier = injectTraceCarrier();

  return {
    ...(carrier.traceparent ? { traceparent: Buffer.from(carrier.traceparent) } : {}),
    ...(carrier.tracestate ? { tracestate: Buffer.from(carrier.tracestate) } : {}),
    ...(carrier.baggage ? { baggage: Buffer.from(carrier.baggage) } : {}),
  };
}

function getProducer(options: KafkaSeckillCommandBusOptions) {
  sharedProducer ??= new KafkaSeckillProducer(options);
  return sharedProducer;
}

function getBatcher(options: KafkaSeckillCommandBusOptions) {
  sharedBatcher ??= new SeckillPublishBatcher({
    batchSize: options.batchSize,
    lingerMs: options.lingerMs,
    flush(entries) {
      return getProducer(options).send(entries);
    },
  });
  return sharedBatcher;
}

export function createKafkaSeckillCommandBus(options: KafkaSeckillCommandBusOptions) {
  const batcher = getBatcher(options);

  return {
    async publish(request: SeckillBuyIntentRequest) {
      await withSpan(
        "buy_intent.publish_seckill",
        {
          attributes: {
            "messaging.system": "kafka",
            "messaging.operation": "publish",
            "messaging.destination.name": options.requestTopic,
            "buy_intent.command_id": request.command.command_id,
            "buy_intent.sku_id": request.sku_id,
            "buy_intent.seckill_stock_limit": request.seckill_stock_limit,
          },
        },
        async () => {
          await batcher.publish(request, toKafkaHeaders());
        },
      );
    },
  };
}
