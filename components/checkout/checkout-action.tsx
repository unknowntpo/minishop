"use client";

import { useEffect, useState } from "react";

import type { Product } from "@/src/domain/catalog/product";

type CheckoutStatusResponse = {
  checkoutIntentId: string;
  status: string;
  lastEventId: number;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
};

type CheckoutActionState =
  | {
      phase: "idle";
    }
  | {
      phase: "submitting" | "projecting" | "polling";
      checkoutIntentId?: string;
      message: string;
    }
  | {
      phase: "ready";
      checkoutIntentId: string;
      status: string;
      message: string;
    }
  | {
      phase: "error";
      message: string;
    };

export function CheckoutAction({ product }: { product: Product }) {
  const [state, setState] = useState<CheckoutActionState>({ phase: "idle" });
  const [checkoutIntentId, setCheckoutIntentId] = useState<string | null>(null);

  useEffect(() => {
    if (!checkoutIntentId) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/checkout-intents/${checkoutIntentId}`, {
          cache: "no-store",
        });

        if (!response.ok) {
          return;
        }

        const body = (await response.json()) as CheckoutStatusResponse;

        if (!cancelled) {
          setState({
            phase: "ready",
            checkoutIntentId,
            status: body.status,
            message: statusMessage(body),
          });
        }
      } catch {
        // Keep polling; transient read failures are expected while projections catch up.
      }
    }, 1200);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [checkoutIntentId]);

  async function buy() {
    setState({
      phase: "submitting",
      message: "Submitting checkout intent.",
    });

    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch("/api/checkout-intents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          buyerId: "demo_buyer",
          items: [
            {
              skuId: product.skuId,
              quantity: 1,
              unitPriceAmountMinor: product.priceAmountMinor,
              currency: product.currency,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const body = (await response.json()) as { checkoutIntentId: string };
      setCheckoutIntentId(body.checkoutIntentId);
      setState({
        phase: "projecting",
        checkoutIntentId: body.checkoutIntentId,
        message: "Checkout accepted. Refreshing projections.",
      });

      await fetch("/api/internal/projections/process", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectionName: "main",
          batchSize: 100,
        }),
      });

      setState({
        phase: "polling",
        checkoutIntentId: body.checkoutIntentId,
        message: "Projection refresh requested. Polling checkout status.",
      });
    } catch (error) {
      console.error("checkout_action_failed", error);
      setState({
        phase: "error",
        message: "Checkout request could not be accepted. Please try again.",
      });
    }
  }

  const disabled = state.phase === "submitting" || state.phase === "projecting";

  return (
    <div className="checkout-demo">
      <button className="button primary" type="button" disabled={disabled} onClick={buy}>
        {disabled ? "Working" : "Buy"}
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

function statusMessage(body: CheckoutStatusResponse) {
  if (body.status === "queued") {
    return `Checkout ${body.checkoutIntentId} is queued. Reservation processing is next.`;
  }

  if (body.status === "rejected") {
    return body.rejectionReason ?? "Checkout was rejected.";
  }

  if (body.status === "cancelled") {
    return body.cancellationReason ?? "Checkout was cancelled.";
  }

  return `Checkout ${body.checkoutIntentId} status: ${body.status}.`;
}

async function readError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    requestId?: string;
  } | null;
  const message = body?.error ?? `Request failed with ${response.status}.`;

  return body?.requestId ? `${message} Reference: ${body.requestId}` : message;
}
