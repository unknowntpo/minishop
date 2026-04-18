import "server-only";

import type { Pool } from "pg";

import {
  type CatalogProductRow,
  mapProductRow,
} from "@/src/infrastructure/catalog/catalog-row-mapper";
import type { CatalogRepository } from "@/src/ports/catalog-repository";

export function createPostgresCatalogRepository(pool: Pool): CatalogRepository {
  return {
    async listProducts() {
      const result = await pool.query<CatalogProductRow>(catalogQuery());
      return result.rows.map(mapProductRow);
    },

    async findProductBySlug(slug) {
      const result = await pool.query<CatalogProductRow>(
        `
          ${catalogQuery()}
          and coalesce(sku.attributes->>'slug', product.product_id) = $1
          limit 1
        `,
        [slug],
      );

      const row = result.rows[0];
      return row ? mapProductRow(row) : null;
    },
  };
}

function catalogQuery() {
  return `
    select
      product.product_id,
      product.name as product_name,
      product.description,
      sku.sku_id,
      sku.sku_code,
      sku.price_amount_minor,
      sku.currency,
      sku.attributes,
      sku_inventory_projection.on_hand,
      sku_inventory_projection.reserved,
      sku_inventory_projection.sold,
      sku_inventory_projection.available,
      sku_inventory_projection.aggregate_version as inventory_aggregate_version,
      sku_inventory_projection.last_event_id as inventory_last_event_id,
      sku_inventory_projection.updated_at as inventory_updated_at
    from product
    join sku on sku.product_id = product.product_id
    left join sku_inventory_projection on sku_inventory_projection.sku_id = sku.sku_id
    where product.status = 'active'
      and sku.status = 'active'
  `;
}
