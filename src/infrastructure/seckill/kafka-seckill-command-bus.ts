import { Kafka, type Admin, type Producer, logLevel } from "kafkajs";

import type { SeckillBuyIntentRequest } from "@/src/domain/seckill/seckill-buy-intent-request";
import { injectTraceCarrier, withSpan } from "@/src/infrastructure/telemetry/otel";

let sharedProducer: Producer | null = null;
let sharedAdmin: Admin | null = null;
let sharedKafka: Kafka | null = null;
let topicsEnsured: Promise<void> | null = null;

type KafkaSeckillCommandBusOptions = {
  brokers: string[];
  requestTopic: string;
  resultTopic: string;
  clientId?: string;
};

function getKafka(options: KafkaSeckillCommandBusOptions) {
  sharedKafka ??= new Kafka({
    clientId: options.clientId ?? "minishop-seckill-app",
    brokers: options.brokers,
    logLevel: logLevel.NOTHING,
  });
  return sharedKafka;
}

async function getProducer(options: KafkaSeckillCommandBusOptions) {
  if (sharedProducer) {
    await sharedProducer.connect();
    return sharedProducer;
  }

  sharedProducer = getKafka(options).producer({
    allowAutoTopicCreation: true,
  });
  await sharedProducer.connect();

  return sharedProducer;
}

async function resetProducer() {
  const producer = sharedProducer;
  sharedProducer = null;
  if (!producer) {
    return;
  }

  try {
    await producer.disconnect();
  } catch {
    // Ignore disconnect races while replacing a stale shared producer.
  }
}

async function getAdmin(options: KafkaSeckillCommandBusOptions) {
  if (sharedAdmin) {
    return sharedAdmin;
  }

  sharedAdmin = getKafka(options).admin();
  await sharedAdmin.connect();
  return sharedAdmin;
}

async function ensureTopics(options: KafkaSeckillCommandBusOptions) {
  if (topicsEnsured) {
    return topicsEnsured;
  }

  topicsEnsured = (async () => {
    const admin = await getAdmin(options);
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic: options.requestTopic,
          numPartitions: 6,
          replicationFactor: 1,
        },
        {
          topic: options.resultTopic,
          numPartitions: 6,
          replicationFactor: 1,
        },
      ],
    });
  })();

  return topicsEnsured;
}

function toKafkaHeaders() {
  const carrier = injectTraceCarrier();

  return {
    ...(carrier.traceparent ? { traceparent: Buffer.from(carrier.traceparent) } : {}),
    ...(carrier.tracestate ? { tracestate: Buffer.from(carrier.tracestate) } : {}),
    ...(carrier.baggage ? { baggage: Buffer.from(carrier.baggage) } : {}),
  };
}

export function createKafkaSeckillCommandBus(options: KafkaSeckillCommandBusOptions) {
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
          await ensureTopics(options);
          const send = async () => {
            const producer = await getProducer(options);
            await producer.send({
              topic: options.requestTopic,
              messages: [
                {
                  key: request.processing_key,
                  value: JSON.stringify(request),
                  headers: toKafkaHeaders(),
                },
              ],
            });
          };

          try {
            await send();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.toLowerCase().includes("disconnected")) {
              throw error;
            }

            await resetProducer();
            await send();
          }
        },
      );
    },
  };
}
