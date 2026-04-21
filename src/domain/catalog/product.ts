export type Product = {
  slug: string;
  name: string;
  skuId: string;
  skuCode: string;
  summary: string;
  checkoutNote: string;
  priceAmountMinor: number;
  currency: string;
  available: number;
  inventory?: {
    onHand: number;
    reserved: number;
    sold: number;
    available: number;
    aggregateVersion: number;
    lastEventId: number;
    updatedAt: string | null;
    projectionLagMs: number | null;
  };
  seckill?: {
    candidate: boolean;
    enabled: boolean;
    stockLimit: number | null;
    defaultStock: number | null;
  };
  image: {
    src: string;
    alt: string;
  };
};
