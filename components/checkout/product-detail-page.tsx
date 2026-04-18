import Image from "next/image";
import Link from "next/link";

import type { Product } from "@/src/domain/catalog/product";
import { formatProductPrice } from "@/src/presentation/view-models/product";

const cartItems = [
  {
    name: "Limited Runner",
    detail: "1 item · reservation requested",
    status: "processing",
  },
  {
    name: "Everyday Tee",
    detail: "2 items · inventory reserved",
    status: "reserved",
  },
  {
    name: "Travel Cap",
    detail: "1 item · waiting for projection update",
    status: "processing",
  },
];

const statusRows = [
  {
    title: "Request received",
    body: "Your checkout request is waiting to be processed.",
    badge: "queued",
    tone: "neutral",
  },
  {
    title: "Checking availability",
    body: "Inventory is being reserved for this checkout.",
    badge: "reserving",
    tone: "warning",
    active: true,
  },
  {
    title: "Reserved",
    body: "Inventory is reserved. Payment will start next.",
    badge: "reserved",
    tone: "success",
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
            <button className="button primary" type="button">
              Buy
            </button>
            <p className="fine-print">
              This page does not decrement inventory after pressing Buy. Inventory changes only
              after projection refresh.
            </p>
          </section>

          <section className="panel" aria-labelledby="status-title">
            <p className="eyebrow">Checkout status</p>
            <h2 id="status-title">Accepted does not mean reserved.</h2>
            <div className="status-list">
              {statusRows.map((row) => (
                <div className="status-row" key={row.badge}>
                  <div>
                    <strong>{row.title}</strong>
                    <p className="muted">{row.body}</p>
                  </div>
                  <span className={`badge ${row.tone}`}>
                    {row.active ? <span className="spinner small" aria-hidden="true" /> : null}
                    {row.badge}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel" aria-labelledby="updates-title">
            <p className="eyebrow">Notification center</p>
            <h2 id="updates-title">Unified checkout updates</h2>
            <div className="status-list">
              <div className="status-row">
                <div>
                  <strong>Checkout request accepted</strong>
                  <p className="muted">Intent chk_8f2 is queued for reservation processing.</p>
                </div>
                <span className="badge neutral">queued</span>
              </div>
              <div className="status-row">
                <div>
                  <strong>Cart reservation update</strong>
                  <p className="muted">
                    1 of 3 products is reserved. Remaining products are processing.
                  </p>
                </div>
                <span className="badge warning">update</span>
              </div>
            </div>
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
          <p className="eyebrow">Cart checkout products</p>
          <h2>Per-item reservation progress</h2>
          <div className="cart-list">
            {cartItems.map((item) => (
              <div className="cart-item" key={item.name}>
                <span className="cart-thumb" aria-hidden="true" />
                <div>
                  <strong>{item.name}</strong>
                  <p className="muted">{item.detail}</p>
                </div>
                {item.status === "reserved" ? (
                  <span className="badge success">reserved</span>
                ) : (
                  <span className="spinner" role="status" aria-label={`${item.name} processing`} />
                )}
              </div>
            ))}
          </div>
        </div>
      </details>
    </main>
  );
}
