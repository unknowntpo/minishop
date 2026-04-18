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
    checkout/
    inventory/
    projections/
  ports/
    event-store.ts
    catalog-repository.ts
    projection-repository.ts
    clock.ts
    id-generator.ts
  infrastructure/
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
