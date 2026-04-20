## Context

The current benchmark workflow writes one JSON artifact per run under `benchmark-results/<scenario>/` and the internal benchmark dashboard reads those files directly. The repo already contains standalone `.cpuprofile` files, but they are ad hoc diagnostics rather than first-class benchmark evidence, and the dashboard has no way to discover or open them from a run.

This change is cross-cutting because it touches the benchmark runner, artifact contract, filesystem layout, and dashboard UX. The key constraint is artifact size: profile payloads are too large to embed in the benchmark JSON, so the JSON must reference external files instead.

## Goals / Non-Goals

**Goals:**

- Capture Node.js CPU profiles in a repeatable way during benchmark runs
- Keep large profiling payloads out of the benchmark JSON artifact
- Make every profile file traceable back to one benchmark run
- Let operators open benchmark-linked profiling output directly from the benchmark dashboard
- Preserve backward compatibility for old artifacts that do not contain profiling metadata

**Non-Goals:**

- Build a full in-browser profile analysis engine with every DevTools feature
- Capture heap snapshots, allocation timelines, or database-native query plans in this change
- Require profiling on every benchmark run; profiling remains optional so baseline throughput runs stay simple
- Move benchmark artifacts into PostgreSQL or any other durable product datastore

## Decisions

### Benchmark-managed profile file references

Profile payloads will be written as separate files beneath the same scenario-specific benchmark results directory as the JSON artifact. The JSON artifact will store only metadata and relative paths, such as profile format, capture scope, and output files.

This keeps artifacts small, preserves portability inside the repo workspace, and avoids breaking the existing dashboard file scan pattern. Embedding the raw profile JSON inside the artifact was rejected because `.cpuprofile` payloads are materially larger than the existing run summary and would make dashboard reads unnecessarily heavy.

### App-process CPU profiling rather than benchmark-runner profiling

The profile target will be the benchmarked app process, not the Node.js benchmark runner process. The bottleneck question is about checkout ingress work inside Next.js and its server-side application code, so profiling the load generator would answer the wrong question.

The implementation should therefore add benchmark-controlled start/stop profiling hooks around the app runtime boundary and associate the resulting file with the benchmark run. Profiling only the runner process was rejected because it would mostly measure HTTP client work and artifact verification overhead.

### Dashboard-linked flamegraph-compatible viewer

The dashboard will expose profile references per run and provide a direct open path to a local viewer page that can load a `.cpuprofile` file from disk by reference. The viewer only needs enough functionality to inspect hot stacks and timing shape for one run.

Opening raw files without a dashboard-linked route was rejected because it breaks the benchmark evidence workflow: operators would still need to hunt for filenames and manually correlate them with runs.

### Optional profiling mode with explicit artifact metadata

Profiling will be opt-in through benchmark configuration. When enabled, the artifact will record that profiling was requested, whether capture succeeded, what files were produced, and any capture error summary if profiling failed while the main benchmark still completed.

Always-on profiling was rejected because it would distort baseline numbers and make the default benchmark path heavier than necessary.

## Risks / Trade-offs

- [Profiling overhead changes benchmark numbers] -> Mitigation: keep profiling opt-in and record profiling-enabled state in run conditions so profiled and non-profiled runs are not compared casually
- [Profile capture fails after a successful benchmark] -> Mitigation: record profiling failure metadata separately without corrupting the main benchmark artifact
- [Dashboard file references break after moving artifacts] -> Mitigation: store repo-relative paths rooted under `benchmark-results/` and validate file existence in the dashboard before rendering links
- [Viewer performance degrades on large profiles] -> Mitigation: keep the viewer focused on one profile at a time and avoid embedding the full profile inside larger benchmark list pages

## Migration Plan

1. Extend the benchmark artifact schema to include optional profiling metadata and file references.
2. Add benchmark-controlled CPU profile capture for the app process and write output files under the scenario run directory.
3. Update the dashboard reader to tolerate both old artifacts without profiling metadata and new artifacts with profiling references.
4. Add a profile viewer entry point and link it from the benchmark dashboard.
5. Validate the new change with one benchmark run that produces both a JSON artifact and an external `.cpuprofile` file.

Rollback is straightforward: disable the profiling option and ignore the new metadata fields. Existing JSON artifacts remain readable because the profiling section is additive.

## Open Questions

- Should the first implementation capture exactly one profile per run, or separate request-path and projection-processing profiles when both phases matter?
- Should the viewer render a custom flamegraph immediately, or first provide a lightweight profile summary plus raw-file open action and grow from there?
