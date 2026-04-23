import { type NextRequest, NextResponse } from "next/server";
import { getPool } from "@/db/client";

import { acceptBuyIntentCommand } from "@/src/application/checkout/accept-buy-intent-command";
import {
  buyIntentCommandBus,
  classifyBuyIntentItemsForSeckill,
  MixedCartWithSeckillNotSupportedError,
} from "@/src/infrastructure/checkout-command";
import { systemClock } from "@/src/ports/clock";
import { cryptoIdGenerator } from "@/src/ports/id-generator";
import {
  type AcceptBuyIntentResponse,
  parseAcceptBuyIntentRequest,
} from "@/src/presentation/api/buy-intent-command-contracts";
import { toCheckoutItems } from "@/src/presentation/api/checkout-intent-contracts";
import {
  apiErrorBody,
  getRequestContext,
  logApiError,
} from "@/src/presentation/api/request-context";
import { deprecatedGoApiHeaders } from "@/src/presentation/api/deprecation";
import { injectTraceCarrier } from "@/src/infrastructure/telemetry/otel";

export async function POST(request: NextRequest) {
  const context = getRequestContext(request);

  try {
    const body = parseAcceptBuyIntentRequest(await request.json());
    const rawBody = JSON.stringify(body);
    const headerIdempotencyKey = request.headers.get("idempotency-key")?.trim();
    const idempotencyKey = headerIdempotencyKey || body.idempotencyKey;
    const seckillProxyResponse = await maybeProxySeckillBuyIntent({
      body,
      context,
      idempotencyKey,
      rawBody,
    });

    if (seckillProxyResponse) {
      return seckillProxyResponse;
    }

    const accepted = await acceptBuyIntentCommand(
      {
        buyer_id: body.buyerId,
        items: toCheckoutItems(body.items),
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        metadata: {
          request_id: context.requestId,
          trace_id: context.traceId,
          source: "web",
          actor_id: body.buyerId,
          ...injectTraceCarrier(),
        },
      },
      {
        bus: buyIntentCommandBus,
        idGenerator: cryptoIdGenerator,
        clock: systemClock,
      },
    );

    const response: AcceptBuyIntentResponse = {
      commandId: accepted.commandId,
      correlationId: accepted.correlationId,
      status: accepted.status,
    };

    return NextResponse.json(response, {
      status: 202,
      headers: {
        ...deprecatedGoApiHeaders("/api/buy-intents"),
        "x-request-id": context.requestId,
        "x-trace-id": context.traceId,
      },
    });
  } catch (error) {
    logApiError("buy_intent_accept_failed", context, error);

    if (error instanceof MixedCartWithSeckillNotSupportedError) {
      return NextResponse.json(apiErrorBody(error.message, context), {
        status: 400,
        headers: {
          ...deprecatedGoApiHeaders("/api/buy-intents"),
          "x-request-id": context.requestId,
          "x-trace-id": context.traceId,
        },
      });
    }

    return NextResponse.json(
      apiErrorBody("Buy intent command could not be accepted. Please try again.", context),
      {
        status: 500,
        headers: {
          ...deprecatedGoApiHeaders("/api/buy-intents"),
          "x-request-id": context.requestId,
          "x-trace-id": context.traceId,
        },
      },
    );
  }
}

async function maybeProxySeckillBuyIntent(input: {
  body: ReturnType<typeof parseAcceptBuyIntentRequest>;
  context: ReturnType<typeof getRequestContext>;
  idempotencyKey?: string;
  rawBody: string;
}) {
  const ingressUrl = readGoSeckillIngressUrl();

  if (!ingressUrl) {
    return null;
  }

  const routing = await classifyBuyIntentItemsForSeckill({
    items: toCheckoutItems(input.body.items),
    pool: getPool(),
    seckillSkuConfigTtlMs: readPositiveIntegerEnv("KAFKA_SECKILL_CONFIG_CACHE_TTL_MS", 60_000),
  });

  if (routing.kind !== "single_seckill") {
    return null;
  }

  try {
    const response = await fetch(`${ingressUrl}/api/buy-intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": input.context.requestId,
        "x-trace-id": input.context.traceId,
        ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
      },
      body: input.rawBody,
    });

    const text = await response.text();

    return new NextResponse(text, {
      status: response.status,
      headers: {
        ...deprecatedGoApiHeaders("/api/buy-intents"),
        "content-type": response.headers.get("content-type") ?? "application/json",
        "x-request-id": response.headers.get("x-request-id") ?? input.context.requestId,
        "x-trace-id": response.headers.get("x-trace-id") ?? input.context.traceId,
      },
    });
  } catch (error) {
    logApiError("buy_intent_proxy_to_go_failed", input.context, error);
    return null;
  }
}

function readGoSeckillIngressUrl() {
  if ((process.env.GO_SECKILL_INGRESS_PROXY_ENABLED ?? "0").trim() !== "1") {
    return "";
  }

  return (process.env.GO_SECKILL_INGRESS_INTERNAL_URL ?? "").trim().replace(/\/+$/, "");
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
