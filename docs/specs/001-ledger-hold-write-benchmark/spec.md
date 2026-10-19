# Spec 001: Ledger HELD single-row write benchmark

Status: Draft
Date: 2026-10-19
Traceability: draft (becomes `enforced` in the PR that starts the implementation)
Builds on: Redis-gate discussion in `/Users/unknowntpo/repo/unknowntpo/minishop/research/redis-gate-vs-current-pattern-language.html`; supersedes the parked Spectra change `add-ledger-hold-write-benchmark`

## Intent

The team is evaluating a Redis-gate design in which every sold ticket becomes one `HELD` row in a ledger table, and plans to batch those writes (about 1,000 rows per commit). Nobody knows what the unbatched write costs through the Go backend, so nobody can say how much batching gains.

Outcome: a measured baseline of requests per second and latency for one autocommit `INSERT` per HTTP request, on local OrbStack and on the morefine `bench-swarm` VMs, with every point verified against the database. The batching spec will be measured against this baseline.

## Evidence

- No ledger table, Redis client, or batch writer exists in `/Users/unknowntpo/repo/unknowntpo/minishop/main` (commit `fc4df39`).
- Existing write benchmarks do not answer the question:
  - The synchronous Postgres baseline measured 516–1,134 rps, but each request appends to `event_store` with a read-back, and the load came from the Node fetch generator. That generator capped earlier results at 1–2k rps (`docs/blog-series/minishop-architecture/06-full-http-seckill-bottleneck.md`).
  - All 37 NATS-path artifacts report `created=0`, so they measure acceptance only, not writes.
- The trusted load generator `scripts/go-seckill-http-loadgen/main.go` can only post to `/api/buy-intents`; the path is hard-coded at line 226.

## Example

Captured 2026-10-19T02:30Z.

**Postgres.** A throwaway `postgres:17` container, the same image `docker-compose.benchmark.yml` uses with no config overrides:

| Setting | Value |
| --- | --- |
| version | PostgreSQL 17.9 (Debian 17.9-1.pgdg13+1), aarch64 |
| `synchronous_commit` | on |
| `fsync` | on |
| `max_connections` | 100 |
| `shared_buffers` | 128MB |
| `wal_level` | replica |

**Connection pool.** `DATABASE_POOL_MAX` defaults to 8 in `services/go-backend/main.go:798`, but `docker-compose.benchmark.yml:89` sets it to 16. Earlier swarm benchmarks therefore ran with 16.

**morefine host.** Reached only through `ssh morefinepublic`. It has 4 CPUs and 31 GB RAM, and it also runs a k0s cluster with Kafka, Flink, and ClickHouse. VM `bench-swarm-01a` is running; `bench-swarm-02` and `bench-swarm-03` are shut off.

**Input and expected output.**

```http
POST /api/internal/benchmarks/ledger-hold
{"eventId": "run-20261019-c64-p16", "userId": "run-20261019-c64-p16-u-41", "ticketNo": 42}
```

Expected: `201 {"orderId": "<uuid v4>", "status": "HELD"}`. `ledger_order` then has one row with that event, user, and ticket, `status = 'HELD'`, and `expires_at` exactly 10 minutes after the database time of the insert.

## Behavior

1. **Table.** `ledger_order(order_id uuid PRIMARY KEY, event_id text NOT NULL, user_id text NOT NULL, ticket_no integer NOT NULL CHECK (ticket_no >= 1), status text NOT NULL CHECK (status IN ('HELD','PAID','CANCELLED')), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`.
   - Indexes: `ledger_order_event_ticket_active_unique` on `(event_id, ticket_no)` and `ledger_order_event_user_active_unique` on `(event_id, user_id)`, both `WHERE status IN ('HELD','PAID')`. No other secondary index.
   - Who needs it: the Redis-gate design. The partial predicate encodes the agreed rule that a cancelled user re-enters the normal flow and can buy again.
2. **Insert endpoint.** `POST /api/internal/benchmarks/ledger-hold` with `{eventId, userId, ticketNo}` runs exactly one autocommit `INSERT`: a new UUID v4 `order_id`, `status 'HELD'`, `expires_at = now() + interval '10 minutes'`. No explicit transaction, no read, no other table. It responds `201 {orderId, status: "HELD"}`. It is served by the default `net/http` engine only.
3. **Conflict mapping.** A unique violation responds `409` with code `ticket_taken` or `user_has_hold`, chosen by constraint name, and writes nothing. Any other database error responds `500` with code `ledger_write_failed`.
   - Who needs it: the batching spec, which must classify conflicts the same way.
4. **Input validation.** The endpoint responds `400 invalid_request` when the body is not JSON, when `eventId` or `userId` is empty or longer than 128 characters, or when `ticketNo` is missing, not an integer, or less than 1. Any method other than `POST` gets `405`.
5. **Load generator scenario.** `-scenario ledger-hold` sends request `i` (0-based) with `eventId = <run-id>`, `userId = <run-id>-u-<i>`, `ticketNo = i + 1`, and counts only `201` as accepted. Without the flag, or with `-scenario buy-intents`, the payload and path are unchanged.
6. **Matrix runner.** `scripts/swarm-benchmark.sh run-ledger-hold` runs concurrency {16, 64, 256} × `DATABASE_POOL_MAX` {16, 64}, 100,000 requests per point, with a unique run id per point. The same command serves both environments through `DOCKER_CONTEXT`.
7. **Verification.** After each point the runner queries Postgres directly, using `docker exec` into the `benchmark-postgres` task. It counts the run's active rows, distinct active tickets, and distinct active users, and also reads the table's total row count.
8. **Artifact.** Each point writes `benchmark-results/ledger-hold-single/<run-id>.json` with:
   - git commit and environment label (`local-orbstack` or `morefine-bench-swarm`);
   - requests, concurrency, and `DATABASE_POOL_MAX`;
   - accepted, errors, status counts, duration, rps, and latency p50/p90/p95/p99/max;
   - the verification counts and the Postgres settings from the Example table;
   - host load averages at start and end (remote only);
   - `pass`.
9. **Pass rule.** `pass` is true only when `errors = 0`, `accepted = requests`, and active rows, distinct tickets, and distinct users all equal `requests`.
10. **Run order.** The matrix runs on local OrbStack first. The remote run starts only after all local points pass. Remote access goes through `morefinepublic`; `bench-swarm-02` and `bench-swarm-03` are started before the run and shut down after it.

## Simplification review

1. **Questioned.** Each item was checked for who needs it:
   - Hertz registration: nobody. Hertz lost to `net/http` (2,245 vs 2,653 rps), and compose defaults to `nethttp`.
   - Stats endpoint: only the runner needs the counts, and it can query Postgres itself.
   - Separate runner script: duplicates `swarm-benchmark.sh`, which already runs on both OrbStack and morefine.
   - Pool size 8: matches neither earlier benchmarks (16) nor a deliberate experiment.
2. **Deleted:**
   - Hertz registration.
   - `GET /ledger-hold/stats`. Verification uses `docker exec … psql` against the benchmark Postgres task.
   - `scripts/run-ledger-hold-benchmark.sh`.
   - Pool size 8 from the matrix.
3. **Simplified:**
   - Pool sizes are 16, to compare with history, and 64, to test whether the pool is the bottleneck.
   - One runner subcommand serves both environments.
4. **Shortened the cycle.** Before the full matrix, run a 1,000-request smoke point to catch wiring errors in seconds.
5. **Automated last.** The pass rule is computed by the runner. Nothing else is automated until a second run shows a need.

## Acceptance

### Behavior
- L1: empty `ledger_order` → POST the Example body → `201`, `status HELD`, UUID `orderId`; exactly one matching row with `expires_at - created_at = 10 minutes` → Go e2e test output.
- L2: row (evt-a, u-1, 42) set to `CANCELLED` → POST (evt-a, u-1, 42) → `201`; the event has one `CANCELLED` and one `HELD` row for ticket 42 → Go e2e test output.
- L3: `-scenario ledger-hold -requests 1000 -run-id r1` → payload builder output → tickets 1–1000, 1,000 distinct users, all `eventId r1` → Go unit test output.
- L4: no `-scenario` flag → payload builder output → path `/api/buy-intents` and payload byte-identical to commit `fc4df39` → Go unit test output.

### Failure and retry
- L5: active row (evt-a, u-1, 42) → POST (evt-a, u-2, 42) → `409 ticket_taken`; row count unchanged → Go e2e test output.
- L6: active row (evt-a, u-1, 42) → POST (evt-a, u-1, 43) → `409 user_has_hold`; row count unchanged. Positive control: POST (evt-b, u-1, 42) → `201` → Go e2e test output.
- L7: each invalid body in the case table → POST → `400 invalid_request`; row count unchanged. GET → `405`. Positive control: the Example body → `201` → Go e2e test output.
- L8: backend running with Postgres stopped → POST the Example body → `500 ledger_write_failed` within the request timeout; after Postgres restarts, no row exists for that request → Go e2e test output.
- L9: a point whose verification reports active rows = requests − 1 → runner computes the artifact → `pass = false` → runner unit test (fixture JSON) output.
- L10: backend returns `409` for some requests → load generator in `ledger-hold` scenario → they are counted in `errors`, not `accepted` → Go unit test output.

### Budget
- L11: [measure] six points on `local-orbstack`, all `pass = true`, with rps and p50/p95/p99 recorded. Command: `DOCKER_CONTEXT=orbstack ./scripts/swarm-benchmark.sh run-ledger-hold`.
- L12: [measure] six points on `morefine-bench-swarm`, all `pass = true`, and host 1-minute load average ≤ 2.0 at the start of each point (rerun the point otherwise). Command: `DOCKER_CONTEXT=<morefine bench context> ./scripts/swarm-benchmark.sh run-ledger-hold`.
- L13: [measure] Postgres `max_connections` (100) exceeds the largest pool (64) times the backend replica count (1), so no point fails on connection exhaustion; checked from the artifact's recorded settings.

### Observability
- L14: [measure] every artifact contains every field listed in Behavior 8; missing fields fail the runner. Evidence: the artifact files and the report `docs/benchmark-results/ledger-hold-single-<date>.md`.

### Case table (L7)

When implementation starts, this table moves into a `.cases.json` case file that the Go e2e test reads, rendered here by `pnpm docs:test-plan`.

| Body | Expected |
| --- | --- |
| `not json` | 400 `invalid_request` |
| `{"eventId":"","userId":"u-1","ticketNo":1}` | 400 `invalid_request` |
| `{"eventId":"evt-a","userId":"","ticketNo":1}` | 400 `invalid_request` |
| `{"eventId":"<129 x a>","userId":"u-1","ticketNo":1}` | 400 `invalid_request` |
| `{"eventId":"<128 x a>","userId":"u-1","ticketNo":1}` | 201 (boundary, valid side) |
| `{"eventId":"evt-a","userId":"u-1","ticketNo":0}` | 400 `invalid_request` |
| `{"eventId":"evt-a","userId":"u-1","ticketNo":1}` | 201 (boundary, valid side) |
| `{"eventId":"evt-a","userId":"u-1","ticketNo":1.5}` | 400 `invalid_request` |
| `{"eventId":"evt-a","userId":"u-1"}` | 400 `invalid_request` |

## Non-goals

- Redis, queues, consumers, ticket allocation, and batching. Batching is the next spec and reuses this table and runner.
- Payment, expiry processing, and release. `PAID` and `CANCELLED` exist only to give the indexes their final shape.
- Postgres tuning. Settings are recorded, not changed.
- Buyer UI changes.
