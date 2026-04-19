# checkout-postgres-baseline Specification

## Purpose

Define the production-like PostgreSQL checkout baseline benchmark, including request-path measurements, durable append evidence, projection catch-up, architecture lane comparisons, and local benchmark result dashboards.

## Requirements

### Requirement: Checkout PostgreSQL Baseline Benchmark

The system SHALL define a repeatable `checkout-postgres-baseline` benchmark for
the PostgreSQL-only checkout intent ingress path. The benchmark SHALL measure
durable checkout intent creation, idempotency safety, event store append
throughput, projection catch-up, and inventory invariants before Kafka, Redis,
or realtime transports are introduced.

#### Scenario: Benchmark phase is named by system boundary

- **WHEN** benchmark scripts, docs, and reports refer to the first checkout ingress benchmark
- **THEN** they SHALL use `checkout-postgres-baseline` or `benchmark:checkout:postgres` rather than time-based names such as `day1`

#### Scenario: Benchmark submits hot SKU checkout intents

- **WHEN** the benchmark runs with its default configuration
- **THEN** it SHALL submit 1,000 checkout intent requests for `sku_hot_001` with quantity `1` and one unique idempotency key per simulated buyer

#### Scenario: Benchmark excludes reservation processing

- **WHEN** `checkout-postgres-baseline` completes
- **THEN** the benchmark report SHALL treat `queued` checkout projections as valid for this phase because SKU reservation, payment, and order completion are outside the benchmark boundary

#### Scenario: Benchmark records request path metrics

- **WHEN** the benchmark completes the request burst
- **THEN** it SHALL report workload type, requested request count, accepted count, accepted rate, error count, HTTP status distribution, error distribution, latency percentiles, total duration, and request throughput

#### Scenario: Benchmark records run conditions

- **WHEN** the benchmark writes a result artifact
- **THEN** it SHALL include hardware, software, service topology, and workload conditions including Node/runtime, Next.js mode and instance count, PostgreSQL host/port/database/instance count/pool size, Redis and Kafka enabled state, CPU count/model, memory, request count, concurrency, SKU count, and projection batch size
- **AND** the benchmark SHALL record an architecture lane identifier and concurrency step so future dashboards can compare both system eras and load curves

#### Scenario: Production-like app mode is used for architecture evidence

- **WHEN** operators use benchmark results to compare architecture capacity or bottlenecks
- **THEN** they SHALL use a production-like app process such as `next start`
- **AND** `next dev` SHALL NOT be treated as comparable architecture evidence because development diagnostics distort throughput and latency

#### Scenario: Benchmark records event store metrics

- **WHEN** the benchmark reads durable event state
- **THEN** it SHALL report appended event count, append throughput, last event id, and event type distribution

#### Scenario: Benchmark records projection metrics

- **WHEN** the benchmark runs the projection processor after writes
- **THEN** it SHALL report projection checkpoint position, event store position, projection lag, checkout projection count, and checkout status distribution

#### Scenario: Benchmark verifies ingress inventory invariants

- **WHEN** the benchmark verifies SKU inventory after checkout intent ingress
- **THEN** `on_hand`, `reserved`, `sold`, and `available` SHALL remain unchanged from the seed projection and `available` SHALL equal `on_hand - reserved - sold`

#### Scenario: Benchmark verifies idempotency

- **WHEN** the benchmark replays a duplicate idempotency key
- **THEN** the replay SHALL return the original checkout intent and SHALL NOT append an additional `CheckoutIntentCreated` event

#### Scenario: Benchmark exposes failures clearly

- **WHEN** any request fails or any invariant fails
- **THEN** the benchmark report SHALL include enough status and error distribution detail to distinguish application errors, HTTP/load-generator failures, database pressure, and projection lag

#### Scenario: k6 is introduced later as a load generator

- **WHEN** k6 is added to the benchmark workflow
- **THEN** k6 SHALL generate HTTP load while a Node.js verifier SHALL continue reading PostgreSQL to validate event store, projection, idempotency, and inventory correctness

#### Scenario: Multi-SKU cart pressure is benchmarked separately

- **WHEN** the system measures cart checkout pressure across multiple SKUs
- **THEN** it SHALL use a separate benchmark phase so single hot SKU ingress metrics are not mixed with multi-SKU saga and all-or-nothing reservation metrics


<!-- @trace
source: add-event-sourced-buy-flow
updated: 2026-04-19
code:
  - .github/prompts/spectra-audit.prompt.md
  - app/api/internal/projections/process/route.ts
  - src/domain/checkout/status.ts
  - .opencode/skills/spectra-ingest/SKILL.md
  - .opencode/commands/spectra-debug.md
  - src/application/admin/get-admin-dashboard.ts
  - src/application/catalog/get-products.ts
  - .opencode/skills/spectra-archive/SKILL.md
  - db/schema.ts
  - src/domain/schema-rules.ts
  - profiles/CPU.20260419.062459.59977.0.001.cpuprofile
  - app/api/skus/[skuId]/inventory/route.ts
  - src/domain/payment/commands.ts
  - src/domain/checkout/item.ts
  - src/presentation/view-models/admin-dashboard.ts
  - src/infrastructure/projections/postgres-projection-writer.ts
  - app/page.tsx
  - app/layout.tsx
  - .opencode/skills/spectra-apply/SKILL.md
  - app/internal/benchmarks/page.tsx
  - AGENTS.md
  - db/client.ts
  - scripts/benchmark-checkout-postgres.ts
  - scripts/seed-dev-catalog.ts
  - src/application/checkout/create-checkout-intent.ts
  - .github/prompts/spectra-ask.prompt.md
  - app/products/page.tsx
  - components/admin/admin-dashboard.tsx
  - db/migrations/meta/_journal.json
  - src/infrastructure/admin/index.ts
  - .github/prompts/spectra-ingest.prompt.md
  - .opencode/skills/spectra-propose/SKILL.md
  - app/globals.css
  - .github/skills/spectra-debug/SKILL.md
  - src/application/checkout/complete-demo-checkout.ts
  - next.config.ts
  - src/presentation/api/checkout-intent-contracts.ts
  - frontend/checkout-preview.html
  - src/application/checkout-saga/checkout-reservation-saga.ts
  - src/domain/inventory/sku-inventory-aggregate.ts
  - src/ports/admin-dashboard-repository.ts
  - src/domain/checkout/commands.ts
  - src/domain/catalog/product.ts
  - .github/skills/spectra-ingest/SKILL.md
  - .github/prompts/spectra-archive.prompt.md
  - .opencode/commands/spectra-audit.md
  - .github/skills/spectra-apply/SKILL.md
  - CLAUDE.md
  - components/products/products-page-content.tsx
  - dependency-cruiser.config.cjs
  - .opencode/skills/spectra-discuss/SKILL.md
  - drizzle.config.ts
  - package.json
  - scripts/run-checkout-postgres-benchmark.ts
  - src/domain/events/event-type.ts
  - .opencode/commands/spectra-apply.md
  - app/api/internal/admin/dashboard/route.ts
  - db/migrations/0000_kind_galactus.sql
  - components/products/product-card.tsx
  - src/domain/order/status.ts
  - .opencode/skills/spectra-debug/SKILL.md
  - app/internal/admin/page.tsx
  - src/infrastructure/projections/postgres-projection-repository.ts
  - tsconfig.json
  - GEMINI.md
  - .github/skills/spectra-ask/SKILL.md
  - db/migrations/meta/0000_snapshot.json
  - docker-compose.yml
  - .opencode/commands/spectra-propose.md
  - app/products/[slug]/page.tsx
  - app/checkout-complete/[checkoutIntentId]/page.tsx
  - .spectra.yaml
  - src/ports/event-store.ts
  - scripts/run-checkout-postgres-sweep.ts
  - .github/prompts/spectra-discuss.prompt.md
  - src/infrastructure/projections/index.ts
  - app/api/checkout-intents/[checkoutIntentId]/route.ts
  - .opencode/skills/spectra-ask/SKILL.md
  - src/presentation/api/request-context.ts
  - app/api/checkout-intents/route.ts
  - vitest.config.ts
  - profiles/fixed/CPU.20260419.063326.71427.0.001.cpuprofile
  - src/infrastructure/catalog/index.ts
  - src/application/inventory/reserve-inventory.ts
  - biome.json
  - .npmrc
  - .env.example
  - src/infrastructure/admin/postgres-admin-dashboard.ts
  - src/infrastructure/checkout-demo/index.ts
  - src/infrastructure/checkout-demo/postgres-checkout-demo-repository.ts
  - src/infrastructure/event-store/index.ts
  - .github/prompts/spectra-propose.prompt.md
  - src/ports/projection-repository.ts
  - .opencode/commands/spectra-archive.md
  - .github/skills/spectra-archive/SKILL.md
  - src/presentation/view-models/product.ts
  - .github/skills/spectra-discuss/SKILL.md
  - next-env.d.ts
  - test/setup.ts
  - profiles/fixed/CPU.20260419.063326.71970.0.001.cpuprofile
  - .nvmrc
  - components/products/product-grid.tsx
  - src/domain/payment/status.ts
  - .github/prompts/spectra-apply.prompt.md
  - .opencode/commands/spectra-ask.md
  - profiles/CPU.20260419.062500.60544.0.001.cpuprofile
  - .github/skills/spectra-audit/SKILL.md
  - src/domain/order/commands.ts
  - src/infrastructure/event-store/postgres-event-store.ts
  - .opencode/commands/spectra-discuss.md
  - components/checkout/checkout-action.tsx
  - src/domain/inventory/commands.ts
  - src/infrastructure/catalog/postgres-catalog-repository.ts
  - src/application/payment/payment-compensation.ts
  - .opencode/commands/spectra-ingest.md
  - app/api/internal/checkout-intents/[checkoutIntentId]/complete-demo/route.ts
  - scripts/reset-dev-db.ts
  - src/ports/checkout-demo-repository.ts
  - frontend/design-pattern.html
  - src/domain/events/event-metadata.ts
  - .github/skills/spectra-propose/SKILL.md
  - .github/prompts/spectra-debug.prompt.md
  - components/checkout/product-detail-page.tsx
  - src/application/projections/process-projections.ts
  - src/infrastructure/catalog/static-catalog-repository.ts
  - src/infrastructure/catalog/catalog-row-mapper.ts
  - src/domain/events/domain-event.ts
  - src/ports/id-generator.ts
  - src/ports/clock.ts
  - src/ports/catalog-repository.ts
  - .opencode/skills/spectra-audit/SKILL.md
tests:
  - src/domain/schema-rules.test.ts
  - src/application/checkout/create-checkout-intent.test.ts
  - src/domain/inventory/sku-inventory-aggregate.test.ts
  - src/application/payment/payment-compensation.test.ts
  - src/application/projections/process-projections.test.ts
  - src/application/inventory/reserve-inventory.test.ts
  - app/page.test.tsx
  - src/infrastructure/catalog/postgres-catalog-repository.test.ts
  - src/application/checkout-saga/checkout-reservation-saga.test.ts
-->

---
### Requirement: Benchmark Result Dashboard

The system SHALL provide an internal benchmark result dashboard that reads local
benchmark artifacts and visualizes historical `checkout-postgres-baseline`
results without storing benchmark observations in the domain event store.

#### Scenario: Benchmark writes local artifact

- **WHEN** `pnpm benchmark:checkout:postgres` completes
- **THEN** it SHALL write a JSON result artifact under `benchmark-results/checkout-postgres-baseline`

#### Scenario: Benchmark can run from isolated local state

- **WHEN** an operator needs a clean local benchmark run
- **THEN** the system SHALL provide a dev-only reset path that recreates local PostgreSQL schema state, reapplies migrations, reseeds catalog projections, and then runs `checkout-postgres-baseline`
- **AND** the reset path SHALL refuse non-local databases

#### Scenario: Benchmark runner performs preflight and summary

- **WHEN** an operator runs `pnpm benchmark:checkout:postgres` or `pnpm benchmark:checkout:postgres:reset`
- **THEN** the benchmark runner SHALL verify that the local app is reachable before starting load
- **AND** the reset variant SHALL run the local database reset path before the raw benchmark
- **AND** the runner SHALL print a concise summary from the latest benchmark artifact after completion

#### Scenario: Production concurrency sweep generates one architecture lane

- **WHEN** an operator runs `pnpm benchmark:checkout:postgres:sweep`
- **THEN** the system SHALL execute a production-like concurrency sweep for one architecture lane across multiple configured concurrency steps
- **AND** each step SHALL reset local database state before measuring the next point
- **AND** each artifact SHALL preserve the same scenario and architecture lane while recording a distinct concurrency step

#### Scenario: Dashboard reads benchmark artifacts

- **WHEN** an operator opens `/internal/benchmarks`
- **THEN** the page SHALL read local benchmark JSON artifacts from scenario-named result directories and show scenario families plus recent historical runs
- **AND** the page SHALL avoid hard-coding a single benchmark scenario as the only comparable result set

#### Scenario: Dashboard shows bottleneck indicators

- **WHEN** benchmark artifacts exist
- **THEN** the dashboard SHALL show request latency, request errors, event append throughput, projection lag, and inventory correctness indicators

#### Scenario: Dashboard compares run evidence

- **WHEN** benchmark artifacts exist
- **THEN** the dashboard SHALL show run condition tags and cross-run evidence for workload shape, hardware/software/service topology, HTTP status distribution, error distribution, event type distribution, checkout status distribution, inventory counters, and idempotency replay outcome

#### Scenario: Dashboard compares runs by scenario and conditions

- **WHEN** benchmark artifacts from multiple scenarios or run conditions exist
- **THEN** the dashboard SHALL group comparison signals by scenario and SHALL show run condition summaries beside plots and in history so operators can compare only compatible runs
- **AND** comparison metrics and run markers SHALL expose concise explanations so operators can understand what each metric means and inspect individual run context without leaving the dashboard

#### Scenario: Dashboard selects scenario for comparison

- **WHEN** an operator chooses a scenario family
- **THEN** the dashboard SHALL update the run comparison to that scenario and keep other scenario families available as separate comparison lanes
- **AND** choosing the already selected scenario SHALL collapse the run comparison so operators can return to the scenario overview
- **AND** the run comparison SHALL render inside the scenario family section to preserve the parent-child hierarchy
- **AND** scenario selection SHALL preserve the operator's local reading position instead of jumping back to the top of the page

#### Scenario: Dashboard compares architecture lanes and concurrency curves

- **WHEN** benchmark artifacts contain runs from multiple architecture lanes or concurrency steps
- **THEN** the dashboard SHALL compare those runs as capacity curves rather than as isolated latest values
- **AND** operators SHALL be able to see safe concurrency, bottleneck shift, and metric movement across architecture lanes for the same workload

#### Scenario: Dashboard supports preview future lanes with explicit mock data

- **WHEN** future architecture eras do not yet have measured runs
- **THEN** the dashboard SHALL render clearly labeled preview lanes with mock data when operators intentionally supply preview data so UI behavior and information hierarchy can be tuned before the real systems exist
- **AND** preview lanes SHALL be visually distinct from artifact-backed measured runs

#### Scenario: Dashboard explains evidence matrix purpose

- **WHEN** the dashboard shows cross-run diagnostic evidence
- **THEN** it SHALL present categorical distributions and invariant checks as an evidence matrix rather than as trend plots
- **AND** it SHALL explain that the matrix is used to diagnose why plotted metrics moved across runs

#### Scenario: Dashboard maps metrics to data flow

- **WHEN** benchmark artifacts exist
- **THEN** the dashboard SHALL show a simple data-flow explanation connecting ingress, durable append, projection processing, and verification metrics

#### Scenario: Dashboard tolerates empty history

- **WHEN** no benchmark artifacts exist
- **THEN** the dashboard SHALL render an empty state with the benchmark command instead of failing

#### Scenario: Benchmark observations stay outside domain events

- **WHEN** benchmark results are displayed or accumulated
- **THEN** benchmark artifacts SHALL remain separate from `event_store` because they describe measurement runs rather than commerce domain facts

<!-- @trace
source: add-event-sourced-buy-flow
updated: 2026-04-19
code:
  - .github/prompts/spectra-audit.prompt.md
  - app/api/internal/projections/process/route.ts
  - src/domain/checkout/status.ts
  - .opencode/skills/spectra-ingest/SKILL.md
  - .opencode/commands/spectra-debug.md
  - src/application/admin/get-admin-dashboard.ts
  - src/application/catalog/get-products.ts
  - .opencode/skills/spectra-archive/SKILL.md
  - db/schema.ts
  - src/domain/schema-rules.ts
  - profiles/CPU.20260419.062459.59977.0.001.cpuprofile
  - app/api/skus/[skuId]/inventory/route.ts
  - src/domain/payment/commands.ts
  - src/domain/checkout/item.ts
  - src/presentation/view-models/admin-dashboard.ts
  - src/infrastructure/projections/postgres-projection-writer.ts
  - app/page.tsx
  - app/layout.tsx
  - .opencode/skills/spectra-apply/SKILL.md
  - app/internal/benchmarks/page.tsx
  - AGENTS.md
  - db/client.ts
  - scripts/benchmark-checkout-postgres.ts
  - scripts/seed-dev-catalog.ts
  - src/application/checkout/create-checkout-intent.ts
  - .github/prompts/spectra-ask.prompt.md
  - app/products/page.tsx
  - components/admin/admin-dashboard.tsx
  - db/migrations/meta/_journal.json
  - src/infrastructure/admin/index.ts
  - .github/prompts/spectra-ingest.prompt.md
  - .opencode/skills/spectra-propose/SKILL.md
  - app/globals.css
  - .github/skills/spectra-debug/SKILL.md
  - src/application/checkout/complete-demo-checkout.ts
  - next.config.ts
  - src/presentation/api/checkout-intent-contracts.ts
  - frontend/checkout-preview.html
  - src/application/checkout-saga/checkout-reservation-saga.ts
  - src/domain/inventory/sku-inventory-aggregate.ts
  - src/ports/admin-dashboard-repository.ts
  - src/domain/checkout/commands.ts
  - src/domain/catalog/product.ts
  - .github/skills/spectra-ingest/SKILL.md
  - .github/prompts/spectra-archive.prompt.md
  - .opencode/commands/spectra-audit.md
  - .github/skills/spectra-apply/SKILL.md
  - CLAUDE.md
  - components/products/products-page-content.tsx
  - dependency-cruiser.config.cjs
  - .opencode/skills/spectra-discuss/SKILL.md
  - drizzle.config.ts
  - package.json
  - scripts/run-checkout-postgres-benchmark.ts
  - src/domain/events/event-type.ts
  - .opencode/commands/spectra-apply.md
  - app/api/internal/admin/dashboard/route.ts
  - db/migrations/0000_kind_galactus.sql
  - components/products/product-card.tsx
  - src/domain/order/status.ts
  - .opencode/skills/spectra-debug/SKILL.md
  - app/internal/admin/page.tsx
  - src/infrastructure/projections/postgres-projection-repository.ts
  - tsconfig.json
  - GEMINI.md
  - .github/skills/spectra-ask/SKILL.md
  - db/migrations/meta/0000_snapshot.json
  - docker-compose.yml
  - .opencode/commands/spectra-propose.md
  - app/products/[slug]/page.tsx
  - app/checkout-complete/[checkoutIntentId]/page.tsx
  - .spectra.yaml
  - src/ports/event-store.ts
  - scripts/run-checkout-postgres-sweep.ts
  - .github/prompts/spectra-discuss.prompt.md
  - src/infrastructure/projections/index.ts
  - app/api/checkout-intents/[checkoutIntentId]/route.ts
  - .opencode/skills/spectra-ask/SKILL.md
  - src/presentation/api/request-context.ts
  - app/api/checkout-intents/route.ts
  - vitest.config.ts
  - profiles/fixed/CPU.20260419.063326.71427.0.001.cpuprofile
  - src/infrastructure/catalog/index.ts
  - src/application/inventory/reserve-inventory.ts
  - biome.json
  - .npmrc
  - .env.example
  - src/infrastructure/admin/postgres-admin-dashboard.ts
  - src/infrastructure/checkout-demo/index.ts
  - src/infrastructure/checkout-demo/postgres-checkout-demo-repository.ts
  - src/infrastructure/event-store/index.ts
  - .github/prompts/spectra-propose.prompt.md
  - src/ports/projection-repository.ts
  - .opencode/commands/spectra-archive.md
  - .github/skills/spectra-archive/SKILL.md
  - src/presentation/view-models/product.ts
  - .github/skills/spectra-discuss/SKILL.md
  - next-env.d.ts
  - test/setup.ts
  - profiles/fixed/CPU.20260419.063326.71970.0.001.cpuprofile
  - .nvmrc
  - components/products/product-grid.tsx
  - src/domain/payment/status.ts
  - .github/prompts/spectra-apply.prompt.md
  - .opencode/commands/spectra-ask.md
  - profiles/CPU.20260419.062500.60544.0.001.cpuprofile
  - .github/skills/spectra-audit/SKILL.md
  - src/domain/order/commands.ts
  - src/infrastructure/event-store/postgres-event-store.ts
  - .opencode/commands/spectra-discuss.md
  - components/checkout/checkout-action.tsx
  - src/domain/inventory/commands.ts
  - src/infrastructure/catalog/postgres-catalog-repository.ts
  - src/application/payment/payment-compensation.ts
  - .opencode/commands/spectra-ingest.md
  - app/api/internal/checkout-intents/[checkoutIntentId]/complete-demo/route.ts
  - scripts/reset-dev-db.ts
  - src/ports/checkout-demo-repository.ts
  - frontend/design-pattern.html
  - src/domain/events/event-metadata.ts
  - .github/skills/spectra-propose/SKILL.md
  - .github/prompts/spectra-debug.prompt.md
  - components/checkout/product-detail-page.tsx
  - src/application/projections/process-projections.ts
  - src/infrastructure/catalog/static-catalog-repository.ts
  - src/infrastructure/catalog/catalog-row-mapper.ts
  - src/domain/events/domain-event.ts
  - src/ports/id-generator.ts
  - src/ports/clock.ts
  - src/ports/catalog-repository.ts
  - .opencode/skills/spectra-audit/SKILL.md
tests:
  - src/domain/schema-rules.test.ts
  - src/application/checkout/create-checkout-intent.test.ts
  - src/domain/inventory/sku-inventory-aggregate.test.ts
  - src/application/payment/payment-compensation.test.ts
  - src/application/projections/process-projections.test.ts
  - src/application/inventory/reserve-inventory.test.ts
  - app/page.test.tsx
  - src/infrastructure/catalog/postgres-catalog-repository.test.ts
  - src/application/checkout-saga/checkout-reservation-saga.test.ts
-->
