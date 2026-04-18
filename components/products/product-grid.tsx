import type { Product } from "@/src/domain/catalog/product";

import { ProductCard } from "./product-card";

export function ProductGrid({ products }: { products: Product[] }) {
  return (
    <section className="product-grid" aria-label="Product catalog">
      {products.map((product) => (
        <ProductCard product={product} key={product.slug} />
      ))}
    </section>
  );
}
