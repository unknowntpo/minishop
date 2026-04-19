import type { Product } from "@/src/domain/catalog/product";
import type { BuyerLocale } from "@/src/presentation/i18n/buyer-localization";

import { ProductCard } from "./product-card";

export function ProductGrid({ products, locale }: { products: Product[]; locale: BuyerLocale }) {
  return (
    <section
      className="product-grid"
      aria-label={locale === "zh-TW" ? "商品目錄" : "Product catalog"}
    >
      {products.map((product) => (
        <ProductCard locale={locale} product={product} key={product.slug} />
      ))}
    </section>
  );
}
