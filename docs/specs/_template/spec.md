# Spec NNN: Title

Status: Draft
Date: YYYY-MM-DD
Traceability: draft (set to `enforced` when implementation starts)
Builds on: (specs / ADRs)

## Intent

Who has which problem, and what observable outcome solves it.

## Evidence

Measurements or incidents that motivate the change.

## Example

A worked example on real data: actual values from the running system
(captured at a stated time), the input, and the expected output.

## Behavior

Numbered rules the implementation must follow. Each new field or component
names who needs it. Every boundary named here gets a case on each side.

## Simplification review

1. Questioned (who needs each item and why):
2. Deleted:
3. Simplified:
4. Shortened the cycle:
5. Automated last:

## Acceptance

Each item: precondition → action → observable result → evidence.
Tag items proven only after deployment `[deploy]`, by a measurement command
`[measure]`; untagged items must have a test whose name contains `<ID>:`
(Vitest `test`/`it`/`describe`, Ginkgo `Describe`/`It`/`Entry`, or Go
`t.Run`), or a row in this spec's test-plan case file.

Generated test plan (rows live in a `.cases.ts` module exporting
`testPlanRows` or a `.cases.json` array; run `pnpm docs:test-plan`):

<!-- test-plan:start docs/specs/NNN-slug/example.cases.json -->
<!-- test-plan:end -->

### Behavior
- X1:

### Failure and retry
- X2:

### Budget
- X3: [measure] (limit, measured value, command)

### Observability
- X4: [deploy]

## Non-goals
