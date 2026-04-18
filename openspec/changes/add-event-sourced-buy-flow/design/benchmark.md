# Checkout PostgreSQL Baseline Benchmark

## Intent

The first benchmark phase is named `checkout-postgres-baseline`.

The name describes the system boundary under test:

```text
checkout:
  checkout intent ingress path

postgres:
  PostgreSQL event_store and projection tables are the only durable backend

baseline:
  repeatable reference point before Kafka, Redis, worker split, or realtime UX
```

Do not call this benchmark `day1` in code, scripts, or docs. "Day 1" describes
when the benchmark was desired, not what the benchmark proves.

This benchmark is not a full ecommerce checkout benchmark. It measures whether
a burst of Buy requests becomes durable checkout intent events without
synchronously decrementing inventory in the request path.

## Scope

Included:

```text
POST /api/checkout-intents
CheckoutIntentCreated append to event_store
idempotency-key replay behavior
projection processor catch-up after writes
checkout_intent_projection row creation
SKU inventory projection invariants after ingress
```

Excluded:

```text
Kafka
Redis cache
SSE/WebSocket
real payment provider
browser rendering
cart drawer UX
reservation worker throughput
order completion throughput
payment failure compensation throughput
```

The benchmark may create many checkout intents that remain `queued`. That is an
honest result for this phase because durable intent creation is intentionally
separate from inventory reservation.

## Scenario

Default scenario:

```text
scenario_name:
  checkout-postgres-baseline

product:
  1 hot product

sku:
  sku_hot_001

requests:
  1,000 checkout intent requests

quantity:
  1 per intent

buyer identity:
  benchmark_buyer_<index>

idempotency:
  one unique idempotency key per simulated buyer
  one duplicate replay sample for a known key

initial inventory:
  fixed seed inventory, e.g. on_hand = 100
```

The script command is:

```text
pnpm benchmark:checkout:postgres
```

The script is not part of `pnpm check`. It requires:

```text
running PostgreSQL database
applied migrations
seeded catalog/inventory projections
running Next.js app
```

For a clean local run, use:

```text
pnpm benchmark:checkout:postgres:reset
```

That command intentionally resets only a local `minishop` PostgreSQL database,
then reapplies migrations and seeds the development catalog before running the
benchmark. It is the preferred path for benchmark evidence because it removes
old demo checkouts and prior benchmark rows from the measured database state.

The reset script must refuse non-local database URLs. Benchmark repeatability is
useful only when cleanup is explicit; hidden dependence on old rows makes
projection counts and admin dashboard interpretation misleading.

The reset must clear Drizzle migration metadata together with application
tables. Otherwise a dropped application schema can be mistaken for an
already-migrated database, causing seed or benchmark setup to fail with missing
tables.

Each completed run writes a local JSON artifact:

```text
benchmark-results/
  checkout-postgres-baseline/
    <timestamp>_<run_id>.json
```

`benchmark-results/` is ignored by git. These files are local diagnostic
artifacts, not product data, migration fixtures, or domain events.

## Metrics

### Request Path

Purpose: measure whether the API can accept a high-concurrency burst and turn
each accepted request into a durable event.

Report:

```text
workload_type
sku_id
cart_sku_count
requested_buy_clicks
accepted_count
accepted_rate
error_count
http_status_distribution
error_distribution
p50_latency_ms
p95_latency_ms
p99_latency_ms
max_latency_ms
total_duration_ms
requests_per_second
```

Baseline pass gate:

```text
accepted_count == requested_buy_clicks
error_count == 0
```

Latency is report-only in the first baseline. Do not set a hard p95 target
until the benchmark runs against a stable environment. Local Next.js dev server,
Docker resource limits, and machine load can dominate early latency numbers.

### Event Store

Purpose: measure durable append behavior and idempotency safety.

Report:

```text
event_store_appended_events
event_store_last_id
append_throughput_per_second
event_type_distribution
idempotency_replay_count
duplicate_extra_event_count
aggregate_version_conflict_count
```

Baseline pass gate:

```text
event_store_appended_events == accepted_count
event_type_distribution.CheckoutIntentCreated == accepted_count
duplicate_extra_event_count == 0
```

This phase should not append inventory, payment, or order events unless the
benchmark explicitly moves into a later phase.

### Projection

Purpose: verify that projection processing catches up after the write burst.

Report:

```text
projection_processed_events
projection_duration_ms
projection_throughput_events_per_second
projection_checkpoint_last_event_id
event_store_last_event_id
projection_lag_events
projection_lag_ms
checkout_projection_count
checkout_status_distribution
```

Baseline pass gate:

```text
projection_lag_events == 0 after processor run
checkout_projection_count == accepted_count
```

For `checkout-postgres-baseline`, `queued` is an acceptable final projection
status because reservation processing is out of scope.

### Inventory Correctness

Purpose: protect the core product rule that pressing Buy does not synchronously
reserve or decrement inventory.

Report:

```text
sku_id
on_hand
reserved
sold
available
no_oversell
```

Baseline pass gate:

```text
on_hand == initial_on_hand
reserved == 0
sold == 0
available == initial_on_hand
no_oversell == true
available == on_hand - reserved - sold
```

Later reservation benchmarks will use different inventory pass gates, such as
`reserved + sold <= on_hand`.

### Idempotency

Purpose: prove that client retries do not create duplicate checkout intents.

Report:

```text
duplicate_replay_status
duplicate_replay_checkout_intent_id
duplicate_extra_event_count
```

Baseline pass gate:

```text
duplicate_replay_status in 200..299
duplicate_replay_checkout_intent_id == original checkout_intent_id for that key
duplicate_extra_event_count == 0
```

## Benchmark Phases

Use separate benchmark phases instead of one script that mixes all system
concerns.

```text
checkout-postgres-baseline:
  POST /api/checkout-intents only
  single hot SKU direct Buy pressure
  durable event ingress and projection catch-up

checkout-reservation-saga:
  intent creation plus SKU reservation processing
  no oversell under hot SKU pressure

checkout-completion-demo:
  intent creation, reservation, payment success, order confirmation
  terminal checkout and order projections

checkout-payment-failure-compensation:
  reservation, payment failure, inventory release, order cancellation
  idempotent compensation behavior

checkout-kafka-outbox:
  event_store to outbox relay to Kafka
  publish lag, duplicate publish safety, consumer replay

checkout-read-model-polling:
  read API and polling load
  product page and admin dashboard visibility under projection churn
```

Multi-SKU cart pressure should become its own benchmark phase. It answers a
different question from single hot SKU ingress:

```text
single hot SKU:
  how many direct Buy requests per second can one SKU ingress path accept?

multi-SKU cart:
  how does one checkout intent coordinate several SKU reservation attempts?
  where does all-or-nothing saga processing bottleneck?
```

Keep these separate in reports and dashboards. Mixing them would hide whether a
regression came from HTTP ingress, event append, projection catch-up, or
multi-aggregate saga coordination.

## k6 Decision

k6 is a good fit for HTTP load generation:

```text
constant arrival rate
ramping virtual users
HTTP latency percentiles
failure thresholds
CI-friendly load profile
```

k6 is not enough by itself for this project because the most important
questions are domain correctness questions:

```text
did every accepted request append exactly one event?
did idempotency prevent duplicate durable facts?
did projection checkpoint catch up?
did inventory counters stay unchanged for ingress-only benchmark?
was there any oversell?
```

Recommended path:

```text
first:
  Node benchmark script generates load and verifies PostgreSQL/domain state

later:
  k6 generates HTTP load
  Node verifier reads PostgreSQL and emits domain correctness report
```

Possible later file shape:

```text
scripts/k6/checkout-postgres-baseline.js
scripts/verify-checkout-postgres-baseline.ts
```

Do not replace domain verification with HTTP-only metrics.

## Benchmark Result Dashboard

The internal benchmark dashboard lives at:

```text
/internal/benchmarks
```

Purpose:

```text
read local benchmark JSON artifacts from benchmark-results/<scenario>/
show scenario families without hard-coding one benchmark as the only result set
show latest run health
show data-flow map
show run conditions as compact comparison tags
show evidence across runs
show bounded historical run table
show scenario-scoped plots for bottleneck hunting
keep benchmark observations separate from domain projections
```

The dashboard should use the same quiet internal admin visual language as the
projection admin page. It is an operator surface, not buyer UI.

Scenario overview:

```text
scenario name
click/select scenario to expand run comparison
click the selected scenario again to collapse run comparison
latest pass/fail
run count
latest p95 latency
latest error count
latest completion time
```

Run comparison should stay collapsed when no scenario is selected. This keeps
the page useful as more scenario families are added and makes the relationship
explicit:

```text
scenario card selected -> compare runs for that scenario
scenario card collapsed -> show only benchmark family overview
```

Data flow map:

```text
ingress:
  request/sec
  p95 latency
  HTTP errors

append:
  durable event log append throughput
  event type distribution

project:
  checkpoint position
  projection lag
  projection status distribution

verify:
  domain invariants
  idempotency replay
```

Run comparison plots:

```text
accepted rate over recent runs
request throughput over recent runs
p95 latency over recent runs
append throughput over recent runs
error count over recent runs
projection lag over recent runs
```

Each plot should explain the metric in place, preferably with a compact hover
hint or similarly low-noise affordance. Each run marker should expose the run
identifier, metric value, condition summary, and enough status context to
explain why the bar moved.

Run comparison tags:

```text
run label
pass/fail
Next.js mode
app instance count
PostgreSQL instance count
PostgreSQL pool size
HTTP concurrency
```

Diagnostic evidence matrix:

```text
request ingress:
  HTTP status distribution
  error distribution

event store:
  event type distribution

projection:
  checkout status distribution

inventory and idempotency:
  inventory counter summary
  duplicate replay status
idempotent replay flag
```

The evidence matrix exists as drilldown for changed plots. It should not compete
with the plots as the primary visual. The plotted cards answer "did a metric
move"; the matrix answers "why might it have moved" using categorical
distributions and invariant checks that are less useful as trend bars:

```text
HTTP status distribution:
  categorical, explains whether accepted rate changed because responses failed

error distribution:
  categorical, explains load-generator or application failure shape

event type distribution:
  categorical, proves which facts actually became durable

checkout status distribution:
  categorical, explains projection state at benchmark boundary

inventory/idempotency:
  invariant checks, better read as pass/fail and counter summaries
```

The page must tolerate no artifacts yet:

```text
show empty state
show pnpm benchmark:checkout:postgres command
do not fail app render when benchmark-results directory is missing
```

The dashboard must not write benchmark result data into `event_store`.
Benchmark data describes measurement runs; it is not part of the commerce
domain event stream.

Run comparison must be condition-aware:

```text
compare trends within the same scenario first
show run condition summary in history
do not treat different app modes, service counts, hardware, PostgreSQL pool
sizes, or workload shapes as equivalent
```

The dashboard is intentionally simple before k6:

```text
server-render local JSON files
no database table for benchmark history
no chart dependency unless simple CSS/SVG trends become insufficient
```

When k6 is introduced, normalize k6 output into the same artifact schema or add
a verifier output that preserves the current dashboard contract.

## Interpretation Notes

A benchmark report should be readable enough to become engineering evidence in
a technical article.

The report should clearly separate:

```text
what was requested
what was accepted by the API
what became durable in event_store
what projections caught up to
what inventory counters prove
what failed and why
what was intentionally excluded
```

Important interpretation rules:

```text
accepted != reserved
queued != failed for the ingress baseline
zero oversell is more important than throughput in the first phase
latency numbers are not meaningful without environment context
admin dashboard visibility is diagnostic, not the benchmark source of truth
```

Run conditions to include with benchmark output:

```text
hardware:
  platform
  CPU count
  CPU model
  total memory

software:
  Node.js version
  package manager
  Next.js mode, e.g. next dev or next start
  load generator implementation

services:
  Next.js app URL and instance count
  PostgreSQL host, port, database, instance count, and pool size
  Redis enabled state and instance count
  Kafka enabled state and broker count
  payment provider enabled state

workload:
  scenario name
  workload type, e.g. single_sku_direct_buy
  requested Buy clicks
  HTTP concurrency
  SKU id
  cart SKU count
  quantity per intent
  projection batch size
```

Benchmark result dashboards should display these conditions near the latest run.
Two benchmark results should not be compared as equivalent if their conditions
differ in app mode, service count, PostgreSQL pool size, load generator, or
hardware capacity.
