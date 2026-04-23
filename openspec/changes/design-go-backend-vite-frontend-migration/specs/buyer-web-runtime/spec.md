## ADDED Requirements

### Requirement: Frontend-Only Buyer Web Runtime

The system SHALL support a buyer/admin web frontend that runs without embedding application backend logic inside the web runtime.

#### Scenario: Buyer catalog page loads

- **WHEN** the buyer opens the products page in the migrated web frontend
- **THEN** the frontend SHALL obtain catalog data through backend HTTP APIs
- **AND** the page SHALL NOT require direct database reads from a page/server runtime

#### Scenario: Buyer product detail page loads

- **WHEN** the buyer opens a product detail page in the migrated web frontend
- **THEN** the frontend SHALL obtain product detail data through backend HTTP APIs
- **AND** the route SHALL NOT require Next.js-specific server helpers to render product data

#### Scenario: Buyer checkout-complete page loads

- **WHEN** the buyer opens a checkout-complete page in the migrated web frontend
- **THEN** the frontend SHALL obtain checkout and command status data through backend HTTP APIs
- **AND** the route SHALL NOT query PostgreSQL directly from the web runtime

### Requirement: Admin Web Runtime Uses Backend APIs

The system SHALL support the admin web UI through explicit backend APIs rather than Next.js server-side repository access.

#### Scenario: Admin dashboard refreshes

- **WHEN** the admin dashboard refreshes live projection data
- **THEN** the frontend SHALL read dashboard state through backend HTTP APIs
- **AND** the refresh flow SHALL NOT depend on page-server repository access inside the web runtime

#### Scenario: Admin updates seckill config

- **WHEN** the admin enables, disables, or updates seckill configuration for a SKU
- **THEN** the frontend SHALL submit that change through backend HTTP APIs
- **AND** the update flow SHALL remain functional without Next.js API route ownership

### Requirement: Explicit Frontend-Backend Boundary

The system SHALL make the web frontend/backend boundary explicit during and after migration.

#### Scenario: Frontend is configured for backend access

- **WHEN** the migrated frontend starts in local, staging, or production-like environments
- **THEN** backend access SHALL be configured through an explicit API base URL or equivalent frontend-side backend configuration
- **AND** the frontend SHALL NOT assume same-process access to backend repositories or server-only framework helpers

#### Scenario: Backend runtime changes

- **WHEN** the backend runtime is changed independently from the frontend runtime
- **THEN** buyer/admin web functionality SHALL continue to operate through the HTTP API contract
- **AND** the frontend SHALL NOT require a bundled Next.js application runtime to preserve those capabilities
