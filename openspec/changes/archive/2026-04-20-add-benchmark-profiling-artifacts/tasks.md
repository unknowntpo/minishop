## 1. Artifact Contract

- [x] 1.1 Update Benchmark profiling artifacts schema in the benchmark JSON writer so profiling metadata stores only file references and capture status
- [x] 1.2 Implement Benchmark-managed profile file references with benchmark-results path helpers that create stable scenario-relative profile output paths for each run

## 2. Profile Capture

- [x] 2.1 Implement App-process CPU profiling rather than benchmark-runner profiling so benchmark-managed capture targets the checkout app runtime
- [x] 2.2 Implement Optional profiling mode with explicit artifact metadata and failure reporting for successful benchmark runs that miss profile capture

## 3. Dashboard and Viewer

- [x] 3.1 Implement Dashboard-linked flamegraph-compatible viewer entry points from benchmark history and selected run views
- [x] 3.2 Render Benchmark profile viewer state in the dashboard while preserving compatibility with older artifacts that lack profiling metadata

## 4. Verification

- [x] 4.1 Run one benchmark with profiling enabled and verify the JSON artifact, external `.cpuprofile` file, and Benchmark profiling artifacts references line up
- [x] 4.2 Validate the Spectra change so checkout-postgres-baseline requirements, design decisions, and tasks remain internally consistent
