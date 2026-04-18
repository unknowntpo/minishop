import type { Product } from "@/src/domain/catalog/product";

export function formatProductPrice(product: Product) {
  const majorUnits = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(product.priceAmountMinor / 100);

  return `${product.currency} ${majorUnits}`;
}
