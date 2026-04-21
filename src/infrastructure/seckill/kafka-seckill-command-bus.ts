import { Kafka, type Admin, type Producer, logLevel } from "kafkajs";

import type { SeckillBuyIntentRequest } from "@/src/domain/seckill/seckill-buy-intent-request";
import { injectTraceCarrier, withSpan } from "@/src/infrastructure/telemetry/otel";

let sharedProducer: Producer | null = null;
let sharedAdmin: Admin | null = null;
let sharedKafka: Kafka | null = null;
let topicsEnsured: Promise<void> | null = null;
let pendingBatch: SeckillPendingMessage[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let activeFlush: Promise<void> | null = null;

type KafkaSeckillCommandBusOptions = {
  brokers: string[];
  requestTopic: string;
  resultTopic: string;
  batchSize: number;
  lingerMs: number;
  clientId?: string;
};

type SeckillPendingMessage = {
  request: SeckillBuyIntentRequest;
  headers: Record<string, Buffer>;
  resolve: () => void;
  reject: (error: unknown) => void;
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

function clearFlushTimer() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

async function sendBatch(
  options: KafkaSeckillCommandBusOptions,
  entries: SeckillPendingMessage[],
) {
  const execute = async () => {
    const producer = await getProducer(options);
    await producer.sendBatch({
      topicMessages: [
        {
          topic: options.requestTopic,
          messages: entries.map((entry) => ({
            key: entry.request.processing_key,
            value: JSON.stringify(entry.request),
            headers: entry.headers,
          })),
        },
      ],
    });
  };

  try {
    await execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("disconnected")) {
      throw error;
    }

    await resetProducer();
    await execute();
  }
}

function scheduleFlush(options: KafkaSeckillCommandBusOptions) {
  if (flushTimer || pendingBatch.length === 0) {
    return;
  }

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingBatch(options);
  }, Math.max(1, options.lingerMs));
}

function startFlush(entries: SeckillPendingMessage[], options: KafkaSeckillCommandBusOptions) {
  return (async () => {
    try {
      await ensureTopics(options);
      await sendBatch(options, entries);
      for (const entry of entries) {
        entry.resolve();
      }
    } catch (error) {
      for (const entry of entries) {
        entry.reject(error);
      }
    } finally {
      if (activeFlush) {
        activeFlush = null;
      }

      if (pendingBatch.length > 0) {
        clearFlushTimer();
        if (pendingBatch.length >= options.batchSize) {
          void flushPendingBatch(options);
        } else {
          scheduleFlush(options);
        }
      }
    }
  })();
}

function flushPendingBatch(options: KafkaSeckillCommandBusOptions) {
  if (activeFlush || pendingBatch.length === 0) {
    return activeFlush ?? Promise.resolve();
  }

  clearFlushTimer();
  const entries = pendingBatch;
  pendingBatch = [];
  activeFlush = startFlush(entries, options);
  return activeFlush;
}

function enqueuePublish(
  options: KafkaSeckillCommandBusOptions,
  request: SeckillBuyIntentRequest,
  headers: Record<string, Buffer>,
) {
  return new Promise<void>((resolve, reject) => {
    pendingBatch.push({
      request,
      headers,
      resolve,
      reject,
    });

    if (pendingBatch.length >= options.batchSize) {
      clearFlushTimer();
      void flushPendingBatch(options);
      return;
    }

    scheduleFlush(options);
  });
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
          await enqueuePublish(options, request, toKafkaHeaders());
        },
      );
    },
  };
}
