import { ProductGrid } from "@/components/products/product-grid";
import { listProducts } from "@/src/application/catalog/get-products";
import { staticCatalogRepository } from "@/src/infrastructure/catalog/static-catalog-repository";

export default async function ProductsPage() {
  const products = await listProducts({
    catalogRepository: staticCatalogRepository,
  });

  return <ProductsPageContent products={products} />;
}

export function ProductsPageContent({
  products,
}: {
  products: Awaited<ReturnType<typeof listProducts>>;
}) {
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
