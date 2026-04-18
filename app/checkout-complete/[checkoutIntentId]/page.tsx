import Link from "next/link";
import { notFound } from "next/navigation";

import { getPool } from "@/db/client";

type CheckoutCompletePageProps = {
  params: Promise<{
    checkoutIntentId: string;
  }>;
};

type CheckoutRow = {
  checkout_intent_id: string;
  buyer_id: string;
  status: string;
  items: unknown;
  order_id: string | null;
  payment_id: string | null;
  rejection_reason: string | null;
  cancellation_reason: string | null;
  updated_at: Date;
};

export const dynamic = "force-dynamic";

export default async function CheckoutCompletePage({ params }: CheckoutCompletePageProps) {
  const { checkoutIntentId } = await params;
  const result = await getPool().query<CheckoutRow>(
    `
      select
        checkout_intent_id,
        buyer_id,
        status,
        items,
        order_id,
        payment_id,
        rejection_reason,
        cancellation_reason,
        updated_at
      from checkout_intent_projection
      where checkout_intent_id = $1
      limit 1
    `,
    [checkoutIntentId],
  );
  const checkout = result.rows[0];

  if (!checkout) {
    notFound();
  }

  return (
    <main className="page-shell checkout-complete-shell">
      <Link className="text-link" href="/products">
        Products
      </Link>
      <section className="panel checkout-complete-panel">
        <p className="eyebrow">Checkout result</p>
        <h1>{checkout.status === "confirmed" ? "Checkout complete" : "Checkout received"}</h1>
        <p className="muted">
          Intent {checkout.checkout_intent_id} is {checkout.status}.
        </p>

        <div className="completion-grid">
          <span className="completion-metric">
            <strong>Status</strong>
            <code>{checkout.status}</code>
          </span>
          <span className="completion-metric">
            <strong>Order</strong>
            <code>{checkout.order_id ?? "n/a"}</code>
          </span>
          <span className="completion-metric">
            <strong>Payment</strong>
            <code>{checkout.payment_id ?? "n/a"}</code>
          </span>
          <span className="completion-metric">
            <strong>Updated</strong>
            <code>{checkout.updated_at.toISOString()}</code>
          </span>
        </div>

        {checkout.rejection_reason || checkout.cancellation_reason ? (
          <p className="checkout-demo-status error">
            {checkout.rejection_reason ?? checkout.cancellation_reason}
          </p>
        ) : null}
      </section>
    </main>
  );
}
