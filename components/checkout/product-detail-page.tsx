import Image from "next/image";
import Link from "next/link";

import { CheckoutAction, type CheckoutActionItem } from "@/components/checkout/checkout-action";
import type { Product } from "@/src/domain/catalog/product";
import { formatProductPrice } from "@/src/presentation/view-models/product";

const cartCheckoutItems: CheckoutActionItem[] = [
  {
    skuId: "sku_hot_001",
    quantity: 1,
    unitPriceAmountMinor: 100000,
    currency: "TWD",
  },
  {
    skuId: "sku_tee_001",
    quantity: 2,
    unitPriceAmountMinor: 68000,
    currency: "TWD",
  },
  {
    skuId: "sku_cap_001",
    quantity: 1,
    unitPriceAmountMinor: 42000,
    currency: "TWD",
  },
];

export function ProductDetailPage({ product }: { product: Product }) {
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
            <p className="eyebrow">Direct Buy preview</p>
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
            <CheckoutAction product={product} />
            <p className="fine-print">
              This page does not decrement inventory after pressing Buy. Inventory changes only
              after projection refresh.
            </p>
            <OperatorStrip product={product} />
          </section>
        </div>
      </section>

      <details className="floating-cart">
        <summary aria-label="Cart checkout progress">
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
          <span className="cart-count" aria-hidden="true">
            3
          </span>
          <span className="cart-summary">
            <strong>Cart · 3 products</strong>
            <span className="muted">Reservation progress is available.</span>
          </span>
          <span className="badge warning cart-status">
            <span className="spinner small" aria-hidden="true" />
            processing
          </span>
        </summary>

        <div className="cart-drawer">
          <p className="eyebrow">Cart checkout</p>
          <h2>Checkout 3 products</h2>
          <p className="muted">
            One checkout intent reserves all cart SKUs together. Completion opens the checkout
            result page.
          </p>
          <CheckoutAction product={product} items={cartCheckoutItems} buttonLabel="Checkout cart" />
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
