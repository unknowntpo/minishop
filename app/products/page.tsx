import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ProductsPageContent } from "@/components/products/products-page-content";
import { listProducts } from "@/src/application/catalog/get-products";
import { postgresCatalogRepository } from "@/src/infrastructure/catalog";
import { buildBuyerWebUrl } from "@/src/presentation/buyer-web-runtime";
import {
  buyerLocaleCookieName,
  normalizeBuyerLocale,
} from "@/src/presentation/i18n/buyer-localization";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const buyerWebUrl = buildBuyerWebUrl("/products");
  if (buyerWebUrl) {
    redirect(buyerWebUrl);
  }

  const products = await listProducts({
    catalogRepository: postgresCatalogRepository,
  });
  const initialLocale = normalizeBuyerLocale((await cookies()).get(buyerLocaleCookieName)?.value);

  return <ProductsPageContent products={products} initialLocale={initialLocale} />;
}
