import type { Product } from "@/src/domain/catalog/product";
import type { CatalogRepository } from "@/src/ports/catalog-repository";

export type CatalogDeps = {
  catalogRepository: CatalogRepository;
};

export async function listProducts({ catalogRepository }: CatalogDeps): Promise<Product[]> {
  return catalogRepository.listProducts();
}

export async function getProductBySlug(
  slug: string,
  { catalogRepository }: CatalogDeps,
): Promise<Product | null> {
  return catalogRepository.findProductBySlug(slug);
}
