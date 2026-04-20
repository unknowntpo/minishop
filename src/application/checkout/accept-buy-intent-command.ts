import { assertCheckoutItems } from "@/src/domain/checkout/item";
import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import { isEventMetadata } from "@/src/domain/events/event-metadata";
import type { Clock } from "@/src/ports/clock";
import type { BuyIntentCommandBus } from "@/src/ports/buy-intent-command-bus";
import type { IdGenerator } from "@/src/ports/id-generator";

export type AcceptBuyIntentCommandDeps = {
  bus: BuyIntentCommandBus;
  idGenerator: IdGenerator;
  clock: Clock;
};

export async function acceptBuyIntentCommand(
  input: {
    buyer_id: string;
    items: BuyIntentCommand["items"];
    idempotency_key?: string;
    metadata: BuyIntentCommand["metadata"];
  },
  deps: AcceptBuyIntentCommandDeps,
) {
  validateInput(input);

  const command = {
    command_id: deps.idGenerator.randomUuid(),
    correlation_id: deps.idGenerator.randomUuid(),
    buyer_id: input.buyer_id,
    items: input.items,
    ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
    metadata: input.metadata,
    issued_at: deps.clock.now().toISOString(),
  } satisfies BuyIntentCommand;

  await deps.bus.publish(command);

  return {
    commandId: command.command_id,
    correlationId: command.correlation_id,
    status: "accepted" as const,
  };
}

function validateInput(input: {
  buyer_id: string;
  items: BuyIntentCommand["items"];
  idempotency_key?: string;
  metadata: BuyIntentCommand["metadata"];
}) {
  if (typeof input.buyer_id !== "string" || input.buyer_id.trim().length === 0) {
    throw new Error("buyer_id is required.");
  }

  if (input.idempotency_key !== undefined && input.idempotency_key.trim().length === 0) {
    throw new Error("idempotency_key must be non-empty when provided.");
  }

  assertCheckoutItems(input.items);

  if (!isEventMetadata(input.metadata)) {
    throw new Error("valid event metadata is required.");
  }
}
