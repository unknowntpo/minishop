import { describe, expect, it } from "vitest";

import {
  isCheckoutItemJson,
  isCurrencyCode,
  isEventMetadataJson,
  isReservationIdentityPayload,
  isStableTextIdentifier,
  isUuid,
} from "@/src/domain/schema-rules";

describe("schema rules", () => {
  it("validates durable UUID identifiers separately from stable catalog text identifiers", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isUuid("checkout_1")).toBe(false);

    expect(isStableTextIdentifier("sku_hot_001")).toBe(true);
    expect(isStableTextIdentifier("SKU HOT 001")).toBe(false);
  });

  it("validates checkout item JSON shape and money minor units", () => {
    expect(
      isCheckoutItemJson({
        sku_id: "sku_hot_001",
        quantity: 1,
        unit_price_amount_minor: 100000,
        currency: "TWD",
      }),
    ).toBe(true);

    expect(
      isCheckoutItemJson({
        sku_id: "sku_hot_001",
        quantity: 1.5,
        unit_price_amount_minor: 100000,
        currency: "TWD",
      }),
    ).toBe(false);

    expect(isCurrencyCode("TWD")).toBe(true);
    expect(isCurrencyCode("twd")).toBe(false);
  });

  it("validates event metadata and reservation identity payloads", () => {
    expect(
      isEventMetadataJson({
        request_id: "req_123",
        trace_id: "trace_123",
        source: "web",
        actor_id: "buyer_1",
        command_id: "00000000-0000-4000-8000-000000000010",
        correlation_id: "00000000-0000-4000-8000-000000000011",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        tracestate: "vendor=value",
        baggage: "tenant=minishop",
      }),
    ).toBe(true);

    expect(
      isReservationIdentityPayload({
        checkout_intent_id: "00000000-0000-4000-8000-000000000001",
        reservation_id: "00000000-0000-4000-8000-000000000002",
        sku_id: "sku_hot_001",
        quantity: 1,
      }),
    ).toBe(true);
  });
});
