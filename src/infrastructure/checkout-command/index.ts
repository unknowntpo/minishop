import { getPool } from "@/db/client";
import { createNatsBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/nats-buy-intent-command-bus";
import { createNoopBuyIntentCommandOrchestrator } from "@/src/infrastructure/checkout-command/noop-buy-intent-command-orchestrator";
import { createPostgresBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-bus";
import { createPostgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-gateway";
import { createRoutingBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/routing-buy-intent-command-bus";
import { createKafkaSeckillCommandBus } from "@/src/infrastructure/seckill/kafka-seckill-command-bus";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";
import type {
  BuyIntentCommandGateway,
  BuyIntentCommandStatusView,
  StagedBuyIntentCommand,
} from "@/src/ports/buy-intent-command-gateway";
import type { BuyIntentCommandOrchestrator } from "@/src/ports/buy-intent-command-orchestrator";

let sharedGateway: BuyIntentCommandGateway | null = null;
let sharedPostgresBus: BuyIntentCommandBus | null = null;
let sharedBus: BuyIntentCommandBus | null = null;
let sharedOrchestrator: BuyIntentCommandOrchestrator | null = null;

function readRuntimeEnv(name: string) {
  const value = globalThis.process?.env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function getPostgresGateway() {
  sharedGateway ??= createPostgresBuyIntentCommandGateway(getPool());
  return sharedGateway;
}

function getPostgresBus() {
  sharedPostgresBus ??= createPostgresBuyIntentCommandBus(getPool());
  return sharedPostgresBus;
}

function getRuntimeCommandBus() {
  if (sharedBus) {
    return sharedBus;
  }

  const natsUrl = readRuntimeEnv("NATS_URL");
  const kafkaBrokers = readRuntimeEnv("KAFKA_BROKERS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const defaultBus = natsUrl
    ? createNatsBuyIntentCommandBus({
        servers: natsUrl,
        streamName: readRuntimeEnv("NATS_BUY_INTENT_STREAM") || "BUY_INTENT_COMMANDS",
        subject: readRuntimeEnv("NATS_BUY_INTENT_SUBJECT") || "buy-intent.command",
        retrySubject: readRuntimeEnv("NATS_BUY_INTENT_RETRY_SUBJECT") || "buy-intent.retry",
        dlqSubject: readRuntimeEnv("NATS_BUY_INTENT_DLQ_SUBJECT") || "buy-intent.dlq",
      })
    : getPostgresBus();

  sharedBus =
    kafkaBrokers.length > 0
        ? createRoutingBuyIntentCommandBus({
          defaultBus,
          seckillBus: createKafkaSeckillCommandBus({
            brokers: kafkaBrokers,
            requestTopic:
              readRuntimeEnv("KAFKA_SECKILL_REQUEST_TOPIC") || "inventory.seckill.requested",
            resultTopic:
              readRuntimeEnv("KAFKA_SECKILL_RESULT_TOPIC") || "inventory.seckill.result",
            batchSize: Number.parseInt(
              readRuntimeEnv("KAFKA_SECKILL_PUBLISH_BATCH_SIZE") || "64",
              10,
            ),
            lingerMs: Number.parseInt(
              readRuntimeEnv("KAFKA_SECKILL_PUBLISH_LINGER_MS") || "2",
              10,
            ),
            clientId: readRuntimeEnv("KAFKA_CLIENT_ID") || "minishop-app",
          }),
          pool: getPool(),
          bucketCount: Number.parseInt(
            readRuntimeEnv("KAFKA_SECKILL_BUCKET_COUNT") || "16",
            10,
          ),
          maxProbe: Number.parseInt(
            readRuntimeEnv("KAFKA_SECKILL_MAX_PROBE") || "4",
            10,
          ),
        })
      : defaultBus;

  return sharedBus;
}

function getRuntimeOrchestrator() {
  if (sharedOrchestrator) {
    return sharedOrchestrator;
  }

  sharedOrchestrator = createNoopBuyIntentCommandOrchestrator();
  return sharedOrchestrator;
}

export const postgresBuyIntentCommandGateway: BuyIntentCommandGateway = {
  readStatus(commandId): Promise<BuyIntentCommandStatusView | null> {
    return getPostgresGateway().readStatus(commandId);
  },
  readStatuses(commandIds): Promise<BuyIntentCommandStatusView[]> {
    return getPostgresGateway().readStatuses(commandIds);
  },
  stage(input): Promise<void> {
    return getPostgresGateway().stage(input);
  },
  stageBatch(inputs): Promise<void> {
    return getPostgresGateway().stageBatch(inputs);
  },
  ensureAcceptedBatch(commands): Promise<void> {
    return getPostgresGateway().ensureAcceptedBatch(commands);
  },
  claimPendingBatch(input): Promise<StagedBuyIntentCommand[]> {
    return getPostgresGateway().claimPendingBatch(input);
  },
  markProcessing(commandId): Promise<void> {
    return getPostgresGateway().markProcessing(commandId);
  },
  markProcessingBatch(commandIds): Promise<void> {
    return getPostgresGateway().markProcessingBatch(commandIds);
  },
  markPublishFailed(input): Promise<void> {
    return getPostgresGateway().markPublishFailed(input);
  },
  markCreated(input): Promise<void> {
    return getPostgresGateway().markCreated(input);
  },
  markCreatedBatch(inputs): Promise<void> {
    return getPostgresGateway().markCreatedBatch(inputs);
  },
  markFailed(input): Promise<void> {
    return getPostgresGateway().markFailed(input);
  },
  markFailedBatch(inputs): Promise<void> {
    return getPostgresGateway().markFailedBatch(inputs);
  },
  markMergedDuplicateCommand(input): Promise<void> {
    return getPostgresGateway().markMergedDuplicateCommand(input);
  },
  markMergedDuplicateCommands(inputs): Promise<void> {
    return getPostgresGateway().markMergedDuplicateCommands(inputs);
  },
};

export const postgresBuyIntentCommandBus: BuyIntentCommandBus = {
  publish(command): Promise<void> {
    return getPostgresBus().publish(command);
  },
};

export const buyIntentCommandBus: BuyIntentCommandBus = {
  publish(command): Promise<void> {
    return getRuntimeCommandBus().publish(command);
  },
};

export const buyIntentCommandOrchestrator: BuyIntentCommandOrchestrator = {
  start(command): Promise<void> {
    return getRuntimeOrchestrator().start(command);
  },
  markProcessing(commandId): Promise<void> {
    return getRuntimeOrchestrator().markProcessing(commandId);
  },
  markCreated(input): Promise<void> {
    return getRuntimeOrchestrator().markCreated(input);
  },
  markFailed(input): Promise<void> {
    return getRuntimeOrchestrator().markFailed(input);
  },
};
