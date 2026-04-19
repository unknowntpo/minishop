"use client";

import Link from "next/link";

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
  const { locale, messages } = useBuyerLocale();

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

        <div className="completion-grid">
          <span className="completion-metric">
            <strong>{messages.completion.metrics.status}</strong>
            <code>{checkout.status}</code>
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
