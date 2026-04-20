import Link from "next/link";

import {
  DesignSystemPreviewBadges,
  DesignSystemPreviewButtons,
  DesignSystemPreviewCartMotion,
  DesignSystemPreviewMenu,
  DesignSystemPreviewNavbar,
  DesignSystemPreviewSpinner,
} from "@/components/internal/design-system-previews";
import { DesignSystemPreviewSwitch } from "@/components/internal/design-system-preview-switch";

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
  {
    level: "50 / 100",
    usage: "Subtle backgrounds, soft fills, empty states, non-blocking emphasis.",
  },
  {
    level: "300",
    usage: "Borders, dividers, input outlines, quiet controls.",
  },
  {
    level: "500 / 600",
    usage: "Primary controls, links, active badges, stronger callouts.",
  },
  {
    level: "900 / 950",
    usage: "Text, icons, high-contrast states, durable labels.",
  },
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
  {
    name: "Phone",
    range: "0-639px",
    behavior: "Single-column content, compact nav, overlays stay narrow, controls avoid blocky wrappers.",
  },
  {
    name: "Tablet",
    range: "640-1023px",
    behavior: "Two-column grids where helpful, toolbar stays light, drawers remain anchored to trigger.",
  },
  {
    name: "Desktop",
    range: "1024-1439px",
    behavior: "Buyer product layout can split media and purchase panels, internal dashboards may use 3-column summaries.",
  },
  {
    name: "Wide Desktop",
    range: "1440px+",
    behavior: "More breathing room, denser admin/benchmark comparisons, no viewport-scaled typography jumps.",
  },
] as const;

const i18nRules = [
  "Buyer-facing surfaces support `zh-TW` and `en`; internal admin and benchmark surfaces stay English-only unless a change explicitly expands scope.",
  "Translatable buyer copy must resolve through shared message dictionaries instead of hard-coded component strings.",
  "Typography and spacing should assume Traditional Chinese and English copy both appear in the same product, especially button labels, drawer rows, and toasts.",
  "Locale selection is a buyer preference, not a global admin setting; it must persist across buyer pages without leaking into internal operator surfaces.",
] as const;

const componentRules = [
  {
    title: "Primary action",
    detail: "Use dark ink fill for the default durable action. Reserve accent color for price and contextual emphasis, not every CTA.",
  },
  {
    title: "Secondary action",
    detail: "Use bordered surface buttons for additive or reversible actions such as add-to-cart, filters, or preview actions.",
  },
  {
    title: "Status surfaces",
    detail: "Communicate truth from projections or source-backed state. Do not imply success before the underlying status confirms it.",
  },
  {
    title: "Internal tools",
    detail: "Admin, benchmark, and future design-system pages use the same quiet internal visual language and should remain separate from buyer flow styling.",
  },
  {
    title: "Overlay motion",
    detail: "Cart drawers, profile panels, and utility menus should share the same anchored overlay motion: top-right origin, emphasized scale/translate on enter, and matching exit timing.",
  },
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
  {
    name: "Primary action button",
    pattern: "One durable primary action per area, loading-aware, with secondary actions visually quieter.",
    preview: "button",
    refs: [{ label: "Button", href: shopifyRefs.button }],
  },
  {
    name: "Spinner / loading",
    pattern: "Show motion only during active async work and stop immediately when source-backed or projection-backed status arrives.",
    preview: "spinner",
    refs: [{ label: "Spinner", href: shopifyRefs.spinner }],
  },
  {
    name: "Toggle / switch",
    pattern: "Binary settings use a switch; buyer locale choice remains segmented because it is a small explicit mode choice, not a single boolean flag.",
    preview: "switch",
    refs: [{ label: "Switch", href: shopifyRefs.switch }],
  },
  {
    name: "Status badge",
    pattern: "Use badges for compact status and diagnostics, with semantic token families rather than arbitrary colors.",
    preview: "badge",
    refs: [{ label: "Badge", href: shopifyRefs.badge }],
  },
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

export default function InternalDesignSystemPage() {
  return (
    <main className="page-shell admin-shell">
      <nav className="admin-nav">
        <Link className="text-link" href="/products">
          Products
        </Link>
        <Link className="text-link" href="/internal/admin">
          Projection admin
        </Link>
        <Link className="text-link" href="/internal/benchmarks">
          Benchmark results
        </Link>
      </nav>

      <section className="catalog-hero" aria-labelledby="design-system-title">
        <p className="eyebrow">Internal design system</p>
        <h1 id="design-system-title">Minishop UI system</h1>
        <p className="muted hero-copy">
          Engineering-facing reference for color roles, semantic token weights, typography,
          breakpoints, shape rules, and bilingual UI behavior. This page exists so UI decisions are
          documented once instead of being rediscovered in CSS or fixed one component at a time.
        </p>
        <p className="muted hero-copy">
          This system is Minishop-owned. The visual direction, previews, and token decisions should
          follow our current product language first. Shopify web components are reference material
          for interaction patterns only, not a visual source of truth.
          {" "}
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
                      <span
                        className="design-swatch"
                        style={{ background: token.value }}
                        aria-hidden="true"
                      />
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
    </main>
  );
}
