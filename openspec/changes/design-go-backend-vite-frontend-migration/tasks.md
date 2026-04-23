## 1. Inventory and Target Boundary

- [ ] 1.1 Confirm the current Next.js page inventory and classify each route as migrate-first, migrate-second, or defer
- [ ] 1.2 Confirm the current Next.js API route inventory and mark which routes must move to Go for buyer/admin frontend migration
- [ ] 1.3 Define the target runtime boundary: Go backend as the only application backend, frontend as a separate Vite/TanStack app

## 2. Go API Parity for UI Reads/Writes

- [x] 2.1 Add Go API support for product listing required by `/products`
- [x] 2.2 Add Go API support for product detail required by `/products/:slug`
- [x] 2.3 Add Go API support for checkout-complete display required by `/checkout-complete/:checkoutIntentId`
- [x] 2.4 Add Go API support for admin dashboard reads
- [x] 2.5 Add Go API support for admin seckill config updates
- [x] 2.6 Keep internal processing routes explicitly backend-only and do not couple them to frontend migration

## 3. New Frontend Runtime

- [x] 3.1 Scaffold a Vite + React + TanStack Router + TanStack Query frontend app
- [x] 3.2 Add shared API client configuration using an explicit backend base URL
- [ ] 3.3 Port locale handling, cart state, and buyer interaction flows into the new frontend runtime

## 4. Buyer Route Migration

- [x] 4.1 Migrate `/products`
- [x] 4.2 Migrate `/products/:slug`
- [x] 4.3 Migrate `/checkout-complete/:checkoutIntentId`
- [ ] 4.4 Verify buyer flow no longer depends on Next.js page-server database reads for migrated routes

## 5. Admin Route Migration

- [ ] 5.1 Migrate `/internal/admin`
- [ ] 5.2 Verify polling and seckill-config update behavior through Go backend APIs only

## 6. Deprecation and Removal

- [ ] 6.1 Deprecate matching Next.js API routes once Go replacements are live
- [ ] 6.2 Remove matching Next.js page/server responsibilities after frontend parity is verified
- [ ] 6.3 Decide whether engineering-only routes such as `/internal/benchmarks` remain temporarily in Next.js or move later

## 7. Verification

- [x] 7.1 Keep backend-only compose E2E green during migration
- [x] 7.2 Add frontend smoke/E2E coverage for buyer routes against Go backend using Playwright compose E2E
- [ ] 7.3 Verify migrated routes work with Go backend only and no hidden Next.js backend dependency remains
