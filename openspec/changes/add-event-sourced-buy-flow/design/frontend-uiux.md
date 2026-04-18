# Frontend UI/UX Pattern

The first Minishop UI is a checkout experiment surface, not a marketing storefront. The first screen should let a user inspect one hot product/SKU, press Buy, and watch the asynchronous checkout intent move through projection-backed states.

## Product Page Pattern

Primary page:

```text
Product media
Product name
SKU selector or single SKU label
Price in minor-unit-safe formatted display
Projected inventory summary
Buy control
Checkout status panel
Benchmark/debug strip in non-production mode
```

The product page must server-render product, SKU, price, and initial inventory projection data. The client may hydrate with a stale projection, so inventory copy must avoid promising a hard guarantee before reservation completes.

Preferred inventory copy:

```text
Available now: 100
Reservation is confirmed after checkout processing.
```

Avoid:

```text
Guaranteed stock
Only 100 left for you
```

Price should be visually stronger than inventory availability. Use a distinct but restrained price treatment so price is scannable without making the inventory projection look like the primary call to action.

## Buy Interaction Pattern

Pressing Buy sends `POST /api/checkout-intents` with an idempotency key and immediately creates an accepted local checkout state when the API returns `checkout_intent_id`.

The UI must not decrement visible inventory optimistically. Inventory only changes after polling reads an updated projection.

Button states:

```text
idle:
  enabled
  label: Buy

submitting:
  disabled
  label: Submitting
  meaning: request is creating a durable checkout intent

queued/reserving:
  disabled for the same idempotency key
  label: Processing
  meaning: intent is durable and inventory reservation is asynchronous

terminal or payment state:
  enabled for a new attempt when business rules allow it
```

The page may allow another new Buy attempt only after the current intent reaches `confirmed`, `rejected`, `cancelled`, `expired`, or `pending_payment`. It must never create repeated checkout intents from double-clicks, refreshes, or retries with the same idempotency key.

## Checkout Status Pattern

The checkout status panel is the source of truth for the user's current attempt. It reads from `GET /api/checkout-intents/:id` and maps projection status to user-facing copy.

On the real product page, do not render static checkout status rows before a checkout attempt exists. The status panel appears only after `POST /api/checkout-intents` returns a `checkout_intent_id`. Static examples belong in design pattern pages and preview pages, not in the production demo purchase flow.

```text
queued:
  title: Request received
  body: Your checkout request is waiting to be processed.

reserving:
  title: Checking availability
  body: Inventory is being reserved for this checkout.

reserved:
  title: Reserved
  body: Inventory is reserved. Payment will start next.

pending_payment:
  title: Payment pending
  body: Complete payment to finish the order.

confirmed:
  title: Order confirmed
  body: Your order is confirmed.

rejected:
  title: Not available
  body: This SKU could not be reserved.

cancelled:
  title: Cancelled
  body: This checkout was cancelled.

expired:
  title: Expired
  body: This checkout expired before completion.
```

Error details should be shown only when they are actionable. Internal event, aggregate, projection, environment, stack trace, SQL, and configuration names must not appear in primary customer copy. Customer-facing API errors may show a short request or reference ID that maps to server logs.

Internal event, aggregate, and projection names may appear only in development/debug surfaces such as an internal admin page.

## Polling Pattern

The client polls checkout intent status after an accepted response:

```text
initial delay: 300ms
active cadence: every 750ms while queued/reserving/reserved
payment cadence: every 1500ms while pending_payment
stop polling: confirmed, rejected, cancelled, expired
timeout hint: after 15s without state change
```

The client polls SKU inventory independently:

```text
active cadence: every 2000ms while the product page is visible
after Buy: trigger one immediate inventory refresh after each checkout status change
hidden tab: pause or slow to at least 10000ms
```

Polling failures must not imply checkout failure. On transient read failure, keep the last known status visible and show a small retry hint. The accepted checkout intent remains durable unless the status endpoint returns a terminal failure state.

## State Consistency Pattern

The UI has three distinct state layers:

```text
request state:
  local state for POST /api/checkout-intents

checkout projection state:
  polled status for one checkout_intent_id

inventory projection state:
  polled SKU inventory counters
```

These layers must be rendered separately. For example, a successful POST means "request received", not "inventory reserved". A lower inventory number means the projection changed, not that the current user has a reservation unless the checkout status confirms it.

## Cart Checkout Pattern

Direct Buy and cart checkout share the same checkout intent UI pattern.

Direct Buy:

```text
single item summary
one Buy button
one checkout status panel
```

Cart checkout:

```text
floating cart summary or cart drawer trigger
cart item count and total amount in collapsed state
one Checkout button when the cart drawer is open or in cart checkout page
one checkout status panel after checkout intent is accepted
per-item reservation details inside expanded cart drawer or checkout detail view only
```

The cart UI must avoid implying partial success as a completed checkout. Multi-SKU checkout is all-or-nothing from the user's primary status view.

The cart should not permanently occupy the main product purchase flow. On product pages, prefer a floating cart summary, cart drawer, or compact cart trigger. Expand the cart when the user asks to inspect it, or when checkout processing needs to show per-item reservation progress. Keep the main product page focused on the current product and primary Buy control.

Collapsed cart behavior:

```text
show compact cart icon button
show small item-count badge on the icon
do not show processing copy or spinner while collapsed
show processing detail only after the cart drawer is expanded
```

Per-item cart rows may use a spinner while an asynchronous reservation or projection update is still in progress. The spinner must stop when the item has a projection-backed outcome such as reserved, rejected, released, or cancelled. Spinners are progress indicators only and must not imply FIFO ordering or successful reservation.

For the first runnable demo, do not show fake per-item cart reservation rows that never resolve. Cart checkout should use the same checkout intent API as Direct Buy, show one top-level processing state, then navigate to the checkout result page after the demo completion path projects the outcome.

Design decision:

```text
Spinning UI:
  use only for active async reservation, payment, polling, or projection work
  prefer per-item spinner for cart product rows
  prefer a small inline spinner inside status badges for whole-checkout processing
  stop spinning as soon as projection-backed outcome is available
  route update messages through the notification center
```

## Notification Pattern

Checkout updates should flow through one notification center instead of being scattered across unrelated page regions.

Notification sources:

```text
checkout intent accepted
checkout status projection changed
cart item reservation progress changed
payment state changed
inventory projection refreshed
transient polling error occurred
```

Notification rules:

```text
show user-facing state changes
keep internal event names out of primary buyer copy
deduplicate repeated polling results
preserve the checkout status panel as the source of truth
do not treat notification delivery as correctness-critical
```

The notification center is a UI coordination layer. Durable truth still comes from `event_store` and projection polling APIs.

## Benchmark Operator Pattern

For development and Day 1 benchmark runs, the UI may include a non-production operator strip:

```text
current SKU id
on_hand / reserved / sold / available
last inventory projection event id
last checkout status event id
projection lag hint
```

The operator strip helps validate projection behavior manually, but benchmark measurements still come from the benchmark script and database metrics.

An internal admin page may show products, SKUs, SKU inventory projections, latest checkout projections, and projection checkpoints. Keep it under an internal route such as `/internal/admin`, separate from the buyer purchase flow, and treat it as a local verification surface rather than production customer UI.

The operator strip is a server-rendered diagnostic snapshot. After a checkout mutates projections, the client must either refresh the route or navigate to a result page so the operator strip does not appear to be live when it is stale.

## Visual Design Constraints

Use a product-first layout with real product imagery or a realistic local placeholder asset. Do not use a marketing landing page or abstract hero for the first implementation.

Color tokens should be scale-based instead of single-value names. Each semantic family should provide light-to-heavy levels such as `50`, `100`, `300`, `500`, `600`, and `900` or `950`.

Recommended token usage:

```text
50 / 100:
  subtle backgrounds and status fills

300:
  borders and dividers

500 / 600:
  active badges, controls, links, and emphasis

900 / 950:
  high-contrast text and icons
```

Initial semantic families:

```text
neutral
accent
info
success
warning
danger
```

Recommended layout:

```text
phone:
  0-639px
  single column
  product media first
  purchase controls immediately below media
  checkout status, cart progress, and notifications stacked
  operator strip hidden by default

tablet:
  640-1023px
  single column or compact two-column layout
  Buy controls visible before long status history
  cart product rows full width

desktop:
  1024-1439px
  two-column product media and purchase panel
  status panel below purchase controls or in the right column

wide desktop:
  1440px+
  constrained content width
  avoid endlessly stretched text lines or panels
  operator strip can sit below status or in a secondary rail
```

Breakpoint rules:

```text
breakpoints may change layout and density
font size must not scale directly with viewport width
cart item rows must remain readable at every width
touch targets should remain at least 40px high on phone and tablet
sticky purchase controls are allowed on phone when they do not hide status or notifications
```

Controls must be stable across status changes. Button width, price area, inventory area, and status panel should not resize when labels change. Use plain, high-contrast states and reserve color for status meaning:

```text
neutral: queued/reserving
success: confirmed/reserved
warning: pending_payment/expired
danger: rejected/cancelled/payment failed
```

Status rows must center their content visually. Reset child paragraph margins, use a small internal text gap, and align trailing badges/spinners to the row center so browser default margins do not make copy look off-center.

Copy must be short and state-based. Avoid explaining event sourcing to the buyer in primary UI.
