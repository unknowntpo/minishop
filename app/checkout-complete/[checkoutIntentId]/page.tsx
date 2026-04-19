import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { CheckoutCompleteContent } from "@/components/checkout/checkout-complete-content";
import { getPool } from "@/db/client";
import {
  buyerLocaleCookieName,
  normalizeBuyerLocale,
} from "@/src/presentation/i18n/buyer-localization";

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
  const initialLocale = normalizeBuyerLocale((await cookies()).get(buyerLocaleCookieName)?.value);
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
    <CheckoutCompleteContent
      checkout={{
        cancellationReason: checkout.cancellation_reason,
        checkoutIntentId: checkout.checkout_intent_id,
        orderId: checkout.order_id,
        paymentId: checkout.payment_id,
        rejectionReason: checkout.rejection_reason,
        status: checkout.status,
        updatedAt: checkout.updated_at.toISOString(),
      }}
      initialLocale={initialLocale}
    />
  );
}
