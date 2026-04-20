"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Product } from "@/src/domain/catalog/product";
import {
  type BuyerLocale,
  getBuyerMessages,
  normalizeBuyerLocale,
} from "@/src/presentation/i18n/buyer-localization";

export type CheckoutActionItem = {
  skuId: string;
  quantity: number;
  unitPriceAmountMinor: number;
  currency: string;
};

type CheckoutStatusResponse = {
  checkoutIntentId: string;
  status: string;
  lastEventId: number;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
};

type BuyIntentCommandStatusResponse = {
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

type CheckoutActionState =
  | {
      phase: "idle";
    }
  | {
      phase: "submitting" | "projecting" | "polling";
      commandId?: string;
      checkoutIntentId?: string;
      message: string;
    }
  | {
      phase: "ready" | "completed";
      commandId?: string;
      checkoutIntentId: string;
      status: string;
      message: string;
    }
  | {
      phase: "error";
      message: string;
    };

export function CheckoutAction({
  disabled: disabledProp = false,
  onCompleted,
  product,
  items,
  buttonLabel = "Buy",
  locale = "zh-TW",
}: {
  disabled?: boolean;
  onCompleted?: () => void;
  product: Product;
  items?: CheckoutActionItem[];
  buttonLabel?: string;
  locale?: BuyerLocale;
}) {
  const router = useRouter();
  const normalizedLocale = normalizeBuyerLocale(locale);
  const messages = getBuyerMessages(normalizedLocale);
  const [state, setState] = useState<CheckoutActionState>({ phase: "idle" });

  async function buy() {
    setState({
      phase: "submitting",
      message: messages.checkout.submitting,
    });

    try {
      const idempotencyKey = crypto.randomUUID();
      const checkoutItems = items ?? [
        {
          skuId: product.skuId,
          quantity: 1,
          unitPriceAmountMinor: product.priceAmountMinor,
          currency: product.currency,
        },
      ];
      const response = await fetch("/api/buy-intents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          buyerId: "demo_buyer",
          items: checkoutItems,
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const body = (await response.json()) as {
        commandId: string;
        correlationId: string;
        status: "accepted";
      };
      setState({
        phase: "polling",
        commandId: body.commandId,
        message: messages.checkout.accepted,
      });

      const commandStatus = await waitForBuyIntentCommandStatus(body.commandId);

      if (commandStatus.status === "failed") {
        throw new Error(
          commandStatus.failureMessage ??
            commandStatus.failureCode ??
            "Buy intent command failed.",
        );
      }

      if (!commandStatus.checkoutIntentId) {
        throw new Error("Buy intent command completed without a checkout intent ID.");
      }

      setState({
        phase: "projecting",
        commandId: commandStatus.commandId,
        checkoutIntentId: commandStatus.checkoutIntentId,
        message: messages.checkout.completing,
      });

      await processProjections();
      const completedStatus = await waitForCheckoutStatus(commandStatus.checkoutIntentId);

      setState({
        phase: "ready",
        commandId: commandStatus.commandId,
        checkoutIntentId: commandStatus.checkoutIntentId,
        status: completedStatus.status,
        message: statusMessage(completedStatus, normalizedLocale),
      });
      onCompleted?.();
      router.refresh();
      router.push(
        `/checkout-complete/${commandStatus.checkoutIntentId}?commandId=${encodeURIComponent(commandStatus.commandId)}`,
      );
    } catch (error) {
      console.error("checkout_action_failed", error);
      setState({
        phase: "error",
        message:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : messages.checkout.failed,
      });
    }
  }

  const disabled =
    disabledProp ||
    state.phase === "submitting" ||
    state.phase === "projecting" ||
    state.phase === "polling";
  const busy =
    state.phase === "submitting" ||
    state.phase === "projecting" ||
    state.phase === "polling";

  return (
    <div className="checkout-demo">
      <button className="button primary" type="button" disabled={disabled} onClick={buy}>
        {busy ? messages.actions.working : buttonLabel}
      </button>
      {state.phase !== "idle" ? (
        <div className={`checkout-demo-status ${state.phase}`}>
          {state.phase === "submitting" ||
          state.phase === "projecting" ||
          state.phase === "polling" ? (
            <span className="spinner small" aria-hidden="true" />
          ) : null}
          <span>{state.message}</span>
        </div>
      ) : null}
    </div>
  );
}

async function processProjections() {
  const response = await fetch("/api/internal/projections/process", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      projectionName: "main",
      batchSize: 100,
    }),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const body = (await response.json()) as {
    locked: boolean;
  };

  if (!body.locked) {
    throw new Error("Projection processing is busy. Please try again.");
  }
}

async function waitForCheckoutStatus(checkoutIntentId: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await processProjections();

    const response = await fetch(`/api/checkout-intents/${checkoutIntentId}`, {
      cache: "no-store",
    });

    if (response.ok) {
      const body = (await response.json()) as CheckoutStatusResponse;
      return body;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }

  throw new Error("Checkout intent projection did not become available in time.");
}

async function waitForBuyIntentCommandStatus(commandId: string) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const response = await fetch(`/api/buy-intent-commands/${commandId}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const body = (await response.json()) as BuyIntentCommandStatusResponse;

    if (body.status === "created" || body.status === "failed") {
      return body;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }

  throw new Error("Buy intent command did not complete in time.");
}

function statusMessage(body: CheckoutStatusResponse, locale: BuyerLocale) {
  const messages = getBuyerMessages(locale);

  if (body.status === "queued") {
    return messages.checkout.queued(body.checkoutIntentId);
  }

  if (body.status === "rejected") {
    return body.rejectionReason ?? messages.checkout.rejected;
  }

  if (body.status === "cancelled") {
    return body.cancellationReason ?? messages.checkout.cancelled;
  }

  return messages.checkout.status(body.checkoutIntentId, body.status);
}

async function readError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    requestId?: string;
  } | null;
  const message = body?.error ?? `Request failed with ${response.status}.`;

  return body?.requestId ? `${message} Reference: ${body.requestId}` : message;
}
