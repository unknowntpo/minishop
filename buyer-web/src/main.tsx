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

function BuyerLocaleSwitcher() {
  const { locale, messages, setLocale } = useBuyerLocaleContext();
  const isEnglish = locale === "en";

  return (
    <button
      aria-checked={isEnglish}
      aria-label={messages.localeLabel}
      className={`buyer-locale-switcher${isEnglish ? " is-en" : " is-zh"}`}
      onClick={() => setLocale(isEnglish ? "zh-TW" : "en")}
      role="switch"
      type="button"
    >
      <span className="buyer-locale-thumb" aria-hidden="true" />
      <span className="buyer-locale-option zh">{messages.localeOption["zh-TW"]}</span>
      <span className="buyer-locale-option en">{messages.localeOption.en}</span>
    </button>
  );
}

function BuyerProfileMenu() {
  const { messages } = useBuyerLocaleContext();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [renderPanel, setRenderPanel] = useState(false);

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

  return (
    <div className="buyer-profile-menu" ref={menuRef}>
      <button
        aria-expanded={open}
        aria-label={messages.profile.triggerLabel}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="buyer-profile-avatar" aria-hidden="true">
          U
        </span>
      </button>
      {renderPanel ? (
        <div className={`buyer-profile-panel${open ? " visible" : ""}`}>
          <p className="buyer-profile-title">{messages.profile.panelTitle}</p>
          <BuyerLocaleSwitcher />
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
  const products = React.useMemo(() => sortBuyerProducts(productsQuery.data ?? []), [productsQuery.data]);
  const productBySlug = React.useMemo(
    () => new Map(products.map((catalogProduct) => [catalogProduct.slug, catalogProduct])),
    [products],
  );
  const [cartEntries, setCartEntries] = useState<CartEntry[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
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

  if (productsQuery.isLoading) {
    return <section className="panel">Loading products…</section>;
  }

  if (productsQuery.isError || !productsQuery.data) {
    return <section className="panel">Failed to load products.</section>;
  }

  return (
    <>
      <div className="buyer-toolbar">
        <span className="buyer-toolbar-label">{messages.navProducts}</span>
        <div className="buyer-toolbar-actions">
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

                  {checkoutProduct ? (
                    <div className="cart-checkout">
                      <button className="button secondary" type="button" onClick={clearCart}>
                        {messages.actions.remove}
                      </button>
                      <button className="button primary" type="button" onClick={() => void checkoutCart()}>
                        {messages.actions.checkoutCart(
                          formatBuyerMoney(
                            totalAmountMinor,
                            cartProducts[0]?.currency ?? checkoutProduct.currency,
                            locale,
                          ),
                        )}
                      </button>
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

      <div className="product-grid">
        {products.map((product) => {
          const localized = getLocalizedProduct(product, locale);
          return (
            <Link className="product-card" key={product.slug} to="/products/$slug" params={{ slug: product.slug }}>
              <span className="product-card-media">
                <img src={product.image.src} alt={localized.image.alt} />
              </span>
              <span className="product-card-body">
                <span>
                  <span className="product-card-title">
                    {localized.name}
                    {product.seckill?.enabled ? (
                      <span className="badge warning">{messages.catalogSeckillTag}</span>
                    ) : null}
                  </span>
                  <span className="muted">{localized.summary}</span>
                </span>
                <span className="product-card-meta">
                  <span>{formatBuyerMoney(product.priceAmountMinor, product.currency, locale)}</span>
                  <span className="badge neutral">{messages.catalogAvailable(product.available)}</span>
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );

  async function checkoutCart() {
    if (cartCheckoutItems.length === 0) {
      return;
    }

    const body = await createBuyIntent(cartCheckoutItems);
    const commandStatus = await waitForBuyIntentCommandStatus(body.commandId);
    if (commandStatus.status === "failed" || !commandStatus.checkoutIntentId) {
      throw new Error(commandStatus.failureMessage ?? commandStatus.failureCode ?? messages.checkout.failed);
    }
    await waitForCheckoutIntentProjection(commandStatus.checkoutIntentId);
    await completeDemoCheckout(commandStatus.checkoutIntentId);
    await processProjections();
    await waitForCheckoutStatus(commandStatus.checkoutIntentId);
    clearCart();
    window.location.assign(`/checkout-complete/${commandStatus.checkoutIntentId}?commandId=${commandStatus.commandId}`);
  }
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
  const maxDirectQuantity = maxQuantityFor(product);
  const isOutOfStock = maxDirectQuantity <= 0;

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
    <>
      <div className="buyer-toolbar">
        <Link className="text-link" to="/products">
          {messages.navProducts}
        </Link>
        <div className="buyer-toolbar-actions">
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
          <BuyerProfileMenu />
        </div>
      </div>

      <section className="product-layout" aria-labelledby="product-title">
        <div className="product-media">
          <img src={localized.image.src} alt={localized.image.alt} />
        </div>

        <div className="purchase-stack">
          <section className="panel purchase-panel">
            <p className="eyebrow">{messages.productEyebrow}</p>
            <h1 id="product-title">
              {localized.name}
              {product.seckill?.enabled ? (
                <span className="badge warning">{messages.catalogSeckillTag}</span>
              ) : null}
            </h1>
            <p className="muted">
              SKU {product.skuCode} · {localized.checkoutNote}
            </p>
            <div className="price">{formatBuyerMoney(product.priceAmountMinor, product.currency, locale)}</div>
            <div className="inventory-row">
              <div>
                <strong>{messages.productInventoryAvailable(product.available)}</strong>
                <p className="muted">
                  {isOutOfStock ? messages.productInventoryState.soldOut : messages.productInventoryState.inStock}
                </p>
              </div>
              <span className="badge neutral">{messages.productInventoryState.projection}</span>
            </div>

            <div className="purchase-controls">
              <div className="quantity-panel">
                <span className="quantity-label">{messages.quantityLabel}</span>
                <div className="quantity-stepper">
                  <button
                    className="quantity-button"
                    type="button"
                    disabled={quantity <= 1}
                    onClick={() => setQuantity((current) => clampQuantity(current - 1, maxDirectQuantity))}
                  >
                    −
                  </button>
                  <strong className="quantity-value">{quantity}</strong>
                  <button
                    className="quantity-button"
                    type="button"
                    disabled={quantity >= maxDirectQuantity}
                    onClick={() => setQuantity((current) => clampQuantity(current + 1, maxDirectQuantity))}
                  >
                    +
                  </button>
                </div>
                <span className="muted quantity-hint">
                  {isOutOfStock ? messages.quantityHint.none : messages.quantityHint.max(maxDirectQuantity)}
                </span>
              </div>

              <div className="purchase-actions">
                <button className="button secondary" type="button" disabled={isOutOfStock} onClick={addCurrentProductToCart}>
                  {messages.actions.addToCart}
                </button>
                <button className="button primary" type="button" disabled={isOutOfStock} onClick={buyNow}>
                  {isOutOfStock ? messages.actions.soldOut : messages.actions.buyNow}
                </button>
              </div>
            </div>

            <p className="fine-print">{messages.finePrint}</p>
            <OperatorStrip product={product} />
            {status ? <div className="checkout-demo-status polling">{status}</div> : null}
          </section>
        </div>
      </section>

      <button
        aria-hidden={!cartOpen}
        className={`cart-backdrop${cartOpen ? " visible" : ""}`}
        onClick={() => setCartOpen(false)}
        tabIndex={cartOpen ? 0 : -1}
        type="button"
      />
    </>
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

function OperatorStrip({ product }: { product: Product }) {
  if (!shouldShowDevMenu() || !product.inventory) {
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

const shopifyRefs = {
  overview: "https://shopify.dev/docs/api/app-home/web-components",
  avatar: "https://shopify.dev/docs/api/app-home/web-components/media-and-visuals/avatar",
  badge: "https://shopify.dev/docs/api/app-home/web-components/feedback-and-status-indicators/badge",
  button: "https://shopify.dev/docs/api/app-home/web-components/actions/button",
  menu: "https://shopify.dev/docs/api/app-home/web-components/actions/menu",
  page: "https://shopify.dev/docs/api/app-home/web-components/layout-and-structure/page",
  popover: "https://shopify.dev/docs/api/app-home/web-components/overlays/popover",
  spinner:
    "https://shopify.dev/docs/api/app-home/web-components/feedback-and-status-indicators/spinner",
  switch: "https://shopify.dev/docs/api/app-home/web-components/forms/switch",
} as const;

const colorFamilies = [
  {
    name: "Neutral",
    role: "Canvas, surface, borders, body text",
    tokens: [
      { name: "--ms-canvas", value: "#f8f7f4" },
      { name: "--ms-surface", value: "#ffffff" },
      { name: "--ms-subtle", value: "#f1f0ec" },
      { name: "--ms-line-soft", value: "#ebe7df" },
      { name: "--ms-line", value: "#ded9d0" },
      { name: "--ms-muted", value: "#6b625a" },
      { name: "--ms-ink", value: "#1f1b17" },
    ],
  },
  {
    name: "Primary Accent",
    role: "Commerce emphasis, eyebrows, price, buyer highlights",
    tokens: [
      { name: "--ms-accent-100", value: "#f6dfda" },
      { name: "--ms-accent-300", value: "#e8b7ab" },
      { name: "--ms-accent-500", value: "#c9755f" },
      { name: "--ms-accent", value: "#b75f4b" },
      { name: "--ms-accent-900", value: "#6f3124" },
    ],
  },
  {
    name: "Secondary Status",
    role: "Info, success, warning, diagnostics",
    tokens: [
      { name: "--ms-blue-100", value: "#dce8fb" },
      { name: "--ms-blue", value: "#2f6fd6" },
      { name: "--ms-green-100", value: "#e8f4ed" },
      { name: "--ms-green", value: "#2f8f5b" },
      { name: "--ms-warn-100", value: "#fff1df" },
      { name: "--ms-warn", value: "#c77a25" },
    ],
  },
] as const;

const tokenRules = [
  { level: "50 / 100", usage: "Subtle backgrounds, soft fills, empty states, non-blocking emphasis." },
  { level: "300", usage: "Borders, dividers, input outlines, quiet controls." },
  { level: "500 / 600", usage: "Primary controls, links, active badges, stronger callouts." },
  { level: "900 / 950", usage: "Text, icons, high-contrast states, durable labels." },
] as const;

const typeScale = [
  { role: "Display", token: "h1", size: "56px", usage: "Major page titles and critical buyer headings." },
  { role: "Section", token: "h2", size: "24px", usage: "Panel titles, section headers, dashboard blocks." },
  { role: "Price", token: ".price", size: "44px", usage: "Monetary emphasis for buyer-facing commerce surfaces." },
  { role: "Body", token: "body", size: "16px", usage: "Default reading copy, descriptions, detail rows." },
  { role: "Support", token: ".muted / .fine-print", size: "14px", usage: "Hints, secondary metadata, non-primary explanation." },
  { role: "Label", token: ".eyebrow / .badge", size: "13px", usage: "Category labels, state tags, compact UI labels." },
] as const;

const spacingAndShape = [
  { token: "--ms-radius", value: "8px", usage: "Base cards, inputs, badges, buttons." },
  { token: "--ms-radius-lg", value: "16px", usage: "Larger panels and grouped surfaces." },
  { token: "--ms-radius-overlay", value: "22px", usage: "Drawer, dropdown, floating overlay surfaces." },
  { token: "--ms-shadow", value: "0 18px 52px rgba(31, 27, 23, 0.12)", usage: "Elevated media and floating surfaces only." },
] as const;

const motionTokens = [
  { token: "--ms-ease-standard", value: "cubic-bezier(0.2, 0, 0, 1)", usage: "Default control hover and small state changes." },
  { token: "--ms-ease-emphasized", value: "cubic-bezier(0.22, 1, 0.36, 1)", usage: "Drawer, popout, and focus transitions that should feel smoother and more intentional." },
  { token: "--ms-ease-exit", value: "cubic-bezier(0.4, 0, 1, 1)", usage: "Fast fade/exit when elements should leave without drag." },
  { token: "--ms-duration-fast", value: "140ms", usage: "Tiny state changes and chips." },
  { token: "--ms-duration-medium", value: "220ms", usage: "Buttons, hover, compact drawers, blur transitions." },
  { token: "--ms-duration-slow", value: "320ms", usage: "Panel settle, backdrop blending, larger overlays." },
] as const;

const breakpoints = [
  { name: "Phone", range: "0-639px", behavior: "Single-column content, compact nav, overlays stay narrow, controls avoid blocky wrappers." },
  { name: "Tablet", range: "640-1023px", behavior: "Two-column grids where helpful, toolbar stays light, drawers remain anchored to trigger." },
  { name: "Desktop", range: "1024-1439px", behavior: "Buyer product layout can split media and purchase panels, internal dashboards may use 3-column summaries." },
  { name: "Wide Desktop", range: "1440px+", behavior: "More breathing room, denser admin/benchmark comparisons, no viewport-scaled typography jumps." },
] as const;

const i18nRules = [
  "Buyer-facing surfaces support `zh-TW` and `en`; internal admin and benchmark surfaces stay English-only unless a change explicitly expands scope.",
  "Translatable buyer copy must resolve through shared message dictionaries instead of hard-coded component strings.",
  "Typography and spacing should assume Traditional Chinese and English copy both appear in the same product, especially button labels, drawer rows, and toasts.",
  "Locale selection is a buyer preference, not a global admin setting; it must persist across buyer pages without leaking into internal operator surfaces.",
] as const;

const componentRules = [
  { title: "Primary action", detail: "Use dark ink fill for the default durable action. Reserve accent color for price and contextual emphasis, not every CTA." },
  { title: "Secondary action", detail: "Use bordered surface buttons for additive or reversible actions such as add-to-cart, filters, or preview actions." },
  { title: "Status surfaces", detail: "Communicate truth from projections or source-backed state. Do not imply success before the underlying status confirms it." },
  { title: "Internal tools", detail: "Admin, benchmark, and future design-system pages use the same quiet internal visual language and should remain separate from buyer flow styling." },
  { title: "Overlay motion", detail: "Cart drawers, profile panels, and utility menus should share the same anchored overlay motion: top-right origin, emphasized scale/translate on enter, and matching exit timing." },
] as const;

const componentCatalog = [
  {
    name: "Navigation bar",
    pattern: "Use a lightweight page toolbar pattern, not a heavy app header card.",
    preview: "navbar",
    refs: [
      { label: "Page", href: shopifyRefs.page },
      { label: "Menu", href: shopifyRefs.menu },
      { label: "Popover", href: shopifyRefs.popover },
      { label: "Avatar", href: shopifyRefs.avatar },
      { label: "Button", href: shopifyRefs.button },
    ],
  },
  { name: "Primary action button", pattern: "One durable primary action per area, loading-aware, with secondary actions visually quieter.", preview: "button", refs: [{ label: "Button", href: shopifyRefs.button }] },
  { name: "Spinner / loading", pattern: "Show motion only during active async work and stop immediately when source-backed or projection-backed status arrives.", preview: "spinner", refs: [{ label: "Spinner", href: shopifyRefs.spinner }] },
  { name: "Toggle / switch", pattern: "Binary settings use a switch; buyer locale choice remains segmented because it is a small explicit mode choice, not a single boolean flag.", preview: "switch", refs: [{ label: "Switch", href: shopifyRefs.switch }] },
  { name: "Status badge", pattern: "Use badges for compact status and diagnostics, with semantic token families rather than arbitrary colors.", preview: "badge", refs: [{ label: "Badge", href: shopifyRefs.badge }] },
  {
    name: "Overflow / utility menu",
    pattern: "Developer-only and operator shortcuts should live in a quiet menu instead of adding more persistent navbar chrome, and should use the same overlay motion family as cart and profile surfaces.",
    preview: "menu",
    refs: [
      { label: "Menu", href: shopifyRefs.menu },
      { label: "Popover", href: shopifyRefs.popover },
    ],
  },
  {
    name: "Cart drawer motion",
    pattern: "Floating panels use one overlay motion family: anchored to the trigger, top-right transform origin, emphasized enter, and matching exit timing across cart, profile, and utility popovers.",
    preview: "cart-motion",
    refs: [
      { label: "Popover", href: shopifyRefs.popover },
      { label: "Page", href: shopifyRefs.page },
    ],
  },
] as const;

function renderComponentPreview(preview: (typeof componentCatalog)[number]["preview"]) {
  switch (preview) {
    case "navbar":
      return <DesignSystemPreviewNavbar />;
    case "button":
      return <DesignSystemPreviewButtons />;
    case "spinner":
      return <DesignSystemPreviewSpinner />;
    case "switch":
      return <DesignSystemPreviewSwitch />;
    case "badge":
      return <DesignSystemPreviewBadges />;
    case "menu":
      return <DesignSystemPreviewMenu />;
    case "cart-motion":
      return <DesignSystemPreviewCartMotion />;
    default:
      return null;
  }
}

function DesignSystemPreviewNavbar() {
  const [cartCount, setCartCount] = useState(2);

  return (
    <div className="design-preview design-preview-navbar interactive">
      <span className="design-preview-brand">Products</span>
      <div className="design-preview-nav-actions">
        <button
          className="design-preview-cart buttonlike"
          onClick={() => setCartCount((current) => (current % 4) + 1)}
          type="button"
        >
          <span className="design-preview-cart-icon" />
          <span className="design-preview-cart-badge">{cartCount}</span>
        </button>
        <button
          className="design-preview-avatar buttonlike"
          type="button"
        >
          U
        </button>
      </div>
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

  const items = ["Design System", "Benchmarks", "Admin"] as const;

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
  return (
    <>
      <nav className="admin-nav">
        <Link className="text-link" to="/products">
          Products
        </Link>
        <Link className="text-link" to="/internal/admin">
          Projection admin
        </Link>
        <a className="text-link" href="/internal/benchmarks">
          Benchmark results
        </a>
      </nav>

      <section className="catalog-hero">
        <p className="eyebrow">Internal design system</p>
        <h1>Minishop UI system</h1>
        <p className="muted hero-copy">
          Engineering-facing reference for color roles, semantic token weights, typography,
          breakpoints, shape rules, and bilingual UI behavior. This page exists so UI decisions are
          documented once instead of being rediscovered in CSS or fixed one component at a time.
        </p>
        <p className="muted hero-copy">
          This system is Minishop-owned. The visual direction, previews, and token decisions should
          follow our current product language first. Shopify web components are reference material
          for interaction patterns only, not a visual source of truth.{" "}
          <a className="design-inline-link" href={shopifyRefs.overview} target="_blank" rel="noreferrer">
            Shopify web components overview
          </a>
        </p>
      </section>
      <section className="admin-livebar" aria-label="Design system summary">
        <div>
          <p className="eyebrow">Primary direction</p>
          <strong>Warm commerce accent on quiet neutral surfaces</strong>
          <p className="muted admin-livebar-copy">
            Buyer UI emphasizes product truth and checkout state; internal pages stay quieter and
            more diagnostic.
          </p>
        </div>
        <span className="badge neutral">v1 internal reference</span>
      </section>
      <div className="design-system-grid">
        <section className="panel design-system-panel" aria-labelledby="color-title">
          <div className="design-system-heading">
            <p className="eyebrow">Color</p>
            <h2 id="color-title">Primary and secondary color system</h2>
            <p className="muted">
              Minishop owns the visual system here: warm commerce accent, quiet neutral surfaces,
              restrained status colors, and no forced Shopify look.
            </p>
          </div>
          <div className="design-family-grid">
            {colorFamilies.map((family) => (
              <article className="design-family-card" key={family.name}>
                <div className="design-family-copy">
                  <strong>{family.name}</strong>
                  <p className="muted">{family.role}</p>
                </div>
                <div className="design-token-list">
                  {family.tokens.map((token) => (
                    <div className="design-token-row" key={token.name}>
                      <span className="design-swatch" style={{ background: token.value }} aria-hidden="true" />
                      <code>{token.name}</code>
                      <span>{token.value}</span>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="panel design-system-panel" aria-labelledby="token-title">
          <div className="design-system-heading">
            <p className="eyebrow">Token scale</p>
            <h2 id="token-title">Semantic token weight rules</h2>
          </div>
          <div className="design-rule-grid">
            {tokenRules.map((rule) => (
              <article className="design-rule-card" key={rule.level}>
                <strong>{rule.level}</strong>
                <p className="muted">{rule.usage}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel design-system-panel" aria-labelledby="type-title">
          <div className="design-system-heading">
            <p className="eyebrow">Typography</p>
            <h2 id="type-title">Font stack and type roles</h2>
          </div>
          <div className="design-kv-card">
            <strong>Font stack</strong>
            <code>
              Inter, system-ui, Segoe UI, Noto Sans TC, PingFang TC, Microsoft JhengHei, sans-serif
            </code>
          </div>
          <div className="design-type-grid">
            {typeScale.map((item) => (
              <article className="design-type-card" key={item.role}>
                <strong>{item.role}</strong>
                <code>{item.token}</code>
                <span>{item.size}</span>
                <p className="muted">{item.usage}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel design-system-panel" aria-labelledby="shape-title">
          <div className="design-system-heading">
            <p className="eyebrow">Shape</p>
            <h2 id="shape-title">Radius, shadow, and surface rules</h2>
          </div>
          <div className="design-shape-grid">
            {spacingAndShape.map((item) => (
              <article className="design-shape-card" key={item.token}>
                <strong>{item.token}</strong>
                <code>{item.value}</code>
                <p className="muted">{item.usage}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel design-system-panel" aria-labelledby="motion-title">
          <div className="design-system-heading">
            <p className="eyebrow">Motion</p>
            <h2 id="motion-title">Transition and easing rules</h2>
            <p className="muted">
              TODO: fine-tune buyer navbar motion. Current overlay behavior is functionally aligned
              across cart, profile, and utility menus, but the navbar-trigger motion still needs a
              more satisfying open/close feel before it should be treated as final.
            </p>
          </div>
          <div className="design-shape-grid">
            {motionTokens.map((item) => (
              <article className="design-shape-card" key={item.token}>
                <strong>{item.token}</strong>
                <code>{item.value}</code>
                <p className="muted">{item.usage}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel design-system-panel" aria-labelledby="breakpoint-title">
          <div className="design-system-heading">
            <p className="eyebrow">Responsive</p>
            <h2 id="breakpoint-title">Breakpoint behavior</h2>
          </div>
          <div className="design-breakpoint-grid">
            {breakpoints.map((breakpoint) => (
              <article className="design-breakpoint-card" key={breakpoint.name}>
                <strong>{breakpoint.name}</strong>
                <code>{breakpoint.range}</code>
                <p className="muted">{breakpoint.behavior}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel design-system-panel" aria-labelledby="i18n-title">
          <div className="design-system-heading">
            <p className="eyebrow">I18n</p>
            <h2 id="i18n-title">Bilingual UI rules</h2>
          </div>
          <ul className="design-list">
            {i18nRules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </section>

        <section className="panel design-system-panel" aria-labelledby="component-title">
          <div className="design-system-heading">
            <p className="eyebrow">Components</p>
            <h2 id="component-title">Interaction and state rules</h2>
          </div>
          <div className="design-rule-grid">
            {componentRules.map((rule) => (
              <article className="design-rule-card" key={rule.title}>
                <strong>{rule.title}</strong>
                <p className="muted">{rule.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel design-system-panel" aria-labelledby="catalog-title">
          <div className="design-system-heading">
            <p className="eyebrow">Reference catalog</p>
            <h2 id="catalog-title">Minishop component gallery with external refs</h2>
            <p className="muted">
              Every preview below should represent Minishop style first. External links are kept as
              implementation references only, not as a mandate to copy Shopify visuals.
            </p>
          </div>
          <div className="design-component-grid">
            {componentCatalog.map((component) => (
              <article className="design-component-card" key={component.name}>
                <div className="design-component-copy">
                  <strong>{component.name}</strong>
                  <p className="muted">{component.pattern}</p>
                </div>
                {renderComponentPreview(component.preview)}
                <div className="design-ref-links">
                  {component.refs.map((ref) => (
                    <a
                      key={`${component.name}-${ref.href}`}
                      className="design-ref-link"
                      href={ref.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {ref.label}
                    </a>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
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

function sortBuyerProducts(products: Product[]) {
  const displayOrder = new Map([
    ["everyday-tee", 0],
    ["travel-cap", 1],
    ["limited-runner", 2],
  ]);
  return [...products].sort((left, right) => {
    const leftRank = displayOrder.get(left.slug);
    const rightRank = displayOrder.get(right.slug);
    if (leftRank !== undefined || rightRank !== undefined) {
      return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
    }
    return left.slug.localeCompare(right.slug);
  });
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

function formatProjectionLag(projectionLagMs: number) {
  if (projectionLagMs < 1_000) {
    return `${projectionLagMs}ms`;
  }
  if (projectionLagMs < 60_000) {
    return `${Math.round(projectionLagMs / 1_000)}s`;
  }
  return `${Math.round(projectionLagMs / 60_000)}m`;
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
