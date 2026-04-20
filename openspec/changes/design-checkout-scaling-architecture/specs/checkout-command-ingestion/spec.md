## ADDED Requirements

### Requirement: Checkout Command Ingestion

The system SHALL support asynchronous checkout command ingestion that separates
command acceptance from durable checkout fact creation while preserving
PostgreSQL as the durable source of truth.

#### Scenario: Command acceptance is acknowledged before durable fact creation

- **WHEN** a client submits a buy-intent request through the async command path
- **THEN** the system SHALL return command acceptance independently from final checkout event creation
- **AND** the response SHALL include a polling-friendly command identity

#### Scenario: Queue-first ingestion buffers burst traffic

- **WHEN** checkout commands arrive faster than downstream durable append capacity
- **THEN** the system SHALL buffer accepted commands in a queue-first ingestion path before final event-store merge

#### Scenario: Command bus does not require broker reply

- **WHEN** a client submits a buy-intent request through the async command path
- **THEN** the system SHALL acknowledge command acceptance without waiting for a broker reply message carrying the final outcome
- **AND** final outcome retrieval SHALL come from a queryable command-status surface

#### Scenario: Merge phase establishes the final business fact

- **WHEN** an accepted command is processed successfully
- **THEN** the merge phase SHALL append the resulting checkout domain event into PostgreSQL `event_store`
- **AND** the business fact SHALL be established only after that commit succeeds

#### Scenario: Staging merge deduplicates duplicate commands

- **WHEN** the staging and merge path receives repeated deliveries of the same command
- **THEN** the merge phase SHALL deduplicate duplicate commands before appending a new durable checkout event
- **AND** command-level dedupe SHALL be treated as part of staging/merge responsibilities, not only as an ingress concern

#### Scenario: At-least-once delivery is tolerated through idempotent processing

- **WHEN** the command bus redelivers a command one or more times
- **THEN** the system SHALL tolerate repeated delivery through idempotent staging and merge behavior
- **AND** the resulting business outcome SHALL remain stable even when duplicate deliveries are observed inside the pipeline

#### Scenario: Polling may later evolve into SSE without replacing command transport

- **WHEN** the system later introduces SSE or another push channel for client updates
- **THEN** the client-delivery mechanism SHALL be allowed to evolve without replacing the command bus used for command ingestion
