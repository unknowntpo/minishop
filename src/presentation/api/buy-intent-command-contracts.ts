import {
  isNonEmptyString,
  isRecord,
  isUuid,
  optionalNonEmptyString,
} from "@/src/domain/schema-rules";
import type { CreateCheckoutIntentRequest } from "@/src/presentation/api/checkout-intent-contracts";
import { parseCreateCheckoutIntentRequest } from "@/src/presentation/api/checkout-intent-contracts";

export type AcceptBuyIntentRequest = CreateCheckoutIntentRequest;

export type AcceptBuyIntentResponse = {
  commandId: string;
  correlationId: string;
  status: "accepted";
};

export type BuyIntentCommandStatusResponse = {
  commandId: string;
  correlationId: string;
  status: "accepted" | "processing" | "created" | "failed";
  checkoutIntentId: string | null;
  eventId: string | null;
  isDuplicate: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseAcceptBuyIntentRequest(value: unknown): AcceptBuyIntentRequest {
  return parseCreateCheckoutIntentRequest(value);
}

export function isBuyIntentCommandStatusResponse(
  value: unknown,
): value is BuyIntentCommandStatusResponse {
  return (
    isRecord(value) &&
    isUuid(value.commandId) &&
    isUuid(value.correlationId) &&
    ["accepted", "processing", "created", "failed"].includes(String(value.status)) &&
    (value.checkoutIntentId === null || isUuid(value.checkoutIntentId)) &&
    (value.eventId === null || isUuid(value.eventId)) &&
    typeof value.isDuplicate === "boolean" &&
    optionalNonEmptyString(value.failureCode) &&
    optionalNonEmptyString(value.failureMessage) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt)
  );
}
