export type RequestPaymentCommand = {
  payment_id: string;
  checkout_intent_id: string;
  amount: number;
  idempotency_key: string;
};

export type RecordPaymentSucceededCommand = {
  payment_id: string;
  checkout_intent_id: string;
  provider_reference: string;
};

export type RecordPaymentFailedCommand = {
  payment_id: string;
  checkout_intent_id: string;
  reason: string;
};
