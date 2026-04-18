export type AdminProductRow = {
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

export type AdminCheckoutRow = {
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

export type AdminCheckoutStatusCount = {
  status: string;
  count: number;
};

export type AdminCheckoutSummary = {
  displayedLimit: number;
  totalCount: number;
  statusCounts: AdminCheckoutStatusCount[];
};

export type AdminCheckpointRow = {
  projectionName: string;
  lastEventId: number;
  updatedAt: string;
};

export type AdminDashboard = {
  products: AdminProductRow[];
  checkoutSummary: AdminCheckoutSummary;
  checkouts: AdminCheckoutRow[];
  checkpoints: AdminCheckpointRow[];
};

export type AdminDashboardRepository = {
  getDashboard(): Promise<AdminDashboard>;
};
