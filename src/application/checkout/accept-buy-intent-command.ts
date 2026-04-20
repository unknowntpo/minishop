import { assertCheckoutItems } from "@/src/domain/checkout/item";
import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import { isEventMetadata } from "@/src/domain/events/event-metadata";
import type { Clock } from "@/src/ports/clock";
import type { BuyIntentCommandGateway } from "@/src/ports/buy-intent-command-gateway";
import type { IdGenerator } from "@/src/ports/id-generator";

export type AcceptBuyIntentCommandDeps = {
  gateway: BuyIntentCommandGateway;
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

  return deps.gateway.accept({
    command_id: deps.idGenerator.randomUuid(),
    correlation_id: deps.idGenerator.randomUuid(),
    buyer_id: input.buyer_id,
    items: input.items,
    ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
    metadata: input.metadata,
    issued_at: deps.clock.now().toISOString(),
  });
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
