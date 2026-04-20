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
  searchParams: Promise<{
    commandId?: string | string[];
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

type CommandStatusLookupRow = {
  command_id: string;
  status: string;
};

export const dynamic = "force-dynamic";

export default async function CheckoutCompletePage({
  params,
  searchParams,
}: CheckoutCompletePageProps) {
  const { checkoutIntentId } = await params;
  const resolvedSearchParams = await searchParams;
  const initialLocale = normalizeBuyerLocale((await cookies()).get(buyerLocaleCookieName)?.value);
  const pool = getPool();
  const result = await pool.query<CheckoutRow>(
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

  const commandStatusResult = await pool.query<CommandStatusLookupRow>(
    `
      select command_id
        , status
      from command_status
      where checkout_intent_id = $1
      order by updated_at desc
      limit 1
    `,
    [checkoutIntentId],
  );

  const commandId =
    commandStatusResult.rows[0]?.command_id ??
    readSingleSearchParam(resolvedSearchParams.commandId);
  const commandStatus = commandStatusResult.rows[0]?.status ?? null;

  return (
    <CheckoutCompleteContent
      checkout={{
        cancellationReason: checkout.cancellation_reason,
        checkoutIntentId: checkout.checkout_intent_id,
        commandId,
        commandStatus,
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

function readSingleSearchParam(value: string | string[] | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
