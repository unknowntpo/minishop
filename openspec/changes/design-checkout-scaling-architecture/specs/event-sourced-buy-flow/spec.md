## MODIFIED Requirements

### Requirement: Checkout Intent Creation

The system SHALL preserve PostgreSQL `event_store` as the source of truth for
checkout domain facts even when checkout command ingestion becomes asynchronous.

#### Scenario: Command acceptance is distinct from checkout fact creation

- **WHEN** the client submits a checkout buy-intent request through the async ingestion path
- **THEN** the system SHALL acknowledge command acceptance separately from durable checkout fact creation
- **AND** acknowledging command acceptance SHALL NOT by itself mean that `CheckoutIntentCreated` has already been appended to `event_store`

#### Scenario: Durable checkout fact remains in PostgreSQL

- **WHEN** the system determines that a checkout intent has been created successfully
- **THEN** `CheckoutIntentCreated` SHALL become true only after PostgreSQL `event_store` commit succeeds
- **AND** neither Kafka command acceptance nor workflow orchestration state SHALL replace PostgreSQL as the business fact boundary

#### Scenario: Client observes async command completion through polling

- **WHEN** the client receives asynchronous command acceptance rather than direct durable fact creation
- **THEN** the system SHALL expose command lifecycle state through a polling-friendly status interface
- **AND** the interface SHALL distinguish at least `accepted`, `processing`, `created`, `duplicate`, and `failed`

#### Scenario: Queue-first ingestion preserves downstream event fan-out

- **WHEN** a checkout command succeeds and results in `CheckoutIntentCreated`
- **THEN** committed checkout events SHALL remain available for downstream projection, notification, and analytics flows after PostgreSQL commit
