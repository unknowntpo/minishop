import { notFound } from "next/navigation";

import { ProductDetailPage } from "@/components/checkout/product-detail-page";
import { getProductBySlug, listProducts } from "@/src/application/catalog/get-products";
import { postgresCatalogRepository } from "@/src/infrastructure/catalog";

type ProductPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params;
  const [product, products] = await Promise.all([
    getProductBySlug(slug, {
      catalogRepository: postgresCatalogRepository,
    }),
    listProducts({
      catalogRepository: postgresCatalogRepository,
    }),
  ]);

  if (!product) {
    notFound();
  }

  return <ProductDetailPage product={product} products={products} />;
}
