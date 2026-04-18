import { getPool } from "@/db/client";
import { createPostgresCatalogRepository } from "@/src/infrastructure/catalog/postgres-catalog-repository";
import type { CatalogRepository } from "@/src/ports/catalog-repository";

export const postgresCatalogRepository: CatalogRepository = {
  listProducts() {
    return createPostgresCatalogRepository(getPool()).listProducts();
  },
  findProductBySlug(slug) {
    return createPostgresCatalogRepository(getPool()).findProductBySlug(slug);
  },
};
