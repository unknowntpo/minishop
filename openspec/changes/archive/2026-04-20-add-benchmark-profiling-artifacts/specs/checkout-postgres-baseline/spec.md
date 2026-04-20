## ADDED Requirements

### Requirement: Benchmark profiling artifacts

The benchmark system SHALL support optional Node.js CPU profiling for the benchmarked app process and SHALL persist profiling output as external files referenced by the benchmark JSON artifact rather than embedding the profile payload inline.

#### Scenario: Profiling is enabled for a benchmark run

- **WHEN** a benchmark run starts with profiling enabled
- **THEN** the system SHALL capture CPU profile data from the benchmarked app process during the run
- **AND** it SHALL write the resulting profile output under the same scenario-specific `benchmark-results/<scenario>/` tree as the benchmark JSON artifact

#### Scenario: Artifact references profile files instead of embedding them

- **WHEN** a benchmark run completes with one or more captured profile files
- **THEN** the benchmark JSON artifact SHALL store only profiling metadata and file references
- **AND** it SHALL NOT embed the raw `.cpuprofile` payload inline inside the artifact JSON

#### Scenario: Profiling metadata is explicit

- **WHEN** the benchmark writes an artifact for a run where profiling was requested
- **THEN** the artifact SHALL record whether profiling was enabled, whether capture succeeded, the profile format, and the relative file path or paths for produced profile files

#### Scenario: Profiling failure does not erase benchmark evidence

- **WHEN** request-path and projection verification complete but profile capture fails
- **THEN** the benchmark SHALL still write the main JSON artifact
- **AND** the artifact SHALL record profiling failure details separately from request, append, and projection metrics

### Requirement: Benchmark profile viewer

The benchmark dashboard SHALL surface benchmark-linked profiling references and SHALL provide a direct way to open a flamegraph-compatible view for a captured profile file.

#### Scenario: Dashboard shows profiling references for a run

- **WHEN** the internal benchmark dashboard reads an artifact containing profiling metadata
- **THEN** it SHALL show that the run has associated profiling evidence
- **AND** it SHALL expose the referenced profile file path or a derived label without requiring operators to inspect raw JSON

#### Scenario: Dashboard opens benchmark-linked profile viewer

- **WHEN** an operator selects a profiling reference from the benchmark dashboard
- **THEN** the system SHALL open a benchmark-linked profile viewer for that referenced file
- **AND** the viewer SHALL load the external profile payload by reference rather than by copying it into the benchmark list page

#### Scenario: Dashboard tolerates older artifacts without profiling data

- **WHEN** the internal benchmark dashboard reads historical artifacts created before profiling support existed
- **THEN** it SHALL continue rendering those runs without error
- **AND** it SHALL treat missing profiling metadata as absence of profiling evidence rather than as artifact corruption
