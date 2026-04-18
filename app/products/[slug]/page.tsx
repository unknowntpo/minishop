import { notFound } from "next/navigation";

import { ProductDetailPage } from "@/components/checkout/product-detail-page";
import { getProductBySlug, listProducts } from "@/src/application/catalog/get-products";
import { staticCatalogRepository } from "@/src/infrastructure/catalog/static-catalog-repository";

type ProductPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export async function generateStaticParams() {
  const products = await listProducts({
    catalogRepository: staticCatalogRepository,
  });

  return products.map((product) => ({
    slug: product.slug,
  }));
}

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params;
  const product = await getProductBySlug(slug, {
    catalogRepository: staticCatalogRepository,
  });

  if (!product) {
    notFound();
  }

  return <ProductDetailPage product={product} />;
}
