"use client";

import { useEffect, useRef, useState } from "react";

export function DesignSystemPreviewNavbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [cartCount, setCartCount] = useState(2);
  const [activePanel, setActivePanel] = useState<"dev" | "profile" | null>(null);
  const devItems = ["Design System", "Benchmarks", "Admin"] as const;

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

export function DesignSystemPreviewButtons() {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!loading) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setLoading(false);
    }, 1200);

    return () => {
      window.clearTimeout(timeout);
    };
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

export function DesignSystemPreviewSpinner() {
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

export function DesignSystemPreviewBadges() {
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

export function DesignSystemPreviewMenu() {
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

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
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

export function DesignSystemPreviewCartMotion() {
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
      <span className="design-preview-motion-note">
        Tap the cart to preview backdrop blur and drawer easing.
      </span>
    </div>
  );
}
