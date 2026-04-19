# Buyer UI Localization Design

## Scope

This change covers only buyer-facing UI:

- product catalog page
- product detail page
- direct buy CTA and status copy
- cart drawer and cart toast
- checkout completion page

Out of scope for this change:

- internal admin dashboard
- benchmark dashboard
- low-level event, projection, and operator terminology
- URL-level route localization beyond what is needed for a clean buyer toggle

## Goals

1. Support `en` and `zh-TW` without introducing a heavyweight i18n migration
2. Keep buyer copy centralized so future UI work does not add new hard-coded strings ad hoc
3. Make locale fallback behavior obvious and deterministic
4. Ensure bilingual copy does not degrade mobile RWD behavior

## Locale Model

Use a small explicit locale model:

```text
supported locales:
  en
  zh-TW

default locale:
  zh-TW
```

Rationale:

- the user explicitly wants Traditional Chinese support
- the current session and operating context are Traditional Chinese
- English remains a first-class supported locale, not a fallback-only afterthought

## Selection Strategy

Prefer a low-risk presentation-layer approach first:

```text
locale source priority:
  explicit user selection
  persisted browser preference
  default locale
```

The first implementation does not need route-prefixed localization such as `/en/...` or `/zh-TW/...` unless that becomes necessary for SEO or public deployment. For the local demo and current product stage, a client-visible locale switch with stable persistence is sufficient.

## Translation Ownership

Create one shared buyer-facing translation dictionary rather than scattering string maps inside individual components.

Recommended ownership split:

```text
presentation/i18n:
  locale type
  dictionary
  translation lookup helpers

components:
  render translated copy
  do not own raw bilingual string tables
```

This keeps copy review, UI review, and future editing in one place.

## Copy Boundaries

Localize:

- section labels
- headings
- CTA labels
- inventory and checkout guidance
- toast messages
- cart summaries
- checkout completion summaries
- empty and sold-out states

Do not localize in this change:

- internal table names
- aggregate or event names
- benchmark lane names
- operator strip internals

This preserves a clean boundary between buyer UI and internal engineering surfaces.

## Responsive Considerations

Bilingual support is not just string replacement. The implementation must verify:

1. product purchase card density on mobile
2. cart summary header wrapping rules
3. collapsed cart icon and count badge stability
4. toast width, line breaks, and action placement
5. checkout-complete summary hierarchy in both locales

Known risk areas:

```text
long Chinese price/CTA combinations
English explanatory copy wrapping in narrow mobile widths
cart summary metadata lines
badge text that accidentally stretches to full width
```

## Handoff Notes

The completed `add-event-sourced-buy-flow` change is archived and should be treated as the architecture baseline. This i18n change should modify buyer-facing presentation only, unless a localized API contract becomes strictly necessary.
