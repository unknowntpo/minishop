## MODIFIED Requirements

### Requirement: Client Polling UX

The system SHALL expose buyer-facing polling and readback contracts through backend HTTP APIs without requiring the buyer web runtime to own backend logic.

#### Scenario: Buyer polls command status from a decoupled frontend runtime

- **WHEN** a buyer-facing web frontend checks buy-intent or checkout progress after command acceptance
- **THEN** the frontend SHALL be able to read command or checkout state through backend HTTP APIs
- **AND** the polling contract SHALL NOT require Next.js API route ownership or server-side database access inside the web runtime
