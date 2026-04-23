import { expect, test } from "@playwright/test";

const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL?.trim() || "http://127.0.0.1:3005";

test.describe("buyer web against go backend", () => {
  test("buyer completes a regular checkout from product detail", async ({ page }) => {
    test.slow();

    await page.goto("/products");
    await expect(page.locator('a[href="/products/travel-cap"]').first()).toBeVisible();

    await page.locator('a[href="/products/travel-cap"]').first().click();
    await expect(page).toHaveURL(/\/products\/travel-cap$/);

    const buyIntentAccepted = page.waitForResponse(
      (response) =>
        response.url() === `${apiBaseUrl}/api/buy-intents` &&
        response.request().method() === "POST" &&
        response.status() === 202,
      { timeout: 30_000 },
    );

    await page.getByRole("button", { name: /立即購買|Buy now/i }).click();
    await buyIntentAccepted;

    await page.waitForURL(/\/checkout-complete\/[^?]+/, { timeout: 90_000 });
    await expect(page.locator(".checkout-complete-panel")).toBeVisible();
    await expect(page.locator(".completion-grid")).toContainText("confirmed");
  });

  test("buyer completes a cart checkout from product detail", async ({ page }) => {
    test.slow();

    await page.goto("/products/travel-cap");
    await expect(page).toHaveURL(/\/products\/travel-cap$/);

    await page.getByRole("button", { name: /Add to cart|加入購物車/i }).click();
    await expect(page.getByText(/購物車|cart/i).first()).toBeVisible();

    const buyIntentAccepted = page.waitForResponse(
      (response) =>
        response.url() === `${apiBaseUrl}/api/buy-intents` &&
        response.request().method() === "POST" &&
        response.status() === 202,
      { timeout: 30_000 },
    );

    await page.getByRole("button", { name: /結帳購物車|Checkout cart/i }).click();
    await buyIntentAccepted;

    await page.waitForURL(/\/checkout-complete\/[^?]+/, { timeout: 90_000 });
    await expect(page.locator(".checkout-complete-panel")).toBeVisible();
    await expect(page.locator(".completion-grid")).toContainText("confirmed");
  });

  test("admin dashboard loads from go backend", async ({ page }) => {
    await page.goto("/internal/admin");
    await expect(page.getByRole("heading", { name: "Projection status" })).toBeVisible();
    await expect(page.locator(".admin-product-card").first()).toBeVisible();
  });

test("benchmark results page loads from go backend", async ({ page }) => {
  await page.goto("/internal/benchmarks");
  await expect(page.getByRole("heading", { name: "Benchmark results" })).toBeVisible();
  await expect(page.locator(".benchmark-scenario-card").first()).toBeVisible();
  await expect(page.locator(".benchmark-table tbody tr").first()).toBeVisible();
});

test("benchmark scenario and run selection use client-side navigation", async ({ page }) => {
  await page.goto("/internal/benchmarks?scenario=buy-intent-bypass-created");
  await page.waitForSelector(".benchmark-scenario-card");
  await page.evaluate(() => {
    (window as typeof window & { __benchmarkMarker?: string }).__benchmarkMarker = "client-nav";
  });

  await page.locator(".benchmark-scenario-card").nth(1).click();
  await expect(page).toHaveURL(/scenario=buy-intent-hot-seckill/);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __benchmarkMarker?: string }).__benchmarkMarker ?? null,
      ),
    )
    .toBe("client-nav");

  await page.locator(".benchmark-run-tag").first().click();
  await expect(page).toHaveURL(/run=/);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __benchmarkMarker?: string }).__benchmarkMarker ?? null,
      ),
    )
    .toBe("client-nav");
});

  test("admin can start and stop seckill through go backend", async ({ page }) => {
    test.slow();

    await page.goto("/internal/admin");
    const candidateCard = page.locator(".admin-product-card", { hasText: /seckill candidate/i }).first();
    await expect(candidateCard).toBeVisible();

    const stockInput = candidateCard.getByRole("spinbutton");
    await stockInput.fill("25");
    await candidateCard.getByRole("button", { name: /開始秒殺/i }).click();
    await expect(candidateCard.getByRole("button", { name: /停止秒殺/i })).toBeEnabled({ timeout: 15_000 });

    await candidateCard.getByRole("button", { name: /停止秒殺/i }).click();
    await expect(candidateCard.getByRole("button", { name: /停止秒殺/i })).toBeDisabled({ timeout: 15_000 });
  });
});
