## Why

The checkout benchmark can now confirm throughput, latency, and projection lag, but it still cannot explain where CPU time is going inside the app process when ingress slows down. We need repeatable profiling artifacts tied to each benchmark run so bottleneck analysis moves from intuition to evidence.

## What Changes

- Add benchmark-managed CPU profiling for the app process during a benchmark run
- Store profile output as external files under the benchmark results tree instead of embedding large profile payloads in the JSON artifact
- Extend benchmark JSON artifacts with profiling metadata and file references
- Extend the internal benchmark dashboard with profiling visibility and direct open/view actions for captured flamegraph-compatible profiles
- Define run conditions, scope, and failure behavior for optional profiling capture

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `checkout-postgres-baseline`: Benchmark artifacts and dashboard behavior will expand to include optional CPU profiling references and flamegraph viewing support

## Impact

- Affected specs: `checkout-postgres-baseline`
- Affected code: benchmark runner scripts, benchmark artifact schema, internal benchmark dashboard, profile capture helpers, profile viewer route or page
- Affected systems: local benchmark artifact storage, Node.js app runtime profiling, operator bottleneck analysis workflow
