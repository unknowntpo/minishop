import { ProductGrid } from "@/components/products/product-grid";
import type { Product } from "@/src/domain/catalog/product";

export function ProductsPageContent({ products }: { products: Product[] }) {
  return (
    <main className="page-shell">
      <section className="catalog-hero" aria-labelledby="products-title">
        <p className="eyebrow">Products</p>
        <h1 id="products-title">Browse checkout-ready SKUs.</h1>
        <p className="muted hero-copy">
          Select a product, then start the event-sourced buy flow. Cart checkout can reserve SKUs
          across multiple products without treating product as the inventory boundary.
        </p>
      </section>

      <ProductGrid products={products} />
    </main>
  );
}
