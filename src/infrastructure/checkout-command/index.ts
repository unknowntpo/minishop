import { getPool } from "@/db/client";
import { createNatsBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/nats-buy-intent-command-bus";
import { createNoopBuyIntentCommandOrchestrator } from "@/src/infrastructure/checkout-command/noop-buy-intent-command-orchestrator";
import { createPostgresBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-bus";
import { createPostgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-gateway";
import { createTemporalBuyIntentCommandOrchestrator } from "@/src/infrastructure/checkout-command/temporal-buy-intent-command-orchestrator";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";
import type {
  AcceptedBuyIntentCommand,
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

  sharedBus = natsUrl
    ? createNatsBuyIntentCommandBus({
        servers: natsUrl,
        streamName: readRuntimeEnv("NATS_BUY_INTENT_STREAM") || "BUY_INTENT_COMMANDS",
        subject: readRuntimeEnv("NATS_BUY_INTENT_SUBJECT") || "buy-intent.command",
        retrySubject: readRuntimeEnv("NATS_BUY_INTENT_RETRY_SUBJECT") || "buy-intent.retry",
        dlqSubject: readRuntimeEnv("NATS_BUY_INTENT_DLQ_SUBJECT") || "buy-intent.dlq",
      })
    : getPostgresBus();

  return sharedBus;
}

function getRuntimeOrchestrator() {
  if (sharedOrchestrator) {
    return sharedOrchestrator;
  }

  const temporalAddress = readRuntimeEnv("TEMPORAL_ADDRESS");

  sharedOrchestrator = temporalAddress
    ? createTemporalBuyIntentCommandOrchestrator({
        address: temporalAddress,
        namespace: readRuntimeEnv("TEMPORAL_NAMESPACE") || undefined,
        taskQueue: readRuntimeEnv("TEMPORAL_BUY_INTENT_TASK_QUEUE") || undefined,
      })
    : createNoopBuyIntentCommandOrchestrator();

  return sharedOrchestrator;
}

export const postgresBuyIntentCommandGateway: BuyIntentCommandGateway = {
  createAccepted(command): Promise<AcceptedBuyIntentCommand> {
    return getPostgresGateway().createAccepted(command);
  },
  readStatus(commandId): Promise<BuyIntentCommandStatusView | null> {
    return getPostgresGateway().readStatus(commandId);
  },
  stage(command): Promise<void> {
    return getPostgresGateway().stage(command);
  },
  claimPendingBatch(input): Promise<StagedBuyIntentCommand[]> {
    return getPostgresGateway().claimPendingBatch(input);
  },
  markProcessing(commandId): Promise<void> {
    return getPostgresGateway().markProcessing(commandId);
  },
  markPublishFailed(input): Promise<void> {
    return getPostgresGateway().markPublishFailed(input);
  },
  markCreated(input): Promise<void> {
    return getPostgresGateway().markCreated(input);
  },
  markFailed(input): Promise<void> {
    return getPostgresGateway().markFailed(input);
  },
  markMergedDuplicateCommand(input): Promise<void> {
    return getPostgresGateway().markMergedDuplicateCommand(input);
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
