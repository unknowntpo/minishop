import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRootRoute, createRoute, createRouter, Navigate, Outlet, Link, useNavigate, useParams } from "@tanstack/react-router";
import "../../app/globals.css";
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
import { useEffect, useState } from "react";
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

const queryClient = new QueryClient();
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() || "http://127.0.0.1:3005").replace(/\/+$/, "");

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

const routeTree = rootRoute.addChildren([indexRoute, productsRoute, productDetailRoute, checkoutCompleteRoute, adminRoute]);

const router = createRouter({
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const LocaleContext = React.createContext<ReturnType<typeof useBuyerLocaleState> | null>(null);

function useBuyerLocaleContext() {
  const value = React.useContext(LocaleContext);
  if (!value) {
    throw new Error("Locale context missing");
  }
  return value;
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
                <div className="product-image-wrapper">
                  <img className="product-image" src={product.image.src} alt={localized.image.alt} />
                </div>
                <div className="product-card-body">
                  <strong>{localized.name}</strong>
                  <p>{localized.summary}</p>
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

  useEffect(() => {
    setQuantity(1);
  }, [slug]);

  if (productQuery.isLoading) {
    return <section className="panel">Loading product…</section>;
  }

  if (productQuery.isError || !productQuery.data) {
    return <section className="panel">Failed to load product.</section>;
  }

  const product = productQuery.data;
  const localized = getLocalizedProduct(product, locale);
  const maxQuantity = Math.max(product.available, 1);

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
          <label className="quantity-control">
            <span>{messages.quantityLabel}</span>
            <input
              type="number"
              min={1}
              max={maxQuantity}
              value={quantity}
              onChange={(event) => setQuantity(Math.min(maxQuantity, Math.max(1, Number(event.target.value) || 1)))}
            />
          </label>
          <button className="button primary" type="button" onClick={buyNow}>
            {messages.actions.buyNow}
          </button>
          {status ? <div className="checkout-demo-status polling">{status}</div> : null}
        </div>
      </article>
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
