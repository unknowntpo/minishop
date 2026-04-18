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
  image: {
    src: string;
    alt: string;
  };
};
