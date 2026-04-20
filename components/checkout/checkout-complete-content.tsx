"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { BuyerDevMenu } from "@/components/buyer/buyer-dev-menu";
import { BuyerLocaleProvider, useBuyerLocale } from "@/components/buyer/buyer-locale-provider";
import { BuyerProfileMenu } from "@/components/buyer/buyer-profile-menu";
import {
  type BuyerLocale,
  formatBuyerDateTime,
  normalizeBuyerLocale,
} from "@/src/presentation/i18n/buyer-localization";

type CheckoutCompleteContentProps = {
  checkout: {
    cancellationReason: string | null;
    checkoutIntentId: string;
    commandId: string | null;
    commandStatus: string | null;
    orderId: string | null;
    paymentId: string | null;
    rejectionReason: string | null;
    status: string;
    updatedAt: string;
  };
  initialLocale?: BuyerLocale;
};

export function CheckoutCompleteContent({ checkout, initialLocale }: CheckoutCompleteContentProps) {
  return (
    <BuyerLocaleProvider initialLocale={normalizeBuyerLocale(initialLocale)}>
      <CheckoutCompleteBody checkout={checkout} />
    </BuyerLocaleProvider>
  );
}

function CheckoutCompleteBody({ checkout }: Omit<CheckoutCompleteContentProps, "initialLocale">) {
  const router = useRouter();
  const { locale, messages } = useBuyerLocale();
  const [paymentState, setPaymentState] = useState<"idle" | "submitting" | "error">("idle");
  const [paymentError, setPaymentError] = useState<string | null>(null);

  async function submitPaymentOutcome(outcome: "succeeded" | "failed") {
    if (!checkout.commandId) {
      setPaymentError(messages.completion.paymentActionUnavailable);
      setPaymentState("error");
      return;
    }

    setPaymentState("submitting");
    setPaymentError(null);

    try {
      const response = await fetch(
        `/api/internal/buy-intent-commands/${checkout.commandId}/payment-demo`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ outcome }),
        },
      );

      if (!response.ok) {
        throw new Error(messages.completion.paymentActionFailed);
      }

      await waitForCheckoutResolution(checkout.checkoutIntentId);
      router.refresh();
      router.push(`/checkout-complete/${checkout.checkoutIntentId}`);
    } catch (error) {
      setPaymentState("error");
      setPaymentError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : messages.completion.paymentActionFailed,
      );
      return;
    }

    setPaymentState("idle");
  }

  return (
    <main className="page-shell checkout-complete-shell">
      <div className="buyer-toolbar">
        <Link className="text-link" href="/products">
          {messages.navProducts}
        </Link>
        <div className="buyer-toolbar-actions">
          <BuyerDevMenu />
          <BuyerProfileMenu />
        </div>
      </div>

      <section className="panel checkout-complete-panel">
        <p className="eyebrow">{messages.completion.eyebrow}</p>
        <h1>
          {checkout.status === "confirmed"
            ? messages.completion.completeTitle
            : messages.completion.receivedTitle}
        </h1>
        <p className="muted">
          {messages.completion.subtitle(checkout.checkoutIntentId, checkout.status)}
        </p>
        {checkout.status === "queued" ? (
          <p className="muted">{messages.completion.queuedHelp(checkout.commandStatus)}</p>
        ) : null}
        {checkout.status === "pending_payment" ? (
          <>
            <p className="muted">{messages.completion.pendingPaymentHelp}</p>
            <div className="buyer-toolbar-actions">
              <button
                className="button primary"
                type="button"
                disabled={paymentState === "submitting"}
                onClick={() => void submitPaymentOutcome("succeeded")}
              >
                {messages.completion.actions.payNow}
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={paymentState === "submitting"}
                onClick={() => void submitPaymentOutcome("failed")}
              >
                {messages.completion.actions.failPayment}
              </button>
            </div>
            {paymentError ? <p className="checkout-demo-status error">{paymentError}</p> : null}
          </>
        ) : null}

        <div className="completion-grid">
          <span className="completion-metric">
            <strong>{messages.completion.metrics.status}</strong>
            <code>{checkout.status}</code>
          </span>
          <span className="completion-metric">
            <strong>{messages.completion.metrics.command}</strong>
            <code>{checkout.commandId ?? messages.completion.notAvailable}</code>
          </span>
          <span className="completion-metric">
            <strong>{messages.completion.metrics.commandStatus}</strong>
            <code>{checkout.commandStatus ?? messages.completion.notAvailable}</code>
          </span>
          <span className="completion-metric">
            <strong>{messages.completion.metrics.order}</strong>
            <code>{checkout.orderId ?? messages.completion.notAvailable}</code>
          </span>
          <span className="completion-metric">
            <strong>{messages.completion.metrics.payment}</strong>
            <code>{checkout.paymentId ?? messages.completion.notAvailable}</code>
          </span>
          <span className="completion-metric">
            <strong>{messages.completion.metrics.updated}</strong>
            <code>{formatBuyerDateTime(checkout.updatedAt, locale)}</code>
          </span>
        </div>

        {checkout.rejectionReason || checkout.cancellationReason ? (
          <p className="checkout-demo-status error">
            {checkout.rejectionReason ?? checkout.cancellationReason}
          </p>
        ) : null}
      </section>
    </main>
  );
}

async function waitForCheckoutResolution(checkoutIntentId: string) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const response = await fetch(`/api/checkout-intents/${checkoutIntentId}`, {
      cache: "no-store",
    });

    if (response.ok) {
      const body = (await response.json()) as { status: string };
      if (body.status !== "pending_payment" && body.status !== "reserving") {
        return;
      }
    }

    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
}
