# Code Architecture

## Intent

Use a lightweight Clean Architecture shape that fits Next.js App Router without adding enterprise-style boilerplate. The goal is to keep checkout correctness, event persistence, projection processing, and UI delivery independently testable.

Next.js is the delivery layer. Domain and application logic must not depend on Next.js request, response, React, or routing APIs.

## Directory Shape

```text
app/
  products/
    page.tsx
    [slug]/
      page.tsx
  internal/
    admin/
      page.tsx
  api/
    checkout-intents/
      route.ts
    checkout-intents/
      [checkoutIntentId]/
        route.ts
    skus/
      [skuId]/
        inventory/
          route.ts
    internal/
      admin/
        dashboard/
          route.ts
      checkout-intents/
        [checkoutIntentId]/
          complete-demo/
            route.ts
      projections/
        process/
          route.ts

components/
  checkout/
  products/

src/
  domain/
    checkout/
    inventory/
    payment/
    order/
  application/
    admin/
    checkout/
    inventory/
    projections/
  ports/
    admin-dashboard-repository.ts
    event-store.ts
    catalog-repository.ts
    projection-repository.ts
    clock.ts
    id-generator.ts
  infrastructure/
    admin/
    db/
    event-store/
    catalog/
    projections/
  presentation/
    view-models/
```

## Naming

Use kebab-case for TypeScript module and folder names:

```text
src/infrastructure/event-store/postgres-event-store.ts
```

Use snake_case for PostgreSQL table names:

```text
event_store
checkout_intent_projection
projection_checkpoint
```

Use PascalCase for TypeScript types:

```text
EventStore
CheckoutIntentCreated
```

This keeps code modules, database objects, and type names distinct.

## API Contracts, View Models, and Repository Adapters

Use TypeScript-style names instead of Java-style DTO/DAO naming.

Concept mapping:

```text
Java DTO      -> API contract or presentation view model
Java DAO      -> repository port plus infrastructure adapter
Java Service  -> application use case
Java Entity   -> domain model or aggregate state
```

API request and response shapes live under presentation-oriented modules:

```text
src/presentation/api/
src/presentation/view-models/
```

Example:

```ts
export type CreateCheckoutIntentRequest = {
  buyerId: string;
  items: Array<{
    skuId: string;
    quantity: number;
  }>;
  idempotencyKey?: string;
};
```

Database access is expressed as ports and adapters:

```text
src/ports/catalog-repository.ts
src/infrastructure/catalog/postgres-catalog-repository.ts
```

Do not introduce Java-style folders or suffixes by default:

```text
dto/
dao/
service/
CheckoutIntentDto
CheckoutIntentDao
CheckoutIntentServiceImpl
```

Only add suffixes like `Request`, `Response`, `ViewModel`, `Repository`, or `Adapter` when they clarify a real boundary.

## Seed Data

Catalog seed data is for local development, preview, and benchmark fixtures only. It must not be treated as production bootstrap data.

Use explicit script names for non-production seed data:

```text
db:seed:dev
seed-dev-catalog
```

Production data loading must be a separate operational process when needed.

## Local PostgreSQL

Use Docker Compose as the default local PostgreSQL setup:

```text
docker-compose.yml
  postgres service
  minishop database
  persistent local volume
  healthcheck with pg_isready
```

Local commands:

```text
pnpm db:up
pnpm db:migrate
pnpm db:seed:dev
pnpm dev
```

Compose is a local development dependency, not a production runtime decision. The application still connects through `DATABASE_URL`, so a native local PostgreSQL instance can be used when needed.

## Dependency Direction

Allowed direction:

```text
app -> application -> domain
app -> infrastructure
application -> ports
infrastructure -> ports
infrastructure -> db
components -> props and presentation models
```

Forbidden direction:

```text
domain -> application
domain -> infrastructure
domain -> app
application -> app
application -> infrastructure
components -> infrastructure
components -> db
```

Application use cases receive dependencies through small dependency objects:

```ts
type CreateCheckoutIntentDeps = {
  eventStore: EventStore;
  clock: Clock;
  idGenerator: IdGenerator;
};
```

Next.js API routes wire concrete infrastructure into application use cases.

## Next.js Boundary Rules

Server Components may read catalog and projection-backed data for SSR.

State-changing checkout commands use API route handlers, not Server Actions in the MVP:

```text
POST /api/checkout-intents
```

The local demo may use an internal route to complete a checkout after the intent has been accepted and projected:

```text
POST /api/internal/checkout-intents/:id/complete-demo
```

This route is a demo worker substitute. It appends inventory reservation, payment requested, and order confirmation events so the browser can exercise a full result flow before an independent worker exists.

Polling reads also use API route handlers:

```text
GET /api/checkout-intents/:id
GET /api/skus/:skuId/inventory
```

Server-only infrastructure modules must include:

```ts
import "server-only";
```

Client Components must not import `src/infrastructure/*`, `db/*`, or server-only modules.

## API Error Boundaries and Traceability

API routes must translate unexpected server failures into user-safe response bodies. Frontend UI should not receive raw environment variable names, database errors, stack traces, SQL messages, or server-only configuration details.

Each API request should have a request context:

```text
request_id:
  stable per HTTP request
  returned to the client as a short support/reference value

trace_id:
  propagated from inbound headers when present
  used for server logs and later distributed tracing
```

Response headers may include `x-request-id` and `x-trace-id`. Error response bodies may include `requestId` for support/debug correlation, but must use generic customer-facing messages.

Event metadata may also include request and trace identifiers when a command produces a durable event. Metadata is observability context, not business state.

## End-to-End Verification

The first implementation does not run browser end-to-end tests in the default `pnpm check` path. The fast check path should stay focused on TypeScript, Biome, dependency boundaries, and Vitest unit/application tests.

Add Playwright later as an explicit slow verification path after the local database and projection processor flow stabilize:

```text
pnpm test:e2e
```

Target e2e flow:

```text
start local PostgreSQL through Docker Compose
run Drizzle migrations
seed local catalog data
start Next.js app
open /products/limited-runner
press Buy
expect checkout intent request to be accepted
trigger or wait for projection processing
poll until checkout status becomes projection-backed
open /internal/admin
verify SKU inventory projection and checkout projection are visible
```

E2E tests must isolate state by using a dedicated test database, unique buyer/idempotency values, or per-run cleanup. They should not share the developer preview database by default.

Because Playwright is slower and requires a running app plus database, it should be opt-in locally and optional in early CI. It can become a required CI gate after the checkout flow and test data isolation are stable.

## Internal Admin Surfaces

Internal admin pages are allowed for local development, projection verification, and benchmark observation. They are not buyer UI.

The first internal admin page may read:

```text
product and sku catalog rows
sku_inventory_projection counters
checkout_intent_projection latest statuses
projection_checkpoint cursor state
```

Internal admin pages may use Server Components and server-only repository adapters because they are read-only diagnostic surfaces. They should live under `/internal/*`, stay visually separate from product pages, and avoid becoming required for checkout correctness.

For live projection observation, the admin page may hydrate a Client Component from the initial server snapshot and poll an internal dashboard API. This keeps the realtime strategy consistent with the polling-first MVP.

## Circular Dependency Guard

Circular dependencies should be checked automatically. They are especially risky in this project because aggregate roots, event types, projection handlers, and infrastructure adapters can easily form accidental import loops.

Decision: use `dependency-cruiser` when dependency boundary checks are added.

Reasons:

- It can detect circular dependencies.
- It can validate architecture boundaries, not just cycles.
- It supports JavaScript and TypeScript dependency graphs.
- It can run as a separate CI/check script alongside Biome, TypeScript, and Vitest.
- It avoids replacing Biome with ESLint solely to use `import/no-cycle`.

Alternatives considered:

- `dpdm`: good lightweight circular dependency checker for TypeScript and supports TypeScript path mapping. It is a good fallback if only cycle detection is needed, but it does not cover architectural layer rules as directly.
- `madge`: useful for dependency visualization and circular dependency detection, but less attractive as the primary guard for TypeScript architecture boundaries.
- ESLint `import/no-cycle`: works in ESLint-based stacks, but this project intentionally uses Biome. Adding ESLint only for import cycles would duplicate linting responsibilities.

Initial rule set should include:

```text
no circular dependencies in app, components, src, db
domain must not import application, infrastructure, app, components, or db
application must not import app, components, infrastructure, or db
components must not import infrastructure or db
infrastructure must not import app or components
client components must not import server-only infrastructure
```

Suggested scripts:

```json
{
  "scripts": {
    "deps:check": "depcruise --config dependency-cruiser.config.cjs app components src db",
    "check": "pnpm run typecheck && pnpm run lint && pnpm run deps:check && pnpm run test"
  }
}
```

Graph generation can be added later if the dependency graph becomes hard to review.
