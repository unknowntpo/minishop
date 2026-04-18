import { notFound } from "next/navigation";

import { ProductDetailPage } from "@/components/checkout/product-detail-page";
import { getProductBySlug } from "@/src/application/catalog/get-products";
import { postgresCatalogRepository } from "@/src/infrastructure/catalog";

type ProductPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params;
  const product = await getProductBySlug(slug, {
    catalogRepository: postgresCatalogRepository,
  });

  if (!product) {
    notFound();
  }

  return <ProductDetailPage product={product} />;
}
