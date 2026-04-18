import type { CreateCheckoutIntentCommand } from "@/src/domain/checkout/commands";
import { assertCheckoutItems } from "@/src/domain/checkout/item";
import type { CheckoutIntentCreated } from "@/src/domain/events/domain-event";
import { isEventMetadata } from "@/src/domain/events/event-metadata";
import type { Clock } from "@/src/ports/clock";
import type { EventStore } from "@/src/ports/event-store";
import type { IdGenerator } from "@/src/ports/id-generator";

export type CreateCheckoutIntentDeps = {
  eventStore: EventStore;
  idGenerator: IdGenerator;
  clock: Clock;
};

export type CreateCheckoutIntentResult = {
  checkoutIntentId: string;
  eventId: string;
  status: "queued";
  idempotentReplay: boolean;
};

export async function createCheckoutIntent(
  command: CreateCheckoutIntentCommand,
  deps: CreateCheckoutIntentDeps,
): Promise<CreateCheckoutIntentResult> {
  validateCreateCheckoutIntentCommand(command);

  const checkoutIntentId = deps.idGenerator.randomUuid();
  const eventId = deps.idGenerator.randomUuid();
  const event: CheckoutIntentCreated = {
    type: "CheckoutIntentCreated",
    version: 1,
    payload: {
      checkout_intent_id: checkoutIntentId,
      buyer_id: command.buyer_id,
      items: command.items,
      ...(command.idempotency_key ? { idempotency_key: command.idempotency_key } : {}),
    },
  };

  const stored = await deps.eventStore.append({
    eventId,
    event,
    aggregateType: "checkout",
    aggregateId: checkoutIntentId,
    aggregateVersion: 1,
    metadata: command.metadata,
    idempotencyKey: command.idempotency_key,
    occurredAt: deps.clock.now(),
  });

  if (stored.event.type !== "CheckoutIntentCreated") {
    throw new Error("Idempotency key resolved to a non-checkout event.");
  }

  return {
    checkoutIntentId: stored.event.payload.checkout_intent_id,
    eventId: stored.eventId,
    status: "queued",
    idempotentReplay: stored.wasIdempotentReplay,
  };
}

function validateCreateCheckoutIntentCommand(command: CreateCheckoutIntentCommand) {
  if (!isNonEmptyString(command.buyer_id)) {
    throw new Error("buyer_id is required.");
  }

  if (command.idempotency_key !== undefined && !isNonEmptyString(command.idempotency_key)) {
    throw new Error("idempotency_key must be non-empty when provided.");
  }

  assertCheckoutItems(command.items);

  if (!isEventMetadata(command.metadata)) {
    throw new Error("valid event metadata is required.");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
