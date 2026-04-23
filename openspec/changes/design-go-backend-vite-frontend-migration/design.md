## Context

The current repository still treats Next.js as both:

- the web frontend runtime
- a significant part of the application backend

That coupling shows up in two ways.

First, the Next.js `app/` tree still owns server-side page data access:

- `app/page.tsx`
  - redirects to `/products`
- `app/products/page.tsx`
  - reads catalog data directly from `postgresCatalogRepository`
- `app/products/[slug]/page.tsx`
  - reads product detail and related catalog data directly from `postgresCatalogRepository`
- `app/checkout-complete/[checkoutIntentId]/page.tsx`
  - reads `checkout_intent_projection` and `command_status` directly from PostgreSQL
- `app/internal/admin/page.tsx`
  - reads admin dashboard data directly from `postgresAdminDashboardRepository`

Second, Next.js still owns a broad API surface:

- buyer flow
  - `POST /api/buy-intents`
  - `GET /api/buy-intent-commands/:commandId`
  - `POST /api/checkout-intents`
  - `GET /api/checkout-intents/:checkoutIntentId`
- internal processing
  - `POST /api/internal/projections/process`
  - `POST /api/internal/buy-intent-commands/process`
  - `POST /api/internal/checkout-intents/:checkoutIntentId/complete-demo`
- admin
  - `GET /api/internal/admin/dashboard`
  - `POST /api/internal/admin/seckill`
- other internal surfaces
  - `GET /api/skus/:skuId/inventory`
  - profiling/benchmark routes under `app/api/internal/benchmarks/**`

At the same time, much of the actual UI is already client-heavy:

- `components/products/products-page-content.tsx`
- `components/checkout/product-detail-page.tsx`
- `components/checkout/checkout-complete-content.tsx`
- `components/admin/admin-dashboard.tsx`

That means the current stack is paying Next.js server-runtime complexity even where the main remaining need is simply "call backend APIs and render React UI."

## Goals / Non-Goals

**Goals**

- Make Go the sole long-term application backend for buyer and admin flows
- Move buyer/admin frontend delivery to a dedicated web frontend runtime using:
  - Vite
  - React
  - TanStack Router
  - TanStack Query
- Replace current Next.js server-side database reads with explicit Go HTTP APIs
- Keep migration incremental so backend correctness and E2E acceptance stay observable at each phase
- Preserve current user-visible product and admin capabilities while changing runtime ownership

**Non-Goals**

- Rewrite workers in this change
- Redesign seckill topology or fix request-topic amplification through frontend migration
- Replace current benchmark dashboard implementation in the same phase unless it becomes a blocker
- Require nginx path-based routing as part of the migration
- Commit to SSR in the replacement frontend runtime

## Decisions

### Go becomes the application backend boundary

The target state is:

- browser/frontend app
  - owns routing, rendering, caching, and local UI state
- Go backend
  - owns business reads and writes
  - owns buyer/admin HTTP contracts
- workers
  - remain separate runtime concerns

The frontend will no longer depend on:

- Next.js server components for database access
- Next.js API routes as a hidden backend layer

This makes the runtime boundary explicit and matches the backend direction already established by the Go buyer backend work.

### Vite + TanStack is the replacement frontend stack

The replacement frontend stack is deliberately simple:

- **Vite**
  - fast local iteration
  - minimal server-runtime assumptions
- **React**
  - reuse existing client-heavy components and design primitives
- **TanStack Router**
  - file ownership and route/state structure without Next.js coupling
- **TanStack Query**
  - backend API data fetching, caching, invalidation, and polling

This choice is not because TanStack magically fixes backend performance. It is because the current UI already behaves like an SPA in many places, and this stack matches that reality more cleanly than continuing to carry Next.js page/server coupling.

### No nginx routing requirement

The migration should not depend on nginx path routing.

Preferred runtime model:

- frontend runs as its own web app origin
- frontend calls Go backend through an explicit API base URL
- environment variables control target backend endpoints

This keeps the migration smaller and prevents the frontend move from being blocked on edge-proxy work.

### Current page inventory and migration classification

#### Migrate first

These pages are already mostly client-driven and should move early:

- `/products`
- `/products/:slug`
- `/checkout-complete/:checkoutIntentId`

Why:

- they are buyer-facing
- they already rely heavily on client components
- they map cleanly to explicit Go read/write APIs

#### Migrate second

- `/internal/admin`

Why:

- the UI is already client-side and polling-based
- but it depends on admin APIs that still live in Next
- it is important, but not on the critical buyer path

#### Defer

- `/internal/benchmarks`
- `/internal/design-system`

Why:

- they are engineering surfaces
- they are not required to prove the frontend/backend split for buyer/admin product flows

### Required Go API surface for frontend migration

To eliminate Next.js server-side DB reads for the target pages, Go must own these read/write contracts:

#### Buyer/catalog

- `GET /api/products`
  - returns catalog list for `/products`
- `GET /api/products/:slug`
  - returns product detail for `/products/:slug`
- `GET /api/skus/:skuId/inventory`
  - optional for live inventory display if still needed by the product detail page

#### Buyer/checkout

- `POST /api/buy-intents`
- `GET /api/buy-intent-commands/:commandId`
- `POST /api/checkout-intents`
- `GET /api/checkout-intents/:checkoutIntentId`
- `POST /api/internal/checkout-intents/:checkoutIntentId/complete-demo`
  - this remains internal/demo-only, but the replacement runtime still needs it while the demo flow exists

#### Admin

- `GET /api/internal/admin/dashboard`
- `POST /api/internal/admin/seckill`

#### Internal processing

The following can remain internal/backend-only and do not need to be browser-facing:

- `POST /api/internal/projections/process`
- `POST /api/internal/buy-intent-commands/process`

### Frontend runtime contract

The new frontend should treat all backend communication as explicit HTTP APIs.

That means:

- route loaders or query functions call Go HTTP endpoints
- local cart state remains browser-local
- locale preference remains browser-managed
- query caching and polling move to TanStack Query
- route transitions move to TanStack Router

The frontend must not:

- import backend repositories directly
- read PostgreSQL from route code
- depend on Next.js request helpers such as `cookies()` or `next/headers`

### Checkout-complete page becomes API-driven

The current `/checkout-complete/:checkoutIntentId` page is a clear example of the coupling we want to remove.

Today it reads:

- `checkout_intent_projection`
- `command_status`

directly from PostgreSQL inside Next.js page code.

After migration, this page should be rendered from Go APIs only. That keeps browser rendering and business reads clearly separated and avoids carrying one-off SSR DB queries into the new stack.

### Migration phases

#### Phase 1: Go backend API parity for UI reads

Add the Go APIs needed by:

- products list
- product detail
- checkout-complete
- admin dashboard
- admin seckill config update

Acceptance:

- existing compose-based backend E2E remains green
- new APIs are available without Next.js API route dependency
- current Next buyer frontend has a Playwright compose E2E that runs browser -> Next UI -> Go backend for the regular checkout path

#### Phase 2: Vite/TanStack buyer frontend

Create the new frontend app and migrate:

- `/products`
- `/products/:slug`
- `/checkout-complete/:checkoutIntentId`

Acceptance:

- buyer flow runs against Go backend only
- no page-level DB read remains in Next for these routes

Current implementation status:

- initial buyer web runtime exists under `buyer-web/`
- it uses:
  - Vite
  - React
  - TanStack Router
  - TanStack Query
- initial buyer routes are implemented for:
  - `/products`
  - `/products/:slug`
  - `/checkout-complete/:checkoutIntentId`
- initial admin route is implemented for:
  - `/internal/admin`
- these routes already read from explicit Go APIs instead of importing backend repositories directly
- Playwright compose E2E now covers:
  - buyer-web regular checkout flow
  - buyer-web admin dashboard load
- cart parity and full admin mutation coverage are still pending

#### Phase 3: Vite/TanStack admin frontend

Migrate:

- `/internal/admin`

Acceptance:

- admin dashboard polling and seckill config update work through Go backend only

#### Phase 4: Next.js backend deprecation

Once buyer/admin frontend parity exists:

- deprecate and remove matching Next API routes
- remove matching Next page/server runtime responsibilities
- decide whether to keep a small engineering-only Next surface or remove Next entirely

## Tradeoffs

### Why not deprecate Next.js immediately

Because Next still owns real behavior:

- product list SSR reads
- product detail SSR reads
- checkout-complete SSR reads
- admin dashboard SSR reads
- several internal APIs

Deleting it immediately would create a large simultaneous frontend and backend migration with poor rollback properties.

### Why not keep Next.js only for pages forever

Because that leaves an awkward long-term split:

- Go backend owns business logic
- Next still owns page-server data access and pseudo-backend glue

That is exactly the hidden coupling we want to remove.

### Why not use frontend migration to solve seckill topology issues

Because the current evidence shows:

- request-topic amplification can also happen on Go HTTP
- direct Kafka and HTTP differ because of more than frontend runtime choice

So frontend migration and seckill topology tuning must be treated as separate tracks.

## Acceptance / Verification Strategy

### Backend acceptance

Keep backend-only compose E2E as the primary backend correctness gate.

Required direction:

- no migrated buyer/admin UI path should depend on Next.js API handlers
- compose E2E should continue to exercise Go backend directly

### Frontend acceptance

Add frontend smoke/E2E coverage for:

- products page load
- product detail load
- checkout action path
- checkout-complete page load
- admin dashboard polling
- admin seckill config update

This can be introduced incrementally as the new frontend routes land.

## Implementation Notes

The existing component split is favorable for migration:

- many UI surfaces are already client components
- the main remaining work is replacing page-server data injection with API-driven query loading

That means the migration should prefer:

- extracting reusable presentational components
- keeping business shape compatibility at the API boundary
- moving route/data ownership first

instead of redoing visual design prematurely.
