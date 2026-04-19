import { cookies } from "next/headers";

import { ProductsPageContent } from "@/components/products/products-page-content";
import { listProducts } from "@/src/application/catalog/get-products";
import { postgresCatalogRepository } from "@/src/infrastructure/catalog";
import {
  buyerLocaleCookieName,
  normalizeBuyerLocale,
} from "@/src/presentation/i18n/buyer-localization";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const products = await listProducts({
    catalogRepository: postgresCatalogRepository,
  });
  const initialLocale = normalizeBuyerLocale((await cookies()).get(buyerLocaleCookieName)?.value);

  return <ProductsPageContent products={products} initialLocale={initialLocale} />;
}
