import { ProductsPageContent } from "@/components/products/products-page-content";
import { listProducts } from "@/src/application/catalog/get-products";
import { postgresCatalogRepository } from "@/src/infrastructure/catalog";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const products = await listProducts({
    catalogRepository: postgresCatalogRepository,
  });

  return <ProductsPageContent products={products} />;
}
