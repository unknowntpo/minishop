import "dotenv/config";

import { getNatsConnection } from "@/src/infrastructure/checkout-command/nats-buy-intent-command-topology";
import {
  buyIntentCommandCodec,
  ensureBuyIntentCommandConsumer,
} from "@/src/infrastructure/checkout-command/nats-buy-intent-command-topology";
import { postgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command";

async function main() {
  const servers = readRequiredEnv("NATS_URL");
  const streamName = process.env.NATS_BUY_INTENT_STREAM?.trim() || "BUY_INTENT_COMMANDS";
  const subject = process.env.NATS_BUY_INTENT_SUBJECT?.trim() || "buy-intent.command";
  const durableConsumer =
    process.env.NATS_BUY_INTENT_DURABLE_CONSUMER?.trim() || "buy-intent-ingest";
  const batchSize = readPositiveIntegerEnv("NATS_BUY_INTENT_INGEST_BATCH_SIZE", 100);
  const expiresMs = readPositiveIntegerEnv("NATS_BUY_INTENT_INGEST_EXPIRES_MS", 1_000);
  const retryDelayMs = readPositiveIntegerEnv("NATS_BUY_INTENT_INGEST_RETRY_DELAY_MS", 1_000);

  await ensureBuyIntentCommandConsumer({
    servers,
    streamName,
    subject,
    durableConsumer,
    ackWaitMs: readPositiveIntegerEnv("NATS_BUY_INTENT_ACK_WAIT_MS", 30_000),
  });

  const nc = await getNatsConnection(servers);
  const js = nc.jetstream();
  const messages = js.fetch(streamName, durableConsumer, { batch: batchSize, expires: expiresMs });

  let receivedCount = 0;
  let stagedCount = 0;
  let decodeFailedCount = 0;
  let retriedCount = 0;

  for await (const message of messages) {
    receivedCount += 1;

    try {
      const command = buyIntentCommandCodec.decode(message.data);
      await postgresBuyIntentCommandGateway.stage(command);
      message.ack();
      stagedCount += 1;
    } catch (error) {
      if (isCodecError(error)) {
        message.term("invalid_buy_intent_command");
        decodeFailedCount += 1;
        continue;
      }

      message.nak(retryDelayMs);
      retriedCount += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        streamName,
        durableConsumer,
        subject,
        batchSize,
        expiresMs,
        receivedCount,
        stagedCount,
        decodeFailedCount,
        retriedCount,
      },
      null,
      2,
    ),
  );
}

function readRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isCodecError(error: unknown) {
  return error instanceof Error && /JSON|unexpected|invalid/i.test(error.message);
}

main().catch((error) => {
  console.error("buy_intent_command_bus_ingest_failed", error);
  process.exitCode = 1;
});
