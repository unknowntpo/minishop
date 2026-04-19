"use client";

import { useEffect, useMemo, useState } from "react";

import { BuyerDevMenu } from "@/components/buyer/buyer-dev-menu";
import { BuyerLocaleProvider, useBuyerLocale } from "@/components/buyer/buyer-locale-provider";
import { BuyerProfileMenu } from "@/components/buyer/buyer-profile-menu";
import { CheckoutAction, type CheckoutActionItem } from "@/components/checkout/checkout-action";
import { ProductGrid } from "@/components/products/product-grid";
import type { Product } from "@/src/domain/catalog/product";
import {
  type BuyerLocale,
  formatBuyerMoney,
  getLocalizedProduct,
  normalizeBuyerLocale,
} from "@/src/presentation/i18n/buyer-localization";

const cartStorageKey = "minishop-cart-v1";
const cartUpdatedEvent = "minishop:cart-updated";

type CartEntry = {
  quantity: number;
  slug: string;
};

type CartProduct = Product & {
  quantity: number;
  subtotalAmountMinor: number;
};

export function ProductsPageContent({
  products,
  initialLocale,
}: {
  products: Product[];
  initialLocale?: BuyerLocale;
}) {
  return (
    <BuyerLocaleProvider initialLocale={normalizeBuyerLocale(initialLocale)}>
      <ProductsPageBody products={products} />
    </BuyerLocaleProvider>
  );
}

function ProductsPageBody({ products }: { products: Product[] }) {
  const { locale, messages } = useBuyerLocale();
  const productBySlug = useMemo(
    () => new Map(products.map((catalogProduct) => [catalogProduct.slug, catalogProduct])),
    [products],
  );
  const [cartEntries, setCartEntries] = useState<CartEntry[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const cartProducts = useMemo(
    () => hydrateCartProducts(cartEntries, productBySlug),
    [cartEntries, productBySlug],
  );
  const cartCheckoutItems = useMemo<CheckoutActionItem[]>(
    () =>
      cartProducts.map((cartProduct) => ({
        currency: cartProduct.currency,
        quantity: cartProduct.quantity,
        skuId: cartProduct.skuId,
        unitPriceAmountMinor: cartProduct.priceAmountMinor,
      })),
    [cartProducts],
  );
  const totalUnits = cartProducts.reduce((sum, cartProduct) => sum + cartProduct.quantity, 0);
  const distinctSkuCount = cartProducts.length;
  const totalAmountMinor = cartProducts.reduce(
    (sum, cartProduct) => sum + cartProduct.subtotalAmountMinor,
    0,
  );
  const checkoutProduct = cartProducts[0] ?? products[0] ?? null;

  useEffect(() => {
    setCartEntries(readCart(productBySlug));
  }, [productBySlug]);

  useEffect(() => {
    function syncStoredCart() {
      setCartEntries(readCart(productBySlug));
    }

    function handleStorage(event: StorageEvent) {
      if (event.key && event.key !== cartStorageKey) {
        return;
      }

      syncStoredCart();
    }

    window.addEventListener("storage", handleStorage);
    window.addEventListener(cartUpdatedEvent, syncStoredCart);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(cartUpdatedEvent, syncStoredCart);
    };
  }, [productBySlug]);

  function syncCart(nextEntries: CartEntry[]) {
    const normalized = normalizeCart(nextEntries, productBySlug);
    setCartEntries(normalized);
    persistCart(normalized);

    if (normalized.length === 0) {
      setCartOpen(false);
    }
  }

  function updateCartQuantity(slug: string, quantity: number) {
    syncCart(
      cartEntries.map((entry) =>
        entry.slug === slug
          ? {
              ...entry,
              quantity,
            }
          : entry,
      ),
    );
  }

  function removeFromCart(slug: string) {
    syncCart(cartEntries.filter((entry) => entry.slug !== slug));
  }

  function clearCart() {
    syncCart([]);
    setCartOpen(false);
  }

  return (
    <main className="page-shell">
      <div className="buyer-toolbar">
        <span className="buyer-toolbar-label">{messages.navProducts}</span>
        <div className="buyer-toolbar-actions">
          <BuyerDevMenu />
          <div className={`floating-cart header-cart${cartOpen ? " is-open" : ""}`}>
            <button
              aria-expanded={cartOpen}
              aria-label={messages.cart.drawerEyebrow}
              className="header-cart-trigger"
              onClick={() => setCartOpen((current) => !current)}
              type="button"
            >
              <svg className="cart-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M6.2 6.8h14.1l-1.5 7.3a2 2 0 0 1-2 1.6H9.1a2 2 0 0 1-2-1.7L5.7 4.9H3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
                <circle cx="9.5" cy="19" r="1.3" fill="currentColor" />
                <circle cx="17" cy="19" r="1.3" fill="currentColor" />
              </svg>
              {totalUnits > 0 ? (
                <span className="cart-count" aria-hidden="true">
                  {distinctSkuCount}
                </span>
              ) : null}
              <span className="cart-summary">
                <strong>{totalUnits > 0 ? messages.cart.summary : messages.cart.emptyTitle}</strong>
                <span className="muted">
                  {cartProducts.length > 0
                    ? messages.cart.populatedBody(totalUnits, distinctSkuCount)
                    : messages.cart.emptyBody}
                </span>
              </span>
              {cartProducts.length > 0 ? (
                <strong className="cart-summary-total">
                  {formatBuyerMoney(
                    totalAmountMinor,
                    cartProducts[0]?.currency ?? checkoutProduct?.currency ?? "TWD",
                    locale,
                  )}
                </strong>
              ) : null}
              <span className="cart-toggle-hint" aria-hidden="true">
                {cartOpen ? messages.actions.hide : messages.actions.open}
              </span>
            </button>

            <div className={`cart-drawer${cartOpen ? " visible" : ""}`}>
              <div className="cart-drawer-header">
                <div className="cart-drawer-heading">
                  <p className="eyebrow">{messages.cart.drawerEyebrow}</p>
                  <h2>
                    {cartProducts.length > 0 ? messages.cart.reviewTitle : messages.cart.emptyTitle}
                  </h2>
                </div>
              </div>

              {cartProducts.length > 0 ? (
                <>
                  <div className="cart-list">
                    {cartProducts.map((cartProduct) => (
                      <article className="cart-item" key={cartProduct.slug}>
                        <div className="cart-thumb" aria-hidden="true" />
                        <div className="cart-item-body">
                          <div className="cart-item-copy">
                            <strong>{getLocalizedProduct(cartProduct, locale).name}</strong>
                            <p className="muted">
                              {messages.cart.itemMeta(
                                cartProduct.skuCode,
                                formatBuyerMoney(
                                  cartProduct.subtotalAmountMinor,
                                  cartProduct.currency,
                                  locale,
                                ),
                              )}
                            </p>
                          </div>
                          <div className="cart-item-actions">
                            <div className="quantity-stepper compact">
                              <button
                                className="quantity-button"
                                type="button"
                                disabled={cartProduct.quantity <= 1}
                                onClick={() =>
                                  updateCartQuantity(
                                    cartProduct.slug,
                                    clampQuantity(
                                      cartProduct.quantity - 1,
                                      maxQuantityFor(cartProduct),
                                    ),
                                  )
                                }
                              >
                                −
                              </button>
                              <strong className="quantity-value">{cartProduct.quantity}</strong>
                              <button
                                className="quantity-button"
                                type="button"
                                disabled={cartProduct.quantity >= maxQuantityFor(cartProduct)}
                                onClick={() =>
                                  updateCartQuantity(
                                    cartProduct.slug,
                                    clampQuantity(
                                      cartProduct.quantity + 1,
                                      maxQuantityFor(cartProduct),
                                    ),
                                  )
                                }
                              >
                                +
                              </button>
                            </div>
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => removeFromCart(cartProduct.slug)}
                            >
                              {messages.actions.remove}
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>

                  {checkoutProduct ? (
                    <div className="cart-checkout">
                      <CheckoutAction
                        disabled={cartCheckoutItems.length === 0}
                        locale={locale}
                        onCompleted={clearCart}
                        product={checkoutProduct}
                        items={cartCheckoutItems}
                        buttonLabel={messages.actions.checkoutCart(
                          formatBuyerMoney(
                            totalAmountMinor,
                            cartProducts[0]?.currency ?? checkoutProduct.currency,
                            locale,
                          ),
                        )}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="cart-empty">
                  <strong>{messages.cart.emptyDrawerTitle}</strong>
                  <p className="muted">{messages.cart.emptyDrawerBody}</p>
                </div>
              )}
            </div>
          </div>
          <BuyerProfileMenu />
        </div>
      </div>

      <button
        aria-hidden={!cartOpen}
        className={`cart-backdrop${cartOpen ? " visible" : ""}`}
        onClick={() => setCartOpen(false)}
        tabIndex={cartOpen ? 0 : -1}
        type="button"
      />

      <section className="catalog-hero" aria-labelledby="products-title">
        <p className="eyebrow">{messages.catalogEyebrow}</p>
        <h1 id="products-title">{messages.catalogTitle}</h1>
        <p className="muted hero-copy">{messages.catalogDescription}</p>
      </section>

      <ProductGrid locale={locale} products={products} />
    </main>
  );
}

function hydrateCartProducts(entries: CartEntry[], productBySlug: Map<string, Product>) {
  return normalizeCart(entries, productBySlug)
    .map((entry) => {
      const cartProduct = productBySlug.get(entry.slug);

      if (!cartProduct) {
        return null;
      }

      return {
        ...cartProduct,
        quantity: entry.quantity,
        subtotalAmountMinor: cartProduct.priceAmountMinor * entry.quantity,
      } satisfies CartProduct;
    })
    .filter((cartProduct): cartProduct is CartProduct => cartProduct !== null);
}

function normalizeCart(entries: CartEntry[], productBySlug: Map<string, Product>) {
  const normalized = new Map<string, CartEntry>();

  for (const entry of entries) {
    const cartProduct = productBySlug.get(entry.slug);

    if (!cartProduct) {
      continue;
    }

    const quantity = clampQuantity(entry.quantity, maxQuantityFor(cartProduct));

    if (quantity <= 0) {
      continue;
    }

    normalized.set(entry.slug, {
      quantity,
      slug: entry.slug,
    });
  }

  return [...normalized.values()].sort((left, right) => left.slug.localeCompare(right.slug));
}

function readCart(productBySlug: Map<string, Product>) {
  try {
    const raw = window.localStorage.getItem(cartStorageKey);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizeCart(
      parsed.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }

        const { quantity, slug } = entry as Partial<CartEntry>;

        if (typeof slug !== "string" || typeof quantity !== "number") {
          return [];
        }

        return [
          {
            quantity,
            slug,
          },
        ];
      }),
      productBySlug,
    );
  } catch {
    return [];
  }
}

function persistCart(entries: CartEntry[]) {
  window.localStorage.setItem(cartStorageKey, JSON.stringify(entries));
  window.dispatchEvent(new Event(cartUpdatedEvent));
}

function maxQuantityFor(product: Product) {
  return Math.max(0, Math.min(product.available, 99));
}

function clampQuantity(quantity: number, maxQuantity: number) {
  if (maxQuantity <= 0) {
    return 0;
  }

  if (!Number.isFinite(quantity)) {
    return 1;
  }

  return Math.max(1, Math.min(Math.round(quantity), maxQuantity));
}
