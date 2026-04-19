## Why

Minishop now has a working buyer-facing flow for product browsing, direct buy, cart checkout, and checkout completion. That flow is still effectively English-only, while the product direction and earlier UI pattern work explicitly require support for Traditional Chinese and English.

Without an explicit i18n change:

- buyer-facing copy will continue to spread as hard-coded strings across components
- future UI work will have to retrofit localization after the fact
- layout regressions will appear when longer Traditional Chinese or English strings are added without breakpoint review
- operators and future contributors will not know which surfaces are intentionally bilingual and which remain internal-only

## What Changes

- Add a dedicated buyer-facing i18n layer for `en` and `zh-TW`
- Localize buyer-facing catalog, product, cart, checkout, and checkout-complete surfaces
- Keep internal admin and benchmark surfaces English-only for now unless explicitly requested later
- Define locale selection, fallback, and translation ownership rules
- Add responsive rules so bilingual strings do not break product, cart, toast, or checkout layouts

## Capabilities

### New Capabilities

- `buyer-ui-localization`: Defines bilingual buyer-facing UI behavior, locale selection, fallback rules, and copy boundaries for English and Traditional Chinese

### Modified Capabilities

None.

## Impact

- Adds a shared i18n presentation layer for buyer-facing components
- Requires buyer-facing copy extraction from hard-coded component strings
- Requires responsive verification for bilingual product, cart, toast, and checkout flows
- Improves handoff clarity by separating localization from the completed event-sourced checkout architecture change
