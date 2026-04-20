import "dotenv/config";

import { headers } from "nats";

import { ingestBuyIntentCommandMessage } from "@/src/application/checkout/ingest-buy-intent-command-message";
import {
  buyIntentCommandCodec,
  ensureBuyIntentCommandConsumer,
  ensureBuyIntentCommandStream,
  getNatsConnection,
} from "@/src/infrastructure/checkout-command/nats-buy-intent-command-topology";
import { postgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command";

async function main() {
  const servers = readRequiredEnv("NATS_URL");
  const streamName = process.env.NATS_BUY_INTENT_STREAM?.trim() || "BUY_INTENT_COMMANDS";
  const subject = process.env.NATS_BUY_INTENT_SUBJECT?.trim() || "buy-intent.command";
  const retrySubject = process.env.NATS_BUY_INTENT_RETRY_SUBJECT?.trim() || "buy-intent.retry";
  const dlqSubject = process.env.NATS_BUY_INTENT_DLQ_SUBJECT?.trim() || "buy-intent.dlq";
  const durableConsumer =
    process.env.NATS_BUY_INTENT_DURABLE_CONSUMER?.trim() || "buy-intent-ingest";
  const batchSize = readPositiveIntegerEnv("NATS_BUY_INTENT_INGEST_BATCH_SIZE", 100);
  const expiresMs = readPositiveIntegerEnv("NATS_BUY_INTENT_INGEST_EXPIRES_MS", 1_000);
  const retryDelayMs = readPositiveIntegerEnv("NATS_BUY_INTENT_INGEST_RETRY_DELAY_MS", 1_000);
  const continuous = readBooleanEnv("NATS_BUY_INTENT_INGEST_CONTINUOUS");

  await ensureBuyIntentCommandConsumer({
    servers,
    streamName,
    subject,
    retrySubject,
    dlqSubject,
    durableConsumer,
    ackWaitMs: readPositiveIntegerEnv("NATS_BUY_INTENT_ACK_WAIT_MS", 30_000),
  });

  const nc = await getNatsConnection(servers);
  const js = nc.jetstream();
  await ensureBuyIntentCommandStream({
    servers,
    streamName,
    subject,
    retrySubject,
    dlqSubject,
  });

  let receivedCount = 0;
  let stagedCount = 0;
  let decodeFailedCount = 0;
  let retriedCount = 0;
  let batchFetchCount = 0;

  do {
    batchFetchCount += 1;
    const messages = js.fetch(streamName, durableConsumer, { batch: batchSize, expires: expiresMs });
    let emptyBatch = true;

    for await (const message of messages) {
      emptyBatch = false;
      receivedCount += 1;

      const result = await ingestBuyIntentCommandMessage(
        {
          data: message.data,
          sourceSubject: message.subject,
        },
        {
          decode(data) {
            return buyIntentCommandCodec.decode(data);
          },
          stage(command) {
            return postgresBuyIntentCommandGateway.stage(command);
          },
          async publishDlq({ reason, sourceSubject, data }) {
            await js.publish(dlqSubject, data, {
              headers: buildDlqHeaders({
                reason,
                sourceSubject,
              }),
            });
          },
        },
      );

      if (result.outcome === "ack") {
        message.ack();
        if (result.staged) {
          stagedCount += 1;
        } else {
          decodeFailedCount += 1;
        }
        continue;
      }

      try {
        message.nak(retryDelayMs);
        retriedCount += 1;
      } catch (error) {
        console.error("buy_intent_command_bus_nak_failed", error);
      }
    }

    if (!continuous && emptyBatch) {
      break;
    }
  } while (continuous);

  console.log(
    JSON.stringify(
      {
        streamName,
        durableConsumer,
        subject,
        batchSize,
        expiresMs,
        continuous,
        batchFetchCount,
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

function readBooleanEnv(name: string) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function buildDlqHeaders(input: { reason: string; sourceSubject: string }) {
  const h = headers();
  h.set("x-buy-intent-dlq-reason", input.reason);
  h.set("x-buy-intent-source-subject", input.sourceSubject);
  return h;
}

main().catch((error) => {
  console.error("buy_intent_command_bus_ingest_failed", error);
  process.exitCode = 1;
});
