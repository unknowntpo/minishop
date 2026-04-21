import "dotenv/config";

import { trace } from "@opentelemetry/api";
import { headers, type JsMsg } from "nats";

import { parseBuyIntentCommandContract } from "@/src/contracts/buy-intent-command-contract";
import {
  buyIntentCommandCodec,
  ensureBuyIntentCommandConsumer,
  ensureBuyIntentCommandStream,
  getNatsConnection,
} from "@/src/infrastructure/checkout-command/nats-buy-intent-command-topology";
import { postgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command";
import {
  extractContextFromNatsHeaders,
  injectTraceCarrier,
  setSpanAttributes,
  withSpan,
} from "@/src/infrastructure/telemetry/otel";

async function main() {
  const tracer = trace.getTracer("minishop");
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
    const stagedBatch: Array<{
      message: JsMsg;
      command: ReturnType<typeof parseBuyIntentCommandContract>;
      parentContext: ReturnType<typeof extractContextFromNatsHeaders>;
    }> = [];

    for await (const message of messages) {
      emptyBatch = false;
      receivedCount += 1;
      const parentContext = extractContextFromNatsHeaders(message.headers);
      const receiveSpan = tracer.startSpan(
        "buy_intent.ingest_receive",
        {
          attributes: {
            "messaging.system": "nats",
            "messaging.operation": "receive",
            "messaging.destination.name": message.subject,
          },
        },
        parentContext,
      );

      try {
        const command = parseBuyIntentCommandContract(buyIntentCommandCodec.decode(message.data));
        setSpanAttributes(receiveSpan, {
          "buy_intent.command_id": command.command_id,
          "buy_intent.correlation_id": command.correlation_id,
        });
        receiveSpan.end();
        stagedBatch.push({
          message,
          command,
          parentContext,
        });
      } catch (error) {
        if (!isCodecError(error)) {
          receiveSpan.recordException(error instanceof Error ? error : new Error(String(error)));
          receiveSpan.end();
          throw error;
        }

        await js.publish(dlqSubject, message.data, {
          headers: buildDlqHeaders({
            reason: "invalid_buy_intent_command",
            sourceSubject: message.subject,
          }),
        });
        message.ack();
        decodeFailedCount += 1;
        receiveSpan.recordException(error instanceof Error ? error : new Error(String(error)));
        receiveSpan.end();
      }
    }

    if (stagedBatch.length > 0) {
      try {
        await withSpan(
          "buy_intent.stage_batch",
          {
            attributes: {
              "messaging.system": "postgres",
              "messaging.destination.name": "staged_buy_intent_command",
              "buy_intent.batch_size": stagedBatch.length,
            },
          },
          async () => {
            await postgresBuyIntentCommandGateway.stageBatch(
              stagedBatch.map((entry) => ({
                command: entry.command,
                traceCarrier: injectTraceCarrier(entry.parentContext),
              })),
            );
          },
          stagedBatch[0]?.parentContext,
        );
        for (const entry of stagedBatch) {
          await withSpan(
            "buy_intent.ingest_message",
            {
              attributes: {
                "messaging.system": "nats",
                "messaging.operation": "process",
                "messaging.destination.name": entry.message.subject,
                "buy_intent.command_id": entry.command.command_id,
                "buy_intent.correlation_id": entry.command.correlation_id,
              },
            },
            async () => {
              entry.message.ack();
            },
            entry.parentContext,
          );
          stagedCount += 1;
        }
      } catch (error) {
        for (const entry of stagedBatch) {
          try {
            entry.message.nak(retryDelayMs);
            retriedCount += 1;
          } catch (nakError) {
            console.error("buy_intent_command_bus_nak_failed", nakError);
          }
          await withSpan(
            "buy_intent.ingest_message",
            {
              attributes: {
                "messaging.system": "nats",
                "messaging.operation": "process",
                "messaging.destination.name": entry.message.subject,
                "buy_intent.command_id": entry.command.command_id,
                "buy_intent.correlation_id": entry.command.correlation_id,
              },
            },
            async (span) => {
              span.recordException(error instanceof Error ? error : new Error(String(error)));
            },
            entry.parentContext,
          );
        }
        console.error("buy_intent_command_bus_stage_batch_failed", error);
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

function isCodecError(error: unknown) {
  return error instanceof Error && /JSON|unexpected|invalid/i.test(error.message);
}

main().catch((error) => {
  console.error("buy_intent_command_bus_ingest_failed", error);
  process.exitCode = 1;
});
