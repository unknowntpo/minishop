import type { Product } from "@/src/domain/catalog/product";
import type { CatalogRepository } from "@/src/ports/catalog-repository";

const products = [
  {
    slug: "limited-runner",
    name: "Limited Runner",
    skuId: "sku_hot_001",
    skuCode: "hot-001",
    summary: "One hot SKU for high-concurrency direct buy pressure.",
    checkoutNote: "one hot product · event-sourced checkout",
    priceAmountMinor: 100000,
    currency: "TWD",
    available: 100,
    image: {
      src: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1400&q=80",
      alt: "Red running shoe",
    },
  },
  {
    slug: "everyday-tee",
    name: "Everyday Tee",
    skuId: "sku_tee_001",
    skuCode: "tee-001",
    summary: "A steady catalog SKU used to verify mixed-cart checkout behavior.",
    checkoutNote: "catalog product · multi-SKU cart ready",
    priceAmountMinor: 68000,
    currency: "TWD",
    available: 240,
    image: {
      src: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=1400&q=80",
      alt: "Folded neutral t-shirt",
    },
  },
  {
    slug: "travel-cap",
    name: "Travel Cap",
    skuId: "sku_cap_001",
    skuCode: "cap-001",
    summary: "A lightweight add-on SKU for cart checkout reservation progress.",
    checkoutNote: "add-on product · projection-backed inventory",
    priceAmountMinor: 42000,
    currency: "TWD",
    available: 160,
    image: {
      src: "https://images.unsplash.com/photo-1521369909029-2afed882baee?auto=format&fit=crop&w=1400&q=80",
      alt: "Casual travel cap",
    },
  },
] satisfies Product[];

export const staticCatalogRepository: CatalogRepository = {
  async listProducts() {
    return products;
  },

  async findProductBySlug(slug) {
    return products.find((product) => product.slug === slug) ?? null;
  },
};
