export type RequestInventoryReservationCommand = {
  checkout_intent_id: string;
  reservation_id: string;
  sku_id: string;
  quantity: number;
};

export type ReserveInventoryCommand = {
  checkout_intent_id: string;
  reservation_id: string;
  sku_id: string;
  quantity: number;
};

export type ReleaseInventoryReservationCommand = {
  checkout_intent_id: string;
  reservation_id: string;
  sku_id: string;
  quantity: number;
  reason: string;
};
