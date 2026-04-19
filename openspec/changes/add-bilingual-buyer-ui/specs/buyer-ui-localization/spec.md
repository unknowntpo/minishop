## ADDED Requirements

### Requirement: Buyer-Facing Locale Support

The system SHALL support buyer-facing UI in both English (`en`) and Traditional Chinese (`zh-TW`).

#### Scenario: Default locale is selected

- **WHEN** a buyer-facing page loads without a previously selected locale
- **THEN** the UI SHALL render in `zh-TW`

#### Scenario: Buyer switches locale

- **WHEN** the buyer explicitly changes locale
- **THEN** the system SHALL re-render buyer-facing copy in the selected locale and persist that preference for later buyer-facing pages

#### Scenario: Unsupported locale is requested

- **WHEN** an unsupported locale value is encountered
- **THEN** the system SHALL fall back to the default locale instead of rendering missing-copy placeholders

### Requirement: Buyer Copy Centralization

The system SHALL centralize buyer-facing translations rather than storing bilingual strings ad hoc inside multiple page and component files.

#### Scenario: Buyer-facing string is rendered

- **WHEN** a buyer-facing page or component renders translatable copy
- **THEN** the string SHALL be resolved through a shared buyer-facing translation dictionary or helper

#### Scenario: Internal engineering term is rendered

- **WHEN** an internal admin or benchmark surface renders engineering-focused copy
- **THEN** this change SHALL NOT require that surface to use the buyer-facing translation dictionary

### Requirement: Localized Buyer Flow Coverage

The system SHALL localize the end-to-end buyer flow for catalog browsing, product detail, direct buy, cart checkout, and checkout completion.

#### Scenario: Buyer browses catalog

- **WHEN** the buyer opens the catalog page
- **THEN** headings, descriptive copy, and navigation controls SHALL render in the selected locale

#### Scenario: Buyer reviews product detail

- **WHEN** the buyer opens a product page
- **THEN** product-page UI copy including direct-buy labels, inventory guidance, quantity labels, and fine print SHALL render in the selected locale

#### Scenario: Buyer interacts with cart

- **WHEN** the buyer adds items to cart or opens the cart drawer
- **THEN** toast messages, cart summary copy, item actions, and checkout CTA copy SHALL render in the selected locale

#### Scenario: Buyer reaches checkout completion

- **WHEN** checkout completes or is received
- **THEN** the completion page SHALL render buyer-facing summary copy in the selected locale

### Requirement: Bilingual Responsive Stability

The system SHALL preserve responsive layout quality for localized buyer-facing copy across mobile, tablet, and desktop breakpoints.

#### Scenario: Localized mobile product page is rendered

- **WHEN** buyer-facing Traditional Chinese or English copy is rendered on a narrow mobile viewport
- **THEN** headings, inventory rows, quantity controls, CTA labels, and cart triggers SHALL remain readable and SHALL NOT overlap, squeeze, or overflow their containers

#### Scenario: Localized cart summary is rendered

- **WHEN** the cart is collapsed or expanded in either supported locale
- **THEN** summary metadata, badges, counts, and CTA controls SHALL remain visually stable across breakpoints

#### Scenario: Localized toast is rendered

- **WHEN** a buyer-facing toast is shown in either supported locale
- **THEN** its title, message, and action control SHALL wrap cleanly without breaking the layout or producing clipped text
