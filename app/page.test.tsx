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

    expect(screen.getByRole("heading", { name: "瀏覽可直接結帳的 SKU。" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /限量跑鞋/ })).toHaveAttribute(
      "href",
      "/products/limited-runner",
    );
    expect(screen.getByRole("link", { name: /日常 T 恤/ })).toHaveAttribute(
      "href",
      "/products/everyday-tee",
    );
    expect(screen.getByRole("link", { name: /旅行帽/ })).toHaveAttribute(
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

    expect(screen.getByRole("heading", { name: "日常 T 恤" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即購買" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "加入購物車" }));

    expect(screen.getByText("已加入購物車")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看購物車" })).toBeInTheDocument();
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

    expect(screen.getByText("目前 projection 顯示這個 SKU 已售完。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加入購物車" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "已售完" })).toBeDisabled();
  });

  it("switches buyer-facing copy to English and persists the selection", async () => {
    window.localStorage.clear();
    const products = await staticCatalogRepository.listProducts();

    render(<ProductsPageContent products={products} />);

    fireEvent.click(screen.getByLabelText("買家偏好設定"));
    fireEvent.click(screen.getByRole("switch", { name: "語言" }));

    expect(
      screen.getByRole("heading", { name: "Browse checkout-ready SKUs." }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem("minishop-buyer-locale")).toBe("en");
  });
});
