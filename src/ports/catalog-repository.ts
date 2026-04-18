import type { Product } from "@/src/domain/catalog/product";

export type CatalogRepository = {
  listProducts(): Promise<Product[]>;
  findProductBySlug(slug: string): Promise<Product | null>;
};
