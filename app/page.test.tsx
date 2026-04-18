import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProductDetailPage } from "@/components/checkout/product-detail-page";
import { staticCatalogRepository } from "@/src/infrastructure/catalog/static-catalog-repository";

import { ProductsPageContent } from "./products/page";

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

  it("keeps checkout status copy on product detail pages", async () => {
    const product = await staticCatalogRepository.findProductBySlug("everyday-tee");

    if (!product) {
      throw new Error("Missing everyday tee fixture");
    }

    render(<ProductDetailPage product={product} />);

    expect(screen.getByRole("heading", { name: "Everyday Tee" })).toBeInTheDocument();
    expect(screen.getByText("Accepted does not mean reserved.")).toBeInTheDocument();
    expect(screen.getByText("Request received")).toBeInTheDocument();
  });
});
