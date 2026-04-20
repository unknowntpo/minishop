## 1. Architecture Contracts

- [ ] 1.1 Define `CommandAccepted` request/response, ingress contract, and polling-first client contract for asynchronous checkout command ingestion
- [ ] 1.2 Define `command_id`, `correlation_id`, `checkout_intent_id`, and domain `event_id` responsibilities so identity boundaries stay clear
- [ ] 1.3 Define why PostgreSQL remains the business fact boundary while the modified `Checkout Intent Creation` requirement exposes command lifecycle state separately
- [ ] 1.4 Define the polling contract and capture the polling first versus push first trade-off while explaining why the client contract uses polling first before push or SSE is introduced
- [ ] 1.5 Capture the PG-first direct append versus queue-first command ingestion trade-off so the design is publishable and reviewable as architecture writing
- [ ] 1.6 Define why command completion is read from `command_status` rather than a broker reply channel and capture the broker reply versus status-store reply trade-off

## 2. Command Pipeline Design

- [ ] 2.1 Define queue-first command ingestion through NATS JetStream command-bus responsibilities and ingress-to-worker buffering boundaries
- [ ] 2.2 Define staging-table schema responsibilities and state why staging plus merge, not direct `COPY` into `event_store`, is required
- [ ] 2.3 Define dedicated merge worker behavior including batch claim, validation, command-level dedupe, idempotency dedupe, append, and `command_status` state transitions
- [ ] 2.4 Define committed-event fan-out and event contract responsibilities after PostgreSQL commit succeeds
- [ ] 2.5 Capture the NATS JetStream command bus versus no command bus trade-off, the optional downstream event streaming after commit trade-off, and the direct `COPY` into `event_store` versus staging plus merge trade-off
- [ ] 2.6 Capture the command dedupe versus business idempotency dedupe trade-off
- [ ] 2.7 Define at-least-once command delivery and idempotent processing expectations and capture the exactly-once transport versus idempotent processing trade-off

## 3. Worker and Control Plane Design

- [ ] 3.1 Define how Temporal orchestrates workflow state, not durable facts, without replacing PostgreSQL as the source of truth for durable facts
- [ ] 3.2 Define worker role boundaries for command ingest, staging merge, projection, and notification execution
- [ ] 3.3 Define whether worker roles ship as one binary with role flags or as separate deployables while preserving clear responsibility boundaries
- [ ] 3.4 Capture the Temporal versus plain workers trade-off in a form that can be reused in architecture communication

## 4. Rollout and Observability

- [ ] 4.1 Define a first rollout phase that uses polling for client feedback and defers push/SSE notification
- [ ] 4.2 Define the minimum metrics and topology views needed to understand queue depth, worker lag, merge throughput, and command outcome distribution
- [ ] 4.3 Capture the cache acceleration versus correctness truth trade-off for future idempotency lookup optimization
