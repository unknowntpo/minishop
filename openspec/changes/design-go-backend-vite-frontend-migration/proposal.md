## Why

The current web stack still mixes three different responsibilities inside the Next.js app:

- buyer-facing page rendering
- internal admin page rendering
- HTTP backend routes that own business reads and writes

That coupling was acceptable while the system was still Node-first, but it is now working against the direction of travel:

- buyer/seckill ingress is already being moved to Go
- backend-only compose E2E now treats Go as the preferred backend boundary
- several UI surfaces are already client-heavy and mostly need data APIs rather than server-rendered database access

The right reason to move away from Next.js is therefore **architecture simplification and clearer boundaries**, not the mistaken assumption that seckill amplification is a Next-only problem. Go HTTP still shows request-topic amplification under some workload shapes, so the topology problem must be solved independently from frontend migration.

## What Changes

- Define a target architecture with **Go as the application backend** and a separate **Vite + React + TanStack Router + TanStack Query** frontend
- Inventory the current Next.js pages and API routes and classify them as migrate-now, migrate-later, or defer
- Define the Go API surface required to replace current Next.js server-side page data reads for:
  - product listing
  - product detail
  - checkout completion display
  - admin dashboard
  - admin seckill config updates
- Define a phased migration sequence that removes Next.js backend responsibilities first and removes the remaining Next.js app only after frontend parity is reached
- Define acceptance expectations for backend-only compose E2E and frontend smoke coverage during the migration

## Status

This change has now been implemented:

- `buyer-web` is the active frontend runtime
- `go-backend` owns the live web API boundary
- the old Next.js runtime has been removed from the active application path

## Capabilities

### New Capabilities

- `buyer-web-runtime`: Run buyer/admin web UI as a frontend-only application that consumes backend APIs instead of embedding backend logic in Next.js page/server code

### Modified Capabilities

- `event-sourced-buy-flow`: The web client contract is no longer assumed to be served by Next.js server pages or Next.js API routes once the migration completes

## Impact

- Affected specs:
  - `buyer-web-runtime`
  - `event-sourced-buy-flow`
- Affected code:
  - `app/products/**`
  - `app/checkout-complete/**`
  - `app/internal/admin/**`
  - `app/api/**`
  - Go backend HTTP surface
  - frontend runtime and bundling setup
- Affected systems:
  - browser frontend runtime
  - Go application backend
  - internal admin UI
  - buyer checkout UI
