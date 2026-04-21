import "dotenv/config";

import { Kafka, logLevel } from "kafkajs";

import { getPool } from "@/db/client";
import type { SeckillCommandOutcome } from "@/src/domain/seckill/seckill-command-outcome";
import { createPostgresSeckillResultSink } from "@/src/infrastructure/seckill/postgres-seckill-result-sink";

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

  const kafka = new Kafka({
    clientId,
    brokers,
    logLevel: logLevel.NOTHING,
  });
  const consumer = kafka.consumer({ groupId });
  const sink = createPostgresSeckillResultSink(getPool());

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });

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
      await sink.persistOutcome(outcome);
    },
  });
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
