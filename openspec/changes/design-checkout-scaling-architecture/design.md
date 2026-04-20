## Context

The current buy flow establishes the durable checkout fact directly in the request path by appending `CheckoutIntentCreated` into PostgreSQL. That keeps the contract simple, but it makes client latency and burst handling depend on synchronous append capacity.

The desired next step is different:

- API should acknowledge command acceptance quickly
- command throughput should be buffered and rate-shaped by backend workers
- durable domain fact creation should still happen in PostgreSQL
- client feedback should first use polling, with push/SSE left for a later phase

This means the architecture must explicitly distinguish command lifecycle from domain-event lifecycle.

## Goals / Non-Goals

**Goals**

- Preserve PostgreSQL `event_store` as the source of truth for durable business facts
- Introduce a queue-first ingestion path that can absorb burst traffic
- Separate `CommandAccepted` from `CheckoutIntentCreated`
- Make worker concurrency and merge throughput controllable by the platform
- Support batch-oriented staging and `COPY`-based ingestion before final event-store merge
- Keep the client contract observable through `command_status` and polling

**Non-Goals**

- Replace PostgreSQL with Kafka or Temporal as the source of truth
- Finalize a full SSE/WebSocket notification design in this change
- Commit to one exact worker runtime implementation detail for all future phases
- Implement the new architecture in this change

## Decisions

### PostgreSQL remains the business fact boundary

`CheckoutIntentCreated` becomes true only when it is durably appended to PostgreSQL `event_store`.

`CommandAccepted` is not a checkout fact. It only means the system has accepted responsibility for processing the command.

This preserves the existing event-sourcing truth boundary while allowing the client-facing contract to become asynchronous.

### Queue-first command ingestion

The ingress API will validate the request, create `command_id` and `correlation_id`, persist command acceptance state, start or signal the orchestration layer, and publish a `BuyIntentCommand` to a NATS JetStream command bus.

NATS JetStream remains in front of the write workers because it provides burst absorption, decoupling, ack/retry semantics, and controllable consumer concurrency. Temporal does not replace this buffering role.

The command bus is one-way for this flow. The system does not depend on broker-level request-reply for command completion. Client-visible completion comes from `command_status`, first through polling and later, if needed, through SSE or other push delivery.

### Temporal orchestrates workflow state, not durable facts

Temporal sits in the command orchestration layer. It owns retry, timeout, workflow visibility, and lifecycle coordination for command processing.

Temporal does not replace the event store, and it does not become the durable source of business truth. PostgreSQL remains the place where `CheckoutIntentCreated` is established.

### Temporal is not tracing, and tracing is not orchestration

Distributed tracing and telemetry remain required in this architecture, but they solve a different problem.

Telemetry answers questions such as:

- which services participated in a request or command path
- where latency accumulated
- which hop failed
- how logs, metrics, and traces correlate

Temporal answers different questions:

- which workflow instance currently owns a command lifecycle
- which state transition the command is waiting on
- whether retries, timers, and external signals should still execute after process restarts
- how long-running orchestration state is resumed and inspected

In other words:

- telemetry is the observability layer
- Temporal is the workflow control layer

The design therefore does not treat OpenTelemetry or distributed tracing as a substitute for Temporal. Tracing is still necessary for debugging and performance analysis, but tracing alone does not provide durable workflow state, timers, signals, or resumable orchestration semantics.

### Why keep Temporal in this design at all

The current `buy-intent` path is intentionally modest: accept a command, stage it, merge it, append the durable event, and expose status through polling. That narrow scope means a plain NATS-plus-worker model would be viable.

Temporal is still kept in the design because this command path is not the intended endpoint. It is the control-plane foundation for a longer checkout lifecycle that is expected to grow into:

- inventory reservation coordination
- payment coordination
- expiration and timeout handling
- compensation flows
- multi-step command outcome visibility across restarts and deploys

The architectural decision is therefore not "Temporal is required to make async ingestion work today." The real decision is "Temporal is reserved for orchestration because the broader checkout lifecycle is expected to need orchestration soon, and we want that boundary established before the worker surface expands."

This keeps the responsibilities explicit:

- NATS JetStream buffers commands and shapes throughput
- PostgreSQL establishes business facts
- Temporal tracks orchestration lifecycle
- telemetry explains what happened operationally

### Criteria for removing Temporal later

Temporal should remain under scrutiny rather than becoming irreversible infrastructure. If the checkout backend stays limited to short-lived queue consumption plus deterministic merge writes, and does not grow meaningful needs for timers, signals, or multi-step compensation, then plain workers would likely be the simpler design.

The architecture should therefore revisit the Temporal dependency if most of the following remain true:

- command processing stays single-stage after staging
- retries are local worker concerns rather than workflow concerns
- no workflow timers or delayed wakeups are needed
- no cross-service compensation steps are introduced
- operator visibility from `command_status` plus telemetry is sufficient

If those conditions hold for the medium term, removing Temporal would be a reasonable simplification. Until then, the design keeps Temporal deliberately scoped to orchestration and forbids it from expanding into business-fact storage or general-purpose messaging.

### Staging plus merge, not direct `COPY` into `event_store`

Workers may use `COPY` for throughput, but the `COPY` target should be a staging table rather than the final `event_store`.

This staging step isolates:

- malformed command payloads
- duplicate commands
- duplicate or replayed commands
- retryable merge failures
- per-command result accounting

The final append semantics, validation, dedupe, and status transition happen in a dedicated merge phase.

### Dedicated merge worker behavior

The merge phase should be explicit. Whether implemented in a separate worker binary mode or in the same deployable process with a different role flag, the merge responsibility is distinct:

- process staged buy intent commands
- validate payload and domain prerequisites
- reuse existing append business logic
- dedupe duplicate commands at the staging/merge boundary via `command_id`
- dedupe replayed business intents via `idempotency_key`
- dedupe retried event writes via event identity where applicable
- append to `event_store`
- update `command_status`

This design avoids coupling command-bus consumer throughput directly to final event-store insertion semantics.

### Client contract uses polling first

The client receives `202 Accepted` with `command_id` and `correlation_id`.

The client then polls a `command_status` endpoint to observe:

- `accepted`
- `processing`
- `created`
- `duplicate`
- `failed`

Push-based notification is deferred to a later phase.

### At-least-once command delivery and idempotent processing

The architecture does not require end-to-end exactly-once delivery at the broker layer for the first rollout.

Instead it relies on:

- at-least-once command delivery from NATS JetStream
- idempotent processing in staging and merge
- duplicate command detection via `command_id`
- business-intent replay detection via `idempotency_key`
- durable append protection in PostgreSQL

This favors effectively-once business outcomes over stricter and more expensive transport guarantees.

## Target Dataflow

```text
[Client]
   |
   | POST /buy-intents
   v
[Ingress API]
   |
   | validate
   | create command_id + correlation_id
   | persist command_status = accepted
   | start Temporal workflow
   | publish BuyIntentCommand
   | return 202 + command identity
   v
[NATS JetStream: buy-intent-commands]
   |
   v
[Command Ingest Worker]
   |
   | batch + COPY
   v
[staged_buy_intent_commands]
   |
   v
[Merge Worker]
   |
   | validate
   | dedupe
   | append event_store
   | update command_status
   v
[PostgreSQL event_store]
   |
   +--> BUSINESS FACT ESTABLISHED HERE
   |
   v
[outbox / committed-event relay]
   |
   +--> projection worker
   +--> SSE / notification gateway (later)
   +--> analytics / downstream systems (optional later via Kafka)
```

### Write Path Diagram

```text
+------------------------+        publish BuyIntentCommand         +------------------------+
|       Browser/UI       | -------------------------------------> |     Next.js App        |
|------------------------|                                        |------------------------|
| POST /api/buy-intents  | <------------------------------------- | 202 Accepted           |
+------------------------+      command_id + correlation_id       | command acceptance     |
                                                                    +-----------+------------+
                                                                                |
                                                                                | publish command
                                                                                v
                                                                    +------------------------+
                                                                    |   NATS JetStream       |
                                                                    |------------------------|
                                                                    | BUY_INTENT_COMMANDS    |
                                                                    +-----------+------------+
                                                                                |
                                                                                | consume
                                                                                v
                                                                    +------------------------+
                                                                    | worker-buy-intents-    |
                                                                    | ingest                 |
                                                                    |------------------------|
                                                                    | NATS -> staging        |
                                                                    +-----------+------------+
                                                                                |
                                                                                | insert raw command
                                                                                v
+------------------------+                                      +------------------------+
|     PostgreSQL         | <----------------------------------- | staging_buy_intent_    |
|------------------------|                                      | command                |
| command_status         |                                      |------------------------|
| staging_buy_intent...  |                                      | payload_json           |
| event_store            |                                      | ingest_status=pending  |
| projection tables      |                                      +-----------+------------+
+-----------+------------+                                                  |
            ^                                                               | process staged commands
            |                                                               v
            |                         +-------------------------------------+------------------+
            |                         |                                                        |
            |                         v                                                        v
            |             +------------------------+                              +------------------------+
            |             | worker-buy-intents-   |                              | worker-buy-intents-   |
            |             | process (bypass lane) |                              | temporal              |
            |             |------------------------|                              |------------------------|
            |             | mark processing        |                              | workflow orchestration |
            |             | append CheckoutIntent  |                              | append domain events   |
            |             | update command_status  |                              | update command_status  |
            |             +-----------+------------+                              +-----------+------------+
            |                         |                                                       |
            +-------------------------+-----------------------------+-------------------------+
                                                              write created/failed
```

### Read Path Diagram

```text
+------------------------+
|       Browser / UI     |
|------------------------|
| poll projection        |
| poll receipt/status    |
+-----------+------------+
            |
            | GET /api/checkout-intents/:id
            | GET /api/buy-intent-commands/:id
            v
+------------------------+
|      Next.js App       |
|------------------------|
| query APIs             |
+-----------+------------+
            |
            | read models / status
            v
+------------------------+           replay committed events        +------------------------+
|      PostgreSQL        | <-------------------------------------- | worker-projections     |
|------------------------|                                         |------------------------|
| event_store            | --------------------------------------> | update read models     |
| projection tables      |           read committed events         +-----------+------------+
| command_status         |                                                     |
+------------------------+                                                     |
                                                                 update projection tables
```

### Worker Responsibility Split

```text
worker-buy-intents-ingest
  NATS -> staged_buy_intent_command

worker-staged-buy-intents-process
  process staged buy intent commands
  -> command_status + event_store              (bypass lane)

worker-buy-intents-temporal
  process staged buy intent commands
  -> Temporal workflow
  -> command_status + event_store

worker-projections
  event_store -> projection tables
```

## Contracts

### Ingress contract

`POST /buy-intents` returns `202 Accepted` after command acceptance, not after durable checkout fact creation.

The response includes:

- `command_id`
- `correlation_id`
- `status = accepted`

The command bus does not need to carry a broker reply back to the client. The API response is based on command acceptance, and final outcome is retrieved from queryable status.

### Polling contract

`GET /buy-intent-commands/:command_id` returns lifecycle state for the command and, when available, the resulting `checkout_intent_id`.

The same contract may later be exposed through SSE without changing the write path. SSE is an optional client-delivery upgrade, not a reason to replace NATS JetStream in command ingestion.

### Event contract

`CheckoutIntentCreated` is published to downstream consumers only after PostgreSQL commit succeeds. Downstream fan-out may use an outbox or committed-event relay.

## Risks / Trade-offs

- [More moving parts than direct append] -> Mitigation: keep responsibility boundaries explicit and make `command_status` the primary operator-facing truth for command lifecycle
- [NATS JetStream + Temporal overlap conceptually] -> Mitigation: use NATS JetStream for command buffering/distribution and Temporal for workflow orchestration; do not let both own the same concern
- [`COPY` optimization complicates append semantics] -> Mitigation: land batches in staging first and keep final append semantics in a merge phase
- [Polling adds intermediate client complexity] -> Mitigation: make command status explicit and leave push delivery as a later enhancement

## Trade-off Discussion

### PG-first direct append versus queue-first command ingestion

The existing direct-append path has one clear strength: the API response can mean that the domain fact is already durable. That contract is simple and easy to reason about.

The queue-first design gives up that simplicity on purpose. The API now acknowledges command acceptance rather than durable fact creation. In exchange, the system gains burst buffering, controllable worker concurrency, and a path to batch-oriented write shaping. This is the central trade-off of the architecture.

### Why PostgreSQL remains the business fact boundary

Even though commands are accepted asynchronously, the architecture keeps PostgreSQL `event_store` as the place where `CheckoutIntentCreated` becomes true. This avoids moving the source of truth into Kafka or Temporal state.

The trade-off is that durable fact creation is still ultimately limited by event-store append capacity. The design accepts that limit and chooses to shape traffic before it reaches the append boundary instead of redefining the business fact boundary itself.

### NATS JetStream command bus versus no command bus

The command bus exists to absorb burst traffic and decouple API request rate from downstream merge throughput. Without it, Temporal plus workers could still orchestrate asynchronous work, but the system would lose the queue-first buffer that motivated this change in the first place.

The trade-off is more infrastructure and more debugging surface area. We accept that cost because buffering and controlled consumer concurrency are explicit goals of the architecture.

### Optional downstream event streaming after commit

The design keeps open the option of relaying committed events into Kafka or another stream system after PostgreSQL commit. This is intentionally separate from command ingestion.

The trade-off is that the system may eventually operate both a lightweight command bus and a heavier stream-processing/event-distribution layer. That adds infrastructure, but it lets command messaging and downstream streaming be optimized separately. Kafka, if introduced later, exists for committed-event distribution, replay, analytics, and OLAP-oriented consumers, not for first-hop command ingestion.

### Temporal versus plain workers

Temporal is introduced as workflow orchestration, not as durable fact storage. Its value is visibility, retries, timeout handling, and command-lifecycle coordination.

The trade-off is conceptual and operational complexity. A plain worker model would be simpler to deploy, but harder to observe and reason about for long-running asynchronous command lifecycles. This design keeps Temporal only where orchestration adds value and avoids making it the system of record.

### Temporal versus telemetry

Temporal and telemetry are complementary, not competing choices.

If only telemetry is added, operators gain better traces and metrics, but the system still relies on ad hoc worker code and database rows to express orchestration state. If Temporal is added without telemetry, operators gain workflow visibility but still lose latency breakdowns, infrastructure-level traces, and cross-service debugging depth.

For this reason, the intended stack is:

- Temporal for orchestration semantics
- `command_status` for product-facing query state
- telemetry for traces, metrics, and logs across app, broker, worker, and database edges

The design rejects the idea that "adding tracing later" removes the need for orchestration, just as it rejects the idea that "using Temporal" removes the need for distributed tracing.

### Temporal TypeScript worker versus Go worker

The first implementation pass validated that Temporal belongs in the orchestration layer, but it also exposed that a TypeScript worker inside the current Next.js-oriented repository creates additional runtime coupling:

- native bridge compatibility and package-manager build-script policy
- workflow bundling constraints that do not automatically honor application import aliases
- pressure to keep the app and the orchestration worker on the same Node runtime assumptions even though they are different operational roles

For this reason, the design now prefers a Go Temporal worker for the long-term orchestration service, while keeping the TypeScript skeleton as a temporary exploration and contract reference.

The trade-off is explicit:

- a Go worker reduces worker-runtime complexity and avoids the Temporal TypeScript native/bundling integration surface
- but it forces stricter contract design because command schema, workflow input/output, and error vocabulary can no longer rely on in-process TypeScript reuse

This trade-off is acceptable and intentional. The worker is treated as a separate deployable service, not as an extension of the web application runtime.

### Shared app/worker images versus separated deployables

The design also prefers separate Dockerfiles and runtime images for:

- the web application
- backend command workers
- the Temporal orchestration worker

This avoids letting one runtime's constraints dictate another runtime's base image or Node version. It also matches the decision to treat the orchestration worker as an independent service boundary.

### Direct `COPY` into `event_store` versus staging plus merge

The design rejects direct `COPY` into `event_store` even though it may look like the fastest write path. The reason is semantic, not just technical. Final event append requires validation, dedupe, result accounting, and business-fact establishment.

Staging plus merge is slower to describe but cleaner to operate. It creates a landing zone for malformed commands, duplicate commands, replayed intents, and retryable failures before the final append boundary. The trade-off is one more phase in the write path in exchange for clearer correctness and observability.

### Command dedupe versus business idempotency dedupe

The architecture intentionally separates duplicate command handling from business-intent replay handling.

- `command_id` answers whether the same submitted command has already been seen
- `idempotency_key` answers whether the same business action has already produced a result

Treating them as one mechanism would simplify the schema but blur the operational model. The trade-off here is additional identity fields in exchange for clearer lifecycle semantics and better debugging.

### Polling first versus push first

Polling is chosen for the first rollout because it keeps the async contract visible without forcing notification infrastructure into the critical path. Push-based delivery is still expected later, but it is intentionally deferred.

The trade-off is less polished client experience in early phases, in exchange for a simpler and more debuggable first implementation of the asynchronous command lifecycle.

### Broker reply versus status-store reply

The design intentionally avoids a command reply channel on NATS JetStream. Request-reply would tighten coupling between client completion and broker-side execution, while the architecture already has a durable lifecycle surface in `command_status`.

The trade-off is one more query step for the client in exchange for a simpler command bus and cleaner separation between command transport and outcome retrieval.

### Exactly-once transport versus idempotent processing trade-off

The design does not pursue end-to-end exactly-once transport in the first phase. Doing so would add cost and complexity across broker, worker, and storage boundaries.

Instead the architecture accepts at-least-once delivery and invests in idempotent processing, staging dedupe, merge-phase replay handling, and durable uniqueness guarantees. The trade-off is that duplicates may be observed inside the pipeline, but the business outcome remains stable.

### Cache acceleration versus correctness truth

The design assumes that correctness comes from durable storage, not from cache or probabilistic filters. Redis or other caches may later accelerate idempotency lookup, but they must not become the only decision point.

The trade-off is that the system may retain a durable lookup dependency in the hot path, but it avoids correctness regressions caused by cache loss or probabilistic false positives.

## Open Questions

- Which serialization format should become the authoritative cross-language contract for the Go worker path: JSON-first, Protobuf, or another schema-governed format?
- Which command-status updates should remain in the app database in phase one, and which orchestration details should stay internal to Temporal only?

- Should command acceptance itself be written to PostgreSQL synchronously before publishing to NATS JetStream, or should Temporal own the initial durable status record?
- Should merge workers process one command per transaction or support multi-command transaction batches when commands target disjoint aggregates?
- Should the first implementation use one shared worker binary with role flags, or separate deployables for ingest and merge roles?
