# Gardening list

Known workarounds, stale docs, excluded checks, and follow-ups (see
`docs/process/workflow.md`). Each item names its source and the trust layer its
fix belongs in. A gardener pass fixes or deletes an item and removes it here.
Reserve the next `G` number when briefing parallel agents.

## Excluded CI checks

Observed on `origin/main` @ `d52c863`, Node 24.15.0, 2026-10-19.

- **G1. `pnpm typecheck` fails.** Two `TS2345` errors in
  `scripts/benchmark-buy-intent-temporal.ts` (572:57 and 764:57): `report` is
  not assignable to the parameter of `buildMeasurementsFromReport`, because
  `requestPath.kafkaDeliveryMetricSource` is typed `string` where the
  parameter expects `"directKafkaProducer" | "prometheus" | "backendTimings" |
  "unavailable"`. Layer: static check (add to CI once fixed).
- **G2. `pnpm lint` fails.** Biome reports 48 errors and 10 warnings across
  existing files. Layer: static check (fix or adjust `biome.json`, then add to
  CI).
- **G3. `pnpm test` fails.** Vitest also collects
  `e2e/buyer-web-go-backend.spec.ts` (a Playwright test: "did not expect
  test.describe() to be called here"), and
  `src/integration/checkout/async-buy-intent-command-flow.test.ts` runs
  `docker compose up -d postgres`. Fix: exclude `e2e/**` and integration tests
  from `vitest run`, with a separate Docker-backed command. Layer: tests in CI.
- **G4. `pnpm deps:check` fails.** Three dependency-cruiser violations:
  `src/domain/events/event-metadata.ts → src/ports/trace-carrier.ts`
  (domain-is-independent), and
  `src/application/checkout/{accept-buy-intent-command,process-staged-buy-intent-command-batch}.ts
  → src/infrastructure/telemetry/otel.ts`
  (application-does-not-import-delivery-or-infrastructure). Layer: structure.

## Historical and stale docs

- **G5. Spectra leftovers.** `openspec/` and `.claude/skills/spectra-*` come
  from Spectra, which is no longer used. Decide whether to delete them or move
  the still-useful designs under `docs/`. Layer: structure (delete).
- **G6. Design drift: Temporal.**
  `openspec/changes/design-checkout-scaling-architecture/design.md` (lines
  81–114, 596) says Temporal is kept for orchestration; no Temporal service or
  client remains in `docker-compose.yml` or `src/`. Layer: docs (mark
  superseded or delete with G5).
- **G7. Design drift: Kafka and inventory.**
  `openspec/changes/archive/2026-04-19-add-event-sourced-buy-flow/design/kafka-outbox.md`
  (line 194) says Redis or Kafka must not decide inventory availability; the
  current seckill path decides it in the Kafka worker
  (`workers/kafka-seckill/src/main/kotlin/dev/minishop/seckill/Main.kt`).
  Layer: docs (an ADR for the current design).
- **G8. Spec 001 cites a file outside the repo.** "Builds on" points to
  `research/redis-gate-vs-current-pattern-language.html` under a local
  absolute path that public readers cannot open. Layer: docs.

## Missing verification kit and tests

- **G9. No feature map or verification CLI.** There is no
  `docs/feature-map.md` (routes, APIs, data sources, covering IDs) and no
  `verify:*` / `measure:*` commands, so each verifier rebuilds its harness.
  Add them with the first spec that needs them. Layer: tooling.
- **G10. Go has no unit tests.** The only `_test.go` files are the
  Docker-based Ginkgo suite in `services/go-backend-e2e`, so CI's `go test`
  only compiles. `scripts/go-seckill-http-loadgen` has no `go.mod`; CI vets it
  by file, and Spec 001's L3/L4 unit tests need a module or package for it.
  `workers/kafka-seckill` (Kotlin) has no tests. Layer: tests.
- **G11. Spec 001's L7 case table is hand-written.** Move it to a
  `.cases.json` case file read by the Go e2e test when the spec becomes
  `enforced`. Layer: gate (`check:test-plan`).
