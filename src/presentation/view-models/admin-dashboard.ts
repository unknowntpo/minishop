export type AdminProductView = {
  productId: string;
  productName: string;
  productStatus: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  skuStatus: string;
  priceAmountMinor: number;
  currency: string;
  onHand: number | null;
  reserved: number | null;
  sold: number | null;
  available: number | null;
  inventoryLastEventId: number | null;
  inventoryAggregateVersion: number | null;
};

export type AdminCheckoutView = {
  checkoutIntentId: string;
  buyerId: string;
  status: string;
  paymentId: string | null;
  orderId: string | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  aggregateVersion: number;
  lastEventId: number;
  updatedAt: string;
};

export type AdminCheckpointView = {
  projectionName: string;
  lastEventId: number;
  updatedAt: string;
};

export type AdminDashboardViewModel = {
  products: AdminProductView[];
  checkouts: AdminCheckoutView[];
  checkpoints: AdminCheckpointView[];
};
