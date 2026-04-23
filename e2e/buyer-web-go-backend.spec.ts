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

  test("admin dashboard loads from go backend", async ({ page }) => {
    await page.goto("/internal/admin");
    await expect(page.getByRole("heading", { name: "Projection status" })).toBeVisible();
    await expect(page.locator(".admin-product-card").first()).toBeVisible();
  });
});
