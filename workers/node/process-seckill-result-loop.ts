import "dotenv/config";

import type { KafkaMessageHeaderValue } from "@/src/infrastructure/kafka/confluent-kafka";
import { getPool } from "@/db/client";
import type { SeckillCommandOutcome } from "@/src/domain/seckill/seckill-command-outcome";
import { loadConfluentKafkaJsCompat } from "@/src/infrastructure/kafka/confluent-kafka";
import { createPostgresSeckillResultSink } from "@/src/infrastructure/seckill/postgres-seckill-result-sink";
import {
  extractContextFromTraceCarrier,
  withSpan,
} from "@/src/infrastructure/telemetry/otel";

async function main() {
  const brokers = readRequiredEnv("KAFKA_BROKERS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const topic = process.env.KAFKA_SECKILL_RESULT_TOPIC?.trim() || "inventory.seckill.result";
  const groupId =
    process.env.KAFKA_SECKILL_RESULT_SINK_GROUP_ID?.trim() || "minishop-seckill-result-sink";
  const clientId =
    process.env.KAFKA_SECKILL_RESULT_SINK_CLIENT_ID?.trim() || "minishop-seckill-result-sink";
  const partitionsConsumedConcurrently = readPositiveIntegerEnv(
    "KAFKA_SECKILL_RESULT_SINK_PARTITIONS_CONCURRENTLY",
    6,
  );

  const { Kafka, logLevel } = await loadConfluentKafkaJsCompat();
  const kafka = new Kafka({
    kafkaJS: {
      clientId,
      brokers,
      logLevel: logLevel.NOTHING,
    },
  });
  const consumer = kafka.consumer({
    kafkaJS: {
      groupId,
      fromBeginning: false,
    },
  });
  const sink = createPostgresSeckillResultSink(getPool());

  await consumer.connect();
  await consumer.subscribe({ topic });

  const shutdown = async () => {
    await consumer.disconnect().catch(() => undefined);
    await getPool().end().catch(() => undefined);
  };

  process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  await consumer.run({
    partitionsConsumedConcurrently,
    eachMessage: async ({ message }) => {
      if (!message.value) {
        return;
      }

      const outcome = JSON.parse(message.value.toString("utf8")) as SeckillCommandOutcome;
      const parentContext = extractContextFromTraceCarrier(traceCarrierFromKafkaHeaders(message.headers));
      await withSpan(
        "inventory.seckill.result.persist",
        {
          attributes: {
            "messaging.system": "kafka",
            "messaging.destination.name": topic,
            "buy_intent.command_id": outcome.result.commandId,
            "buy_intent.correlation_id": outcome.result.correlationId,
            "buy_intent.sku_id": outcome.result.skuId,
            "seckill.result.status": outcome.result.status,
          },
        },
        async () => {
          await sink.persistOutcome(outcome);
        },
        parentContext,
      );
    },
  });
}

function traceCarrierFromKafkaHeaders(
  headers?: Record<string, KafkaMessageHeaderValue>,
): { traceparent?: string; tracestate?: string; baggage?: string } | undefined {
  if (!headers) {
    return undefined;
  }

  const traceparent = decodeKafkaHeader(headers.traceparent);
  const tracestate = decodeKafkaHeader(headers.tracestate);
  const baggage = decodeKafkaHeader(headers.baggage);

  if (!traceparent && !tracestate && !baggage) {
    return undefined;
  }

  return {
    ...(traceparent ? { traceparent } : {}),
    ...(tracestate ? { tracestate } : {}),
    ...(baggage ? { baggage } : {}),
  };
}

function decodeKafkaHeader(value?: KafkaMessageHeaderValue): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const firstValue = Array.isArray(value) ? value[0] : value;

  if (typeof firstValue === "string") {
    return firstValue;
  }

  if (Buffer.isBuffer(firstValue)) {
    return firstValue.toString("utf8");
  }

  return undefined;
}

function readRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = process.env[name]?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

main().catch((error) => {
  console.error("seckill_result_sink_failed", error);
  process.exitCode = 1;
});
