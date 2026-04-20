import { getPool } from "@/db/client";
import { createNatsBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/nats-buy-intent-command-bus";
import { createNoopBuyIntentCommandOrchestrator } from "@/src/infrastructure/checkout-command/noop-buy-intent-command-orchestrator";
import { createPostgresBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-bus";
import { createPostgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-gateway";
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

  sharedBus = process.env.NATS_URL?.trim()
    ? createNatsBuyIntentCommandBus({
        servers: process.env.NATS_URL,
        streamName: process.env.NATS_BUY_INTENT_STREAM?.trim() || "BUY_INTENT_COMMANDS",
        subject: process.env.NATS_BUY_INTENT_SUBJECT?.trim() || "buy-intent.command",
        retrySubject: process.env.NATS_BUY_INTENT_RETRY_SUBJECT?.trim() || "buy-intent.retry",
        dlqSubject: process.env.NATS_BUY_INTENT_DLQ_SUBJECT?.trim() || "buy-intent.dlq",
      })
    : getPostgresBus();

  return sharedBus;
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

export const buyIntentCommandOrchestrator: BuyIntentCommandOrchestrator =
  createNoopBuyIntentCommandOrchestrator();
