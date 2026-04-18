import type { CheckoutItem } from "@/src/domain/checkout/item";
import { type EventType, isEventType } from "@/src/domain/events/event-type";
import {
  isCheckoutItemJsonList,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  isReservationIdentityPayload,
  isStableTextIdentifier,
  isUuid,
  optionalNonEmptyString,
} from "@/src/domain/schema-rules";

type BaseDomainEvent<TType extends EventType, TPayload> = {
  type: TType;
  version: 1;
  payload: TPayload;
};

export type CheckoutIntentCreated = BaseDomainEvent<
  "CheckoutIntentCreated",
  {
    checkout_intent_id: string;
    buyer_id: string;
    items: CheckoutItem[];
    idempotency_key?: string;
  }
>;

export type InventoryReservationRequested = BaseDomainEvent<
  "InventoryReservationRequested",
  {
    checkout_intent_id: string;
    reservation_id: string;
    sku_id: string;
    quantity: number;
  }
>;

export type InventoryReserved = BaseDomainEvent<
  "InventoryReserved",
  {
    checkout_intent_id: string;
    reservation_id: string;
    sku_id: string;
    quantity: number;
    expires_at: string;
  }
>;

export type InventoryReservationRejected = BaseDomainEvent<
  "InventoryReservationRejected",
  {
    checkout_intent_id: string;
    reservation_id: string;
    sku_id: string;
    quantity: number;
    reason: string;
  }
>;

export type PaymentRequested = BaseDomainEvent<
  "PaymentRequested",
  {
    payment_id: string;
    checkout_intent_id: string;
    amount: number;
    idempotency_key: string;
  }
>;

export type PaymentSucceeded = BaseDomainEvent<
  "PaymentSucceeded",
  {
    payment_id: string;
    checkout_intent_id: string;
    provider_reference: string;
  }
>;

export type PaymentFailed = BaseDomainEvent<
  "PaymentFailed",
  {
    payment_id: string;
    checkout_intent_id: string;
    reason: string;
  }
>;

export type InventoryReservationReleased = BaseDomainEvent<
  "InventoryReservationReleased",
  {
    checkout_intent_id: string;
    reservation_id: string;
    sku_id: string;
    quantity: number;
    reason: string;
  }
>;

export type OrderConfirmed = BaseDomainEvent<
  "OrderConfirmed",
  {
    order_id: string;
    checkout_intent_id: string;
    buyer_id: string;
    items: CheckoutItem[];
    total_amount_minor: number;
  }
>;

export type OrderCancelled = BaseDomainEvent<
  "OrderCancelled",
  {
    order_id: string;
    checkout_intent_id: string;
    reason: string;
  }
>;

export type DomainEvent =
  | CheckoutIntentCreated
  | InventoryReservationRequested
  | InventoryReserved
  | InventoryReservationRejected
  | PaymentRequested
  | PaymentSucceeded
  | PaymentFailed
  | InventoryReservationReleased
  | OrderConfirmed
  | OrderCancelled;

export function isDomainEvent(value: unknown): value is DomainEvent {
  if (!isRecord(value) || !isEventType(value.type) || value.version !== 1) {
    return false;
  }

  if (!isRecord(value.payload)) {
    return false;
  }

  switch (value.type) {
    case "CheckoutIntentCreated":
      return (
        isUuid(value.payload.checkout_intent_id) &&
        isNonEmptyString(value.payload.buyer_id) &&
        isCheckoutItemJsonList(value.payload.items) &&
        optionalNonEmptyString(value.payload.idempotency_key)
      );
    case "InventoryReservationRequested":
      return isReservationPayload(value.payload);
    case "InventoryReserved":
      return isReservationPayload(value.payload) && isNonEmptyString(value.payload.expires_at);
    case "InventoryReservationRejected":
      return isReservationPayload(value.payload) && isNonEmptyString(value.payload.reason);
    case "PaymentRequested":
      return (
        isUuid(value.payload.payment_id) &&
        isUuid(value.payload.checkout_intent_id) &&
        isNonNegativeInteger(value.payload.amount) &&
        isNonEmptyString(value.payload.idempotency_key)
      );
    case "PaymentSucceeded":
      return (
        isUuid(value.payload.payment_id) &&
        isUuid(value.payload.checkout_intent_id) &&
        isNonEmptyString(value.payload.provider_reference)
      );
    case "PaymentFailed":
      return (
        isUuid(value.payload.payment_id) &&
        isUuid(value.payload.checkout_intent_id) &&
        isNonEmptyString(value.payload.reason)
      );
    case "InventoryReservationReleased":
      return isReservationPayload(value.payload) && isNonEmptyString(value.payload.reason);
    case "OrderConfirmed":
      return (
        isUuid(value.payload.order_id) &&
        isUuid(value.payload.checkout_intent_id) &&
        isNonEmptyString(value.payload.buyer_id) &&
        isCheckoutItemJsonList(value.payload.items) &&
        isNonNegativeInteger(value.payload.total_amount_minor)
      );
    case "OrderCancelled":
      return (
        isUuid(value.payload.order_id) &&
        isUuid(value.payload.checkout_intent_id) &&
        isNonEmptyString(value.payload.reason)
      );
  }
}

function isReservationPayload(value: Record<string, unknown>) {
  return isReservationIdentityPayload(value) && isStableTextIdentifier(value.sku_id);
}
