import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProductDetailPage } from "@/components/checkout/product-detail-page";
import { ProductsPageContent } from "@/components/products/products-page-content";
import { staticCatalogRepository } from "@/src/infrastructure/catalog/static-catalog-repository";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe("Products", () => {
  it("renders a browsable catalog with all preview products", async () => {
    const products = await staticCatalogRepository.listProducts();

    render(<ProductsPageContent products={products} />);

    expect(
      screen.getByRole("heading", { name: "Browse checkout-ready SKUs." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Limited Runner/ })).toHaveAttribute(
      "href",
      "/products/limited-runner",
    );
    expect(screen.getByRole("link", { name: /Everyday Tee/ })).toHaveAttribute(
      "href",
      "/products/everyday-tee",
    );
    expect(screen.getByRole("link", { name: /Travel Cap/ })).toHaveAttribute(
      "href",
      "/products/travel-cap",
    );
  });

  it("renders product detail without static checkout status preview", async () => {
    window.localStorage.clear();
    const products = await staticCatalogRepository.listProducts();
    const product = await staticCatalogRepository.findProductBySlug("everyday-tee");

    if (!product) {
      throw new Error("Missing everyday tee fixture");
    }

    render(<ProductDetailPage product={product} products={products} />);

    expect(screen.getByRole("heading", { name: "Everyday Tee" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy now" })).toBeInTheDocument();
    expect(screen.queryByText("Accepted does not mean reserved.")).not.toBeInTheDocument();
    expect(screen.queryByText("Request received")).not.toBeInTheDocument();
  });

  it("shows add-to-cart feedback after adding quantity to the cart", async () => {
    window.localStorage.clear();
    const products = await staticCatalogRepository.listProducts();
    const product = await staticCatalogRepository.findProductBySlug("travel-cap");

    if (!product) {
      throw new Error("Missing travel cap fixture");
    }

    render(<ProductDetailPage product={product} products={products} />);

    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));

    expect(screen.getByText("Added to cart")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View cart" })).toBeInTheDocument();
  });

  it("disables purchase actions when a sku is out of stock", async () => {
    window.localStorage.clear();
    const products = await staticCatalogRepository.listProducts();
    const product = await staticCatalogRepository.findProductBySlug("limited-runner");

    if (!product) {
      throw new Error("Missing limited runner fixture");
    }

    render(
      <ProductDetailPage
        product={{ ...product, available: 0 }}
        products={products.map((entry) =>
          entry.slug === product.slug ? { ...entry, available: 0 } : entry,
        )}
      />,
    );

    expect(screen.getByText("This SKU is sold out in the current projection.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to cart" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sold out" })).toBeDisabled();
  });
});
