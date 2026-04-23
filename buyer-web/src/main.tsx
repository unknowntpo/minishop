import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRootRoute, createRoute, createRouter, Navigate, Outlet, Link, useNavigate, useParams } from "@tanstack/react-router";
import "./styles/global.css";
import type { Product } from "@shared/domain/catalog/product";
import type { AdminDashboardViewModel } from "@shared/presentation/view-models/admin-dashboard";
import {
  buyerLocaleStorageKey,
  type BuyerLocale,
  buyerLocaleToHtmlLang,
  formatBuyerDateTime,
  formatBuyerMoney,
  getBuyerMessages,
  getLocalizedProduct,
  normalizeBuyerLocale,
} from "@shared/presentation/i18n/buyer-localization";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

type CheckoutActionItem = {
  skuId: string;
  quantity: number;
  unitPriceAmountMinor: number;
  currency: string;
};

type BuyIntentCommandStatusResponse = {
  commandId: string;
  correlationId: string;
  status: "accepted" | "processing" | "created" | "failed";
  checkoutIntentId: string | null;
  eventId: string | null;
  isDuplicate: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type CheckoutStatusResponse = {
  checkoutIntentId: string;
  status: string;
  lastEventId: number;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
};

type CheckoutCompleteResponse = {
  cancellationReason: string | null;
  checkoutIntentId: string;
  commandId: string | null;
  commandStatus: string | null;
  orderId: string | null;
  paymentId: string | null;
  rejectionReason: string | null;
  status: string;
  updatedAt: string;
};

type CartEntry = {
  quantity: number;
  slug: string;
};

type CartProduct = Product & {
  quantity: number;
  subtotalAmountMinor: number;
};

const queryClient = new QueryClient();
const runtimeDefaultApiBaseUrl =
  typeof window === "undefined"
    ? "http://127.0.0.1:3005"
    : `${window.location.protocol}//${window.location.hostname}:3005`;
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() || runtimeDefaultApiBaseUrl).replace(/\/+$/, "");
const cartStorageKey = "minishop-cart-v1";
const cartUpdatedEvent = "minishop:cart-updated";

function buildApiUrl(pathname: string) {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(normalized, `${apiBaseUrl}/`).toString();
}

async function requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(pathname), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as T;
}

function useBuyerLocaleState() {
  const [locale, setLocale] = useState<BuyerLocale>(() => {
    if (typeof window === "undefined") {
      return "zh-TW";
    }
    return normalizeBuyerLocale(window.localStorage.getItem(buyerLocaleStorageKey));
  });

  useEffect(() => {
    document.documentElement.lang = buyerLocaleToHtmlLang(locale);
    window.localStorage.setItem(buyerLocaleStorageKey, locale);
  }, [locale]);

  return { locale, setLocale, messages: getBuyerMessages(locale) };
}

function AppFrame() {
  const localeState = useBuyerLocaleState();

  return (
    <LocaleContext.Provider value={localeState}>
      <main className="page-shell">
        <div className="buyer-toolbar">
          <Link className="text-link" to="/products">
            {localeState.messages.navProducts}
          </Link>
          <div className="buyer-toolbar-actions">
            <Link className="text-link" to="/internal/admin">
              Admin
            </Link>
            <label className="locale-switcher">
              <span className="sr-only">{localeState.messages.localeLabel}</span>
              <select
                value={localeState.locale}
                onChange={(event) => localeState.setLocale(normalizeBuyerLocale(event.target.value))}
              >
                <option value="zh-TW">{localeState.messages.localeOption["zh-TW"]}</option>
                <option value="en">{localeState.messages.localeOption.en}</option>
              </select>
            </label>
          </div>
        </div>
        <Outlet />
      </main>
      <BuyerDevMenu />
    </LocaleContext.Provider>
  );
}

const rootRoute = createRootRoute({
  component: AppFrame,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <Navigate to="/products" />,
});

const productsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/products",
  component: ProductsScreen,
});

const productDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/products/$slug",
  component: ProductDetailScreen,
});

const checkoutCompleteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/checkout-complete/$checkoutIntentId",
  component: CheckoutCompleteScreen,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/internal/admin",
  component: AdminScreen,
});

const designSystemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/internal/design-system",
  component: DesignSystemScreen,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  productsRoute,
  productDetailRoute,
  checkoutCompleteRoute,
  adminRoute,
  designSystemRoute,
]);

const router = createRouter({
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const LocaleContext = React.createContext<ReturnType<typeof useBuyerLocaleState> | null>(null);

const devLinks = [
  { to: "/internal/design-system", label: "Design System" },
  { to: "/internal/admin", label: "Admin" },
  { to: "/products", label: "Products" },
] as const;

function useBuyerLocaleContext() {
  const value = React.useContext(LocaleContext);
  if (!value) {
    throw new Error("Locale context missing");
  }
  return value;
}

function shouldShowDevMenu() {
  if (typeof window === "undefined") {
    return false;
  }
  if (import.meta.env.VITE_ENABLE_DEV_MENU === "1") {
    return true;
  }
  return window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
}

function BuyerDevMenu() {
  const [open, setOpen] = useState(false);
  const [renderPanel, setRenderPanel] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setRenderPanel(true);
      return;
    }
    const timeout = window.setTimeout(() => setRenderPanel(false), 220);
    return () => window.clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!shouldShowDevMenu()) {
    return null;
  }

  return (
    <div className="buyer-dev-menu" ref={menuRef}>
      <button
        aria-expanded={open}
        aria-label="Open developer menu"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        Dev
      </button>
      {renderPanel ? (
        <div className={`buyer-dev-panel${open ? " visible" : ""}`}>
          <p className="buyer-dev-title">Developer</p>
          <nav className="buyer-dev-links" aria-label="Developer shortcuts">
            {devLinks.map((link) => (
              <Link key={link.to} to={link.to} onClick={() => setOpen(false)}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}
    </div>
  );
}

function ProductsScreen() {
  const { locale, messages } = useBuyerLocaleContext();
  const productsQuery = useQuery({
    queryKey: ["products"],
    queryFn: () => requestJson<Product[]>("/api/products", { method: "GET" }),
  });

  if (productsQuery.isLoading) {
    return <section className="panel">Loading products…</section>;
  }

  if (productsQuery.isError || !productsQuery.data) {
    return <section className="panel">Failed to load products.</section>;
  }

  return (
    <section className="panel">
      <p className="eyebrow">{messages.catalogEyebrow}</p>
      <h1>{messages.catalogTitle}</h1>
      <p className="muted">{messages.catalogDescription}</p>
      <div className="product-grid">
        {productsQuery.data.map((product) => {
          const localized = getLocalizedProduct(product, locale);
          return (
            <Link className="product-card-link" key={product.slug} to="/products/$slug" params={{ slug: product.slug }}>
              <article className="product-card">
                <span className="product-card-media">
                  <img src={product.image.src} alt={localized.image.alt} />
                </span>
                <div className="product-card-body">
                  <span>
                    <span className="product-card-title">{localized.name}</span>
                    <span className="muted">{localized.summary}</span>
                  </span>
                  <div className="product-card-meta">
                    <strong>{formatBuyerMoney(product.priceAmountMinor, product.currency, locale)}</strong>
                    <span className="inventory-pill">{messages.catalogAvailable(product.available)}</span>
                  </div>
                </div>
              </article>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function ProductDetailScreen() {
  const { slug } = useParams({ from: "/products/$slug" });
  const { locale, messages } = useBuyerLocaleContext();
  const navigate = useNavigate();
  const productQuery = useQuery({
    queryKey: ["product", slug],
    queryFn: () => requestJson<Product>(`/api/products/${slug}`, { method: "GET" }),
  });
  const [quantity, setQuantity] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [cartEntries, setCartEntries] = useState<CartEntry[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const catalogQuery = useQuery({
    queryKey: ["products"],
    queryFn: () => requestJson<Product[]>("/api/products", { method: "GET" }),
  });

  useEffect(() => {
    setQuantity(1);
  }, [slug]);

  const productBySlug = React.useMemo(
    () => new Map((catalogQuery.data ?? []).map((catalogProduct) => [catalogProduct.slug, catalogProduct])),
    [catalogQuery.data],
  );

  const cartProducts = React.useMemo(
    () => hydrateCartProducts(cartEntries, productBySlug),
    [cartEntries, productBySlug],
  );
  const cartCheckoutItems = React.useMemo<CheckoutActionItem[]>(
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

  if (productQuery.isLoading) {
    return <section className="panel">Loading product…</section>;
  }

  if (productQuery.isError || !productQuery.data) {
    return <section className="panel">Failed to load product.</section>;
  }

  const product = productQuery.data;
  const localized = getLocalizedProduct(product, locale);
  const maxQuantity = Math.max(product.available, 1);

  function syncCart(nextEntries: CartEntry[]) {
    const normalized = normalizeCart(nextEntries, productBySlug);
    setCartEntries(normalized);
    persistCart(normalized);
    if (normalized.length === 0) {
      setCartOpen(false);
    }
  }

  function addCurrentProductToCart() {
    syncCart(
      mergeCartEntry(cartEntries, {
        quantity,
        slug: product.slug,
      }),
    );
    setCartOpen(true);
  }

  function updateCartQuantity(nextSlug: string, nextQuantity: number) {
    syncCart(
      cartEntries.map((entry) =>
        entry.slug === nextSlug
          ? {
              ...entry,
              quantity: nextQuantity,
            }
          : entry,
      ),
    );
  }

  function removeFromCart(nextSlug: string) {
    syncCart(cartEntries.filter((entry) => entry.slug !== nextSlug));
  }

  function clearCart() {
    syncCart([]);
    setCartOpen(false);
  }

  async function buyNow() {
    setStatus(messages.checkout.submitting);
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch(buildApiUrl("/api/buy-intents"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          buyerId: "demo_buyer",
          items: [
            {
              skuId: product.skuId,
              quantity,
              unitPriceAmountMinor: product.priceAmountMinor,
              currency: product.currency,
            } satisfies CheckoutActionItem,
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const body = (await response.json()) as { commandId: string };
      setStatus(messages.checkout.accepted);

      const commandStatus = await waitForBuyIntentCommandStatus(body.commandId);
      if (commandStatus.status === "failed" || !commandStatus.checkoutIntentId) {
        throw new Error(commandStatus.failureMessage ?? commandStatus.failureCode ?? messages.checkout.failed);
      }

      setStatus(messages.checkout.completing);
      await waitForCheckoutIntentProjection(commandStatus.checkoutIntentId);
      await completeDemoCheckout(commandStatus.checkoutIntentId);
      await processProjections();
      await waitForCheckoutStatus(commandStatus.checkoutIntentId);
      await navigate({
        to: "/checkout-complete/$checkoutIntentId",
        params: { checkoutIntentId: commandStatus.checkoutIntentId },
        search: { commandId: commandStatus.commandId },
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : messages.checkout.failed);
    }
  }

  return (
    <section className="product-detail-shell">
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
              {formatBuyerMoney(totalAmountMinor, cartProducts[0]?.currency ?? product.currency, locale)}
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
              <h2>{cartProducts.length > 0 ? messages.cart.reviewTitle : messages.cart.emptyTitle}</h2>
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
                            formatBuyerMoney(cartProduct.subtotalAmountMinor, cartProduct.currency, locale),
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
                                clampQuantity(cartProduct.quantity - 1, maxQuantityFor(cartProduct)),
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
                                clampQuantity(cartProduct.quantity + 1, maxQuantityFor(cartProduct)),
                              )
                            }
                          >
                            +
                          </button>
                        </div>
                        <button className="text-button" type="button" onClick={() => removeFromCart(cartProduct.slug)}>
                          {messages.actions.remove}
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>

              <div className="cart-checkout">
                <button className="button secondary" type="button" onClick={clearCart}>
                  {messages.actions.remove}
                </button>
                <button className="button primary" type="button" onClick={() => void checkoutCart()}>
                  {messages.actions.checkoutCart(
                    formatBuyerMoney(totalAmountMinor, cartProducts[0]?.currency ?? product.currency, locale),
                  )}
                </button>
              </div>
            </>
          ) : (
            <div className="cart-empty">
              <strong>{messages.cart.emptyDrawerTitle}</strong>
              <p className="muted">{messages.cart.emptyDrawerBody}</p>
            </div>
          )}
        </div>
      </div>

      <article className="panel product-hero">
        <div className="product-image-wrapper">
          <img className="product-image" src={product.image.src} alt={localized.image.alt} />
        </div>
        <div className="product-hero-copy">
          <p className="eyebrow">{messages.productEyebrow}</p>
          <h1>{localized.name}</h1>
          <p className="muted">{localized.summary}</p>
          <p className="muted">{localized.checkoutNote}</p>
          <strong>{formatBuyerMoney(product.priceAmountMinor, product.currency, locale)}</strong>
          <p className="muted">{messages.productInventoryAvailable(product.available)}</p>
          <div className="purchase-controls">
            <div className="quantity-panel">
              <span className="quantity-label">{messages.quantityLabel}</span>
              <div className="quantity-stepper">
                <button
                  className="quantity-button"
                  type="button"
                  disabled={quantity <= 1}
                  onClick={() => setQuantity((current) => clampQuantity(current - 1, maxQuantity))}
                >
                  −
                </button>
                <strong className="quantity-value">{quantity}</strong>
                <button
                  className="quantity-button"
                  type="button"
                  disabled={quantity >= maxQuantity}
                  onClick={() => setQuantity((current) => clampQuantity(current + 1, maxQuantity))}
                >
                  +
                </button>
              </div>
              <span className="muted quantity-hint">{messages.productInventoryAvailable(product.available)}</span>
            </div>
            <div className="purchase-actions">
              <button className="button secondary" type="button" onClick={addCurrentProductToCart}>
                {messages.actions.addToCart}
              </button>
              <button className="button primary" type="button" onClick={buyNow}>
                {messages.actions.buyNow}
              </button>
            </div>
          </div>
          {status ? <div className="checkout-demo-status polling">{status}</div> : null}
        </div>
      </article>
    </section>
  );

  async function checkoutCart() {
    if (cartCheckoutItems.length === 0) {
      return;
    }

    setStatus(messages.checkout.submitting);
    try {
      const body = await createBuyIntent(cartCheckoutItems);
      setStatus(messages.checkout.accepted);

      const commandStatus = await waitForBuyIntentCommandStatus(body.commandId);
      if (commandStatus.status === "failed" || !commandStatus.checkoutIntentId) {
        throw new Error(commandStatus.failureMessage ?? commandStatus.failureCode ?? messages.checkout.failed);
      }

      setStatus(messages.checkout.completing);
      await waitForCheckoutIntentProjection(commandStatus.checkoutIntentId);
      await completeDemoCheckout(commandStatus.checkoutIntentId);
      await processProjections();
      await waitForCheckoutStatus(commandStatus.checkoutIntentId);
      clearCart();
      await navigate({
        to: "/checkout-complete/$checkoutIntentId",
        params: { checkoutIntentId: commandStatus.checkoutIntentId },
        search: { commandId: commandStatus.commandId },
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : messages.checkout.failed);
    }
  }
}

function CheckoutCompleteScreen() {
  const { checkoutIntentId } = useParams({ from: "/checkout-complete/$checkoutIntentId" });
  const search = checkoutCompleteRoute.useSearch() as { commandId?: string };
  const { locale, messages } = useBuyerLocaleContext();
  const checkoutQuery = useQuery({
    queryKey: ["checkout-complete", checkoutIntentId],
    queryFn: () => requestJson<CheckoutCompleteResponse>(`/api/checkout-complete/${checkoutIntentId}`, { method: "GET" }),
    refetchInterval: 3_000,
  });

  if (checkoutQuery.isLoading) {
    return <section className="panel">Loading checkout…</section>;
  }

  if (checkoutQuery.isError || !checkoutQuery.data) {
    return <section className="panel">Failed to load checkout.</section>;
  }

  const checkout = checkoutQuery.data;
  const commandId = checkout.commandId ?? search.commandId ?? messages.completion.notAvailable;

  return (
    <section className="panel checkout-complete-panel">
      <p className="eyebrow">{messages.completion.eyebrow}</p>
      <h1>{checkout.status === "confirmed" ? messages.completion.completeTitle : messages.completion.receivedTitle}</h1>
      <p className="muted">{messages.completion.subtitle(checkout.checkoutIntentId, checkout.status)}</p>
      <div className="completion-grid">
        <span className="completion-metric">
          <strong>{messages.completion.metrics.status}</strong>
          <code>{checkout.status}</code>
        </span>
        <span className="completion-metric">
          <strong>{messages.completion.metrics.command}</strong>
          <code>{commandId}</code>
        </span>
        <span className="completion-metric">
          <strong>{messages.completion.metrics.commandStatus}</strong>
          <code>{checkout.commandStatus ?? messages.completion.notAvailable}</code>
        </span>
        <span className="completion-metric">
          <strong>{messages.completion.metrics.order}</strong>
          <code>{checkout.orderId ?? messages.completion.notAvailable}</code>
        </span>
        <span className="completion-metric">
          <strong>{messages.completion.metrics.payment}</strong>
          <code>{checkout.paymentId ?? messages.completion.notAvailable}</code>
        </span>
        <span className="completion-metric">
          <strong>{messages.completion.metrics.updated}</strong>
          <code>{formatBuyerDateTime(checkout.updatedAt, locale)}</code>
        </span>
      </div>
    </section>
  );
}

type LiveAdminDashboard = AdminDashboardViewModel & {
  refreshedAt: string;
};

function AdminScreen() {
  const dashboardQuery = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: () => requestJson<LiveAdminDashboard>("/api/internal/admin/dashboard", { method: "GET" }),
    refetchInterval: 1_000,
  });
  const [stockInputs, setStockInputs] = useState<Record<string, string>>({});
  const [savingSkuId, setSavingSkuId] = useState<string | null>(null);

  useEffect(() => {
    if (!dashboardQuery.data) {
      return;
    }

    setStockInputs((current) => ({
      ...Object.fromEntries(
        dashboardQuery.data.products.map((row) => [
          row.skuId,
          current[row.skuId] ?? String(row.seckillStockLimit ?? row.seckillDefaultStock ?? ""),
        ]),
      ),
    }));
  }, [dashboardQuery.data]);

  if (dashboardQuery.isLoading) {
    return <section className="panel">Loading admin dashboard…</section>;
  }

  if (dashboardQuery.isError || !dashboardQuery.data) {
    return <section className="panel">Failed to load admin dashboard.</section>;
  }

  async function updateSeckill(skuId: string, enabled: boolean) {
    setSavingSkuId(skuId);
    try {
      await requestJson<{ ok: boolean }>("/api/internal/admin/seckill", {
        method: "POST",
        body: JSON.stringify({
          skuId,
          enabled,
          stockLimit: enabled ? Number(stockInputs[skuId] || 0) : null,
        }),
      });
      await dashboardQuery.refetch();
    } finally {
      setSavingSkuId(null);
    }
  }

  return (
    <>
      <section className="catalog-hero">
        <p className="eyebrow">Internal admin</p>
        <h1>Projection status</h1>
        <p className="muted hero-copy">Go backend API driven admin dashboard.</p>
      </section>
      <section className="admin-livebar" aria-label="Admin dashboard live status">
        <div>
          <p className="eyebrow">Live projection dashboard</p>
          <strong>Polling every second</strong>
          <p className="muted admin-livebar-copy">Last refresh {dashboardQuery.data.refreshedAt}</p>
        </div>
        <span className="badge neutral">realtime polling</span>
      </section>
      <section className="admin-product-grid" aria-label="Product projection cards">
        {dashboardQuery.data.products.map((row) => (
          <article className="admin-product-card" key={row.skuId}>
            <div className="admin-product-card-header">
              <div>
                <p className="eyebrow">{row.productStatus}</p>
                <h2>{row.productName}</h2>
                <p className="muted admin-product-copy">
                  {row.skuCode} · {row.skuId}
                </p>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <span className="badge neutral">{row.skuStatus}</span>
                {row.seckillCandidate ? <span className="badge neutral">seckill candidate</span> : null}
                {row.seckillEnabled ? <span className="badge warning">秒殺活動</span> : null}
              </div>
            </div>
            <div className="admin-counter-grid">
              <Metric label="on_hand" value={row.onHand} />
              <Metric label="reserved" value={row.reserved} tone="warning" />
              <Metric label="sold" value={row.sold} tone="success" />
              <Metric label="available" value={row.available} tone="strong" />
            </div>
            {row.seckillCandidate ? (
              <form
                className="admin-product-footer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void updateSeckill(row.skuId, true);
                }}
              >
                <label style={{ display: "grid", gap: "0.35rem" }}>
                  <strong>活動 stock</strong>
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={stockInputs[row.skuId] ?? ""}
                    onChange={(event) =>
                      setStockInputs((current) => ({
                        ...current,
                        [row.skuId]: event.target.value,
                      }))
                    }
                    disabled={savingSkuId === row.skuId}
                  />
                </label>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "end" }}>
                  <button className="button primary" type="submit" disabled={savingSkuId === row.skuId}>
                    開始秒殺
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={savingSkuId === row.skuId || !row.seckillEnabled}
                    onClick={() => void updateSeckill(row.skuId, false)}
                  >
                    停止秒殺
                  </button>
                </div>
              </form>
            ) : null}
          </article>
        ))}
      </section>
    </>
  );
}

function DesignSystemPreviewNavbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [cartCount, setCartCount] = useState(2);
  const [activePanel, setActivePanel] = useState<"dev" | "profile" | null>(null);
  const devItems = ["Design System", "Admin", "Products"] as const;

  function toggleDevMenu() {
    setMenuOpen((current) => !current);
    setActivePanel((current) => (current === "dev" ? null : "dev"));
  }

  function toggleProfile() {
    setActivePanel((current) => (current === "profile" ? null : "profile"));
    setMenuOpen(false);
  }

  return (
    <div className="design-preview design-preview-navbar interactive">
      <span className="design-preview-brand">Products</span>
      <div className="design-preview-nav-actions">
        <button
          className={`design-preview-pill buttonlike${menuOpen ? " active" : ""}`}
          onClick={toggleDevMenu}
          type="button"
        >
          Dev
        </button>
        <button
          className="design-preview-cart buttonlike"
          onClick={() => setCartCount((current) => (current % 4) + 1)}
          type="button"
        >
          <span className="design-preview-cart-icon" />
          <span className="design-preview-cart-badge">{cartCount}</span>
        </button>
        <button
          className={`design-preview-avatar buttonlike${activePanel === "profile" ? " active" : ""}`}
          onClick={toggleProfile}
          type="button"
        >
          U
        </button>
      </div>
      {activePanel === "dev" ? (
        <div className="design-preview-popout design-preview-popout-dev">
          {devItems.map((item) => (
            <button key={item} className="design-preview-popover-item" type="button">
              {item}
            </button>
          ))}
        </div>
      ) : null}
      {activePanel === "profile" ? (
        <div className="design-preview-popout design-preview-popout-profile">
          <span className="design-preview-popout-label">Profile quick settings</span>
          <button className="design-preview-pill buttonlike active" type="button">
            zh-TW
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DesignSystemPreviewButtons() {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!loading) {
      return;
    }
    const timeout = window.setTimeout(() => setLoading(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [loading]);

  return (
    <div className="design-preview design-preview-actions">
      <button className="design-preview-button primary" onClick={() => setLoading(true)} type="button">
        {loading ? "Processing" : "Checkout"}
      </button>
      <button className="design-preview-button secondary" type="button">
        Add to cart
      </button>
    </div>
  );
}

function DesignSystemPreviewSpinner() {
  const [loading, setLoading] = useState(true);

  return (
    <button
      className="design-preview design-preview-spinner-wrap interactive"
      onClick={() => setLoading((current) => !current)}
      type="button"
    >
      {loading ? <span className="design-preview-spinner" /> : <span className="design-preview-spinner-done">✓</span>}
      <span className="design-preview-spinner-copy">
        {loading ? "Processing projection update" : "Projection update complete"}
      </span>
    </button>
  );
}

function DesignSystemPreviewSwitch() {
  const [checked, setChecked] = useState(true);

  return (
    <button
      aria-checked={checked}
      className="design-preview design-preview-switch-row interactive"
      onClick={() => setChecked((current) => !current)}
      role="switch"
      type="button"
    >
      <span className="design-preview-switch-label">Reduced motion</span>
      <span className={`design-preview-switch${checked ? " on" : ""}`} aria-hidden="true">
        <span className="design-preview-switch-thumb" />
      </span>
    </button>
  );
}

function DesignSystemPreviewBadges() {
  const states = ["queued", "confirmed", "lagging"] as const;
  const [active, setActive] = useState<(typeof states)[number]>("confirmed");

  return (
    <div className="design-preview design-preview-badge-row interactive">
      {states.map((state) => (
        <button
          key={state}
          className={`design-preview-badge-chip${active === state ? " active" : ""} ${state}`}
          onClick={() => setActive(state)}
          type="button"
        >
          {state}
        </button>
      ))}
    </div>
  );
}

function DesignSystemPreviewMenu() {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState("Design System");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const items = ["Design System", "Admin", "Products"] as const;

  return (
    <div className="design-preview design-preview-menu interactive" ref={menuRef}>
      <button
        className={`design-preview-pill buttonlike${open ? " active" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        Dev
      </button>
      {open ? (
        <div className="design-preview-popover">
          {items.map((item) => (
            <button
              key={item}
              className={`design-preview-popover-item${selected === item ? " active" : ""}`}
              onClick={() => setSelected(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>
      ) : (
        <div className="design-preview-menu-closed">Tap Dev to open menu</div>
      )}
    </div>
  );
}

function DesignSystemPreviewCartMotion() {
  const [open, setOpen] = useState(false);

  return (
    <div className="design-preview design-preview-cart-motion interactive">
      <div className={`design-preview-cart-scene${open ? " is-open" : ""}`}>
        <button
          className={`design-preview-cart-header${open ? " is-open" : ""}`}
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <span className="design-preview-cart-header-copy">
            <strong>Cart</strong>
            <span>3 items · 2 SKUs</span>
          </span>
          <strong>TWD 1,520</strong>
        </button>
        <div
          className={`design-preview-cart-scene-backdrop${open ? " visible" : ""}`}
          onClick={() => setOpen(false)}
          role="presentation"
        />
        <div className={`design-preview-cart-scene-drawer${open ? " visible" : ""}`}>
          <span className="design-preview-popout-label">Cart checkout</span>
          <strong>Review items</strong>
          <div className="design-preview-cart-line">
            <span>Everyday Tee</span>
            <span>TWD 680</span>
          </div>
          <div className="design-preview-cart-line">
            <span>Travel Cap</span>
            <span>TWD 840</span>
          </div>
        </div>
      </div>
      <span className="design-preview-motion-note">Tap the cart to preview backdrop blur and drawer easing.</span>
    </div>
  );
}

function DesignSystemScreen() {
  const sections = [
    {
      eyebrow: "Navigation",
      title: "Toolbar, profile, and developer entry points",
      description: "The floating Dev menu should stay available in local runtime and the toolbar stays intentionally light.",
      preview: <DesignSystemPreviewNavbar />,
    },
    {
      eyebrow: "Actions",
      title: "Primary and secondary action hierarchy",
      description: "One durable primary CTA, one quieter secondary CTA, and no unnecessary accent overload.",
      preview: <DesignSystemPreviewButtons />,
    },
    {
      eyebrow: "Loading",
      title: "Async state motion",
      description: "Loading motion should be visible while work is active and stop immediately when source-backed status lands.",
      preview: <DesignSystemPreviewSpinner />,
    },
    {
      eyebrow: "Toggle",
      title: "Binary switch behavior",
      description: "Settings that are truly boolean should use switch semantics, not fake segmented controls.",
      preview: <DesignSystemPreviewSwitch />,
    },
    {
      eyebrow: "Status",
      title: "Badge semantics",
      description: "Queued, confirmed, and lagging states should use consistent semantic token families.",
      preview: <DesignSystemPreviewBadges />,
    },
    {
      eyebrow: "Overlay",
      title: "Developer and utility menus",
      description: "Developer shortcuts should live in a quiet overlay instead of taking permanent toolbar space.",
      preview: <DesignSystemPreviewMenu />,
    },
    {
      eyebrow: "Motion",
      title: "Cart drawer behavior",
      description: "Cart drawer, popover, and profile overlays should share the same easing family and anchored origin.",
      preview: <DesignSystemPreviewCartMotion />,
    },
  ];

  return (
    <>
      <section className="catalog-hero">
        <p className="eyebrow">Internal design system</p>
        <h1>Minishop UI system</h1>
        <p className="muted hero-copy">
          Internal reference for tokens, motion, overlays, and buyer-facing interaction patterns after the buyer-web migration.
        </p>
      </section>
      <section className="admin-livebar" aria-label="Design system summary">
        <div>
          <p className="eyebrow">Primary direction</p>
          <strong>Warm commerce accent on quiet neutral surfaces</strong>
          <p className="muted admin-livebar-copy">
            Buyer UI should stay product-first, with restrained chrome and predictable interaction patterns.
          </p>
        </div>
        <span className="badge neutral">v1 internal reference</span>
      </section>
      <section className="design-system-grid" aria-label="Design system preview catalog">
        {sections.map((section) => (
          <article className="panel design-system-panel" key={section.title}>
            <div className="design-system-heading">
              <p className="eyebrow">{section.eyebrow}</p>
              <h2>{section.title}</h2>
              <p className="muted">{section.description}</p>
            </div>
            {section.preview}
          </article>
        ))}
      </section>
    </>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number | null;
  tone?: "neutral" | "warning" | "success" | "strong";
}) {
  return (
    <span className={`metric-card ${tone}`}>
      <strong>{label}</strong>
      <code>{value ?? "n/a"}</code>
    </span>
  );
}

async function processProjections() {
  const response = await fetch(buildApiUrl("/api/internal/projections/process"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      projectionName: "main",
      batchSize: 100,
    }),
  });

  if (response.status === 409) {
    return;
  }

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function createBuyIntent(items: CheckoutActionItem[]) {
  const idempotencyKey = crypto.randomUUID();
  const response = await fetch(buildApiUrl("/api/buy-intents"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      buyerId: "demo_buyer",
      items,
    }),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as { commandId: string };
}

async function waitForBuyIntentCommandStatus(commandId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(buildApiUrl(`/api/buy-intent-commands/${commandId}`), { cache: "no-store" });
    if (response.status === 404) {
      await sleep(250);
      continue;
    }
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const body = (await response.json()) as BuyIntentCommandStatusResponse;
    if (body.status === "created" || body.status === "failed") {
      return body;
    }
    await sleep(250);
  }
  throw new Error("Buy intent command did not complete in time.");
}

async function waitForCheckoutIntentProjection(checkoutIntentId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await processProjections();
    const response = await fetch(buildApiUrl(`/api/checkout-intents/${checkoutIntentId}`), { cache: "no-store" });
    if (response.ok) {
      return;
    }
    if (response.status !== 404) {
      throw new Error(await readError(response));
    }
    await sleep(250);
  }
  throw new Error("Checkout intent projection did not become available in time.");
}

async function completeDemoCheckout(checkoutIntentId: string) {
  const response = await fetch(buildApiUrl(`/api/internal/checkout-intents/${checkoutIntentId}/complete-demo`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

function hasCheckoutReachedDisplayState(status: string) {
  return status !== "queued" && status !== "reserving";
}

async function waitForCheckoutStatus(checkoutIntentId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await processProjections();
    const response = await fetch(buildApiUrl(`/api/checkout-intents/${checkoutIntentId}`), { cache: "no-store" });
    if (response.ok) {
      const body = (await response.json()) as CheckoutStatusResponse;
      if (hasCheckoutReachedDisplayState(body.status)) {
        return body;
      }
    }
    await sleep(250);
  }
  throw new Error("Checkout intent did not finish progressing in time.");
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function readError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: string; requestId?: string } | null;
  const message = body?.error ?? `Request failed with ${response.status}.`;
  return body?.requestId ? `${message} Reference: ${body.requestId}` : message;
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
        return [{ quantity, slug }];
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
