"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { CheckoutAction, type CheckoutActionItem } from "@/components/checkout/checkout-action";
import type { Product } from "@/src/domain/catalog/product";
import { formatProductPrice } from "@/src/presentation/view-models/product";

const cartStorageKey = "minishop-cart-v1";

type CartEntry = {
  quantity: number;
  slug: string;
};

type CartProduct = Product & {
  quantity: number;
  subtotalAmountMinor: number;
};

export function ProductDetailPage({
  product,
  products,
}: {
  product: Product;
  products: Product[];
}) {
  const productBySlug = useMemo(
    () => new Map(products.map((catalogProduct) => [catalogProduct.slug, catalogProduct])),
    [products],
  );
  const [cartEntries, setCartEntries] = useState<CartEntry[]>([]);
  const [directQuantity, setDirectQuantity] = useState(1);
  const [cartOpen, setCartOpen] = useState(false);
  const maxDirectQuantity = maxQuantityFor(product);
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
  const totalAmountMinor = cartProducts.reduce(
    (sum, cartProduct) => sum + cartProduct.subtotalAmountMinor,
    0,
  );

  useEffect(() => {
    setCartEntries(readCart(productBySlug));
  }, [productBySlug]);

  useEffect(() => {
    setDirectQuantity((current) => clampQuantity(current, maxDirectQuantity));
  }, [maxDirectQuantity]);

  function syncCart(nextEntries: CartEntry[]) {
    const normalized = normalizeCart(nextEntries, productBySlug);
    setCartEntries(normalized);
    persistCart(normalized);
  }

  function addCurrentProductToCart() {
    syncCart(
      mergeCartEntry(cartEntries, {
        quantity: directQuantity,
        slug: product.slug,
      }),
    );
    setCartOpen(true);
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
      <Link className="text-link" href="/products">
        Products
      </Link>

      <section className="product-layout" aria-labelledby="product-title">
        <div className="product-media">
          <Image
            src={product.image.src}
            alt={product.image.alt}
            width={1400}
            height={930}
            sizes="(max-width: 900px) 100vw, 58vw"
            priority
          />
        </div>

        <div className="purchase-stack">
          <section className="panel purchase-panel">
            <p className="eyebrow">Direct buy</p>
            <h1 id="product-title">{product.name}</h1>
            <p className="muted">
              SKU {product.skuCode} · {product.checkoutNote}
            </p>
            <div className="price">{formatProductPrice(product)}</div>
            <div className="inventory-row">
              <div>
                <strong>Available now: {product.available}</strong>
                <p className="muted">Reservation is confirmed after checkout processing.</p>
              </div>
              <span className="badge neutral">projection</span>
            </div>

            <div className="purchase-controls">
              <div className="quantity-panel">
                <span className="quantity-label">Quantity</span>
                <div className="quantity-stepper">
                  <button
                    className="quantity-button"
                    type="button"
                    disabled={directQuantity <= 1}
                    onClick={() =>
                      setDirectQuantity((current) => clampQuantity(current - 1, maxDirectQuantity))
                    }
                  >
                    −
                  </button>
                  <strong className="quantity-value">{directQuantity}</strong>
                  <button
                    className="quantity-button"
                    type="button"
                    disabled={directQuantity >= maxDirectQuantity}
                    onClick={() =>
                      setDirectQuantity((current) => clampQuantity(current + 1, maxDirectQuantity))
                    }
                  >
                    +
                  </button>
                </div>
                <span className="muted quantity-hint">
                  Max {formatNumber(maxDirectQuantity)} units
                </span>
              </div>

              <div className="purchase-actions">
                <CheckoutAction
                  product={product}
                  items={[
                    {
                      currency: product.currency,
                      quantity: directQuantity,
                      skuId: product.skuId,
                      unitPriceAmountMinor: product.priceAmountMinor,
                    },
                  ]}
                  buttonLabel={`Buy ${directQuantity > 1 ? `${formatNumber(directQuantity)} units` : "now"}`}
                />
                <button
                  className="button secondary"
                  type="button"
                  disabled={maxDirectQuantity <= 0}
                  onClick={addCurrentProductToCart}
                >
                  Add to cart
                </button>
              </div>
            </div>

            <p className="fine-print">
              Buy now creates a checkout intent immediately. Cart checkout combines multiple SKUs
              and quantities into one intent.
            </p>
            <OperatorStrip product={product} />
          </section>
        </div>
      </section>

      <details
        className="floating-cart"
        open={cartOpen}
        onToggle={(event) => setCartOpen(event.currentTarget.open)}
      >
        <summary aria-label="Cart checkout">
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
              {formatNumber(totalUnits)}
            </span>
          ) : null}
          <span className="cart-summary">
            <strong>
              {totalUnits > 0 ? `Cart · ${formatNumber(totalUnits)} items` : "Cart is empty"}
            </strong>
            <span className="muted">
              {cartProducts.length > 0
                ? `${formatNumber(cartProducts.length)} SKUs · ${formatMoney(
                    totalAmountMinor,
                    cartProducts[0]?.currency ?? product.currency,
                  )}`
                : "Add products here before checkout."}
            </span>
          </span>
          {cartProducts.length > 0 ? (
            <span className="badge neutral cart-status">ready</span>
          ) : null}
        </summary>

        <div className="cart-drawer">
          <div className="cart-drawer-header">
            <div>
              <p className="eyebrow">Cart checkout</p>
              <h2>Checkout {formatNumber(totalUnits)} items</h2>
            </div>
            {cartProducts.length > 0 ? (
              <span className="badge neutral">
                {formatMoney(totalAmountMinor, cartProducts[0].currency)}
              </span>
            ) : null}
          </div>

          {cartProducts.length > 0 ? (
            <>
              <div className="cart-list">
                {cartProducts.map((cartProduct) => (
                  <article className="cart-item" key={cartProduct.slug}>
                    <div className="cart-thumb" aria-hidden="true" />
                    <div className="cart-item-body">
                      <div className="cart-item-copy">
                        <strong>{cartProduct.name}</strong>
                        <p className="muted">
                          SKU {cartProduct.skuCode} ·{" "}
                          {formatMoney(cartProduct.subtotalAmountMinor, cartProduct.currency)}
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
                          Remove
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>

              <div className="cart-checkout">
                <CheckoutAction
                  disabled={cartCheckoutItems.length === 0}
                  onCompleted={clearCart}
                  product={product}
                  items={cartCheckoutItems}
                  buttonLabel={`Checkout cart · ${formatMoney(
                    totalAmountMinor,
                    cartProducts[0].currency,
                  )}`}
                />
              </div>
            </>
          ) : (
            <div className="cart-empty">
              <strong>No products in cart yet.</strong>
              <p className="muted">
                Use Add to cart on any product page, then return here to submit one checkout intent
                with multiple SKUs.
              </p>
            </div>
          )}
        </div>
      </details>
    </main>
  );
}

function OperatorStrip({ product }: { product: Product }) {
  if (process.env.NODE_ENV === "production" || !product.inventory) {
    return null;
  }

  const lagLabel =
    product.inventory.projectionLagMs === null
      ? "n/a"
      : formatProjectionLag(product.inventory.projectionLagMs);

  return (
    <section className="operator-strip" aria-label="Projection operator strip">
      <p className="eyebrow">Dev-only operator strip</p>
      <div className="operator-grid">
        <span className="operator-metric">
          <strong>sku</strong>
          <code>{product.skuId}</code>
        </span>
        <span className="operator-metric">
          <strong>on_hand</strong>
          <code>{product.inventory.onHand}</code>
        </span>
        <span className="operator-metric">
          <strong>reserved</strong>
          <code>{product.inventory.reserved}</code>
        </span>
        <span className="operator-metric">
          <strong>sold</strong>
          <code>{product.inventory.sold}</code>
        </span>
        <span className="operator-metric">
          <strong>available</strong>
          <code>{product.inventory.available}</code>
        </span>
        <span className="operator-metric">
          <strong>event_id</strong>
          <code>{product.inventory.lastEventId}</code>
        </span>
        <span className="operator-metric">
          <strong>version</strong>
          <code>{product.inventory.aggregateVersion}</code>
        </span>
        <span className="operator-metric">
          <strong>lag</strong>
          <code>{lagLabel}</code>
        </span>
      </div>
    </section>
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

function mergeCartEntry(entries: CartEntry[], nextEntry: CartEntry) {
  const existing = entries.find((entry) => entry.slug === nextEntry.slug);

  if (!existing) {
    return [...entries, nextEntry];
  }

  return entries.map((entry) =>
    entry.slug === nextEntry.slug
      ? {
          ...entry,
          quantity: entry.quantity + nextEntry.quantity,
        }
      : entry,
  );
}

// Keep local cart storage small and self-healing across product or inventory changes.
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
}

function maxQuantityFor(product: Product) {
  return Math.max(1, Math.min(product.available, 99));
}

function clampQuantity(quantity: number, maxQuantity: number) {
  if (!Number.isFinite(quantity)) {
    return 1;
  }

  return Math.max(1, Math.min(Math.round(quantity), maxQuantity));
}

function formatMoney(amountMinor: number, currency: string) {
  return `${currency} ${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(amountMinor / 100)}`;
}

function formatProjectionLag(lagMs: number) {
  const safeLag = Math.max(0, lagMs);

  if (safeLag < 1000) {
    return `${safeLag}ms`;
  }

  const seconds = Math.round(safeLag / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  return `${Math.round(seconds / 60)}m`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
