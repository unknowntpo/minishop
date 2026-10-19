# Idea-to-production workflow

Status: Adopted 2026-10-19; first pilot is Spec 001
(`docs/specs/001-ledger-hold-write-benchmark/spec.md`).

Every idea becomes something a machine can judge before AI writes code for it.
AI produces drafts, code, and first reviews; tests, measurements, and the
database decide; the human owns intent, tradeoffs, and the definition of done.

This file adapts the `ai-sdd-workflow` agent skill, whose reference adoption is
`unknowntpo/oss-knowledge-base` (`docs/process/workflow.md`, `pilot-001.md`).
The skill carries the rationale; this file states the rules that apply here.
Where they differ, this file wins.

**History.** `openspec/` and `.claude/skills/spectra-*` come from Spectra, which
is no longer used. Read them as background only; do not add to them. New specs
live in `docs/specs/NNN-slug/spec.md`.

## Roles

- **Human (outer loop):** owns intent and tradeoffs. Reviews the spec's
  Example, simplification review, generated test plan, and the verifier's
  verdict, not diffs line by line.
- **Implementer agent:** the smallest change that satisfies an accepted spec,
  tests first, line-by-line self-review of its own diff.
- **Independent verifier:** a different agent (default Fable, which may
  delegate to Opus sub-agents and must check their evidence), given only the
  spec, the commit, and how to run the system. Never the implementer.
- **Machines:** CI, the traceability and test-plan gates, benchmark runners.

One intent per PR, so a verdict or a revert stays small.

## Stages

| Stage | Owner | Exit check |
| --- | --- | --- |
| 1. Intent | Human | Outcome is observable |
| 2. Assertions | AI drafts, human reviews | Every acceptance item: precondition → action → observable result → evidence |
| 3. Decision | Human; AI lists alternatives | ADR when the choice crosses features |
| 4. Slice | Implementer | Each new test seen failing before the fix |
| 5. Gates | Machine + verifier | Local → CI → benchmark environments (below); verifier verdict on the final commit |
| 6. Runtime | Machine | A violated assertion shows up in a benchmark artifact or check, not by tailing logs |

When a measurement contradicts an assertion, change the spec first, then the
code.

## Writing a spec (stages 1–2)

Copy `docs/specs/_template/spec.md`. A spec starts as `Traceability: draft`
and becomes `enforced` in the PR that starts its implementation.

1. **Example from real data.** Capture actual values from a running system
   (container settings, pool sizes, row counts) at a stated time.
2. **Simplification review, in order** (a later step never compensates for a
   skipped one): question every requirement (each item names who needs it;
   "the AI added it" is not an owner) → delete (including what already exists)
   → simplify what survived → shorten the verification cycle → automate last.
3. **Assertion classes:** Behavior; Failure and retry (at least as many items
   as Behavior); Budget (limit, measured value, committed command);
   Observability. Mark a class not applicable rather than omitting it.
4. **Acceptance IDs** (`L1`, `L2`, …) are the join key: spec ID → test name
   containing `<ID>:` → PR description → benchmark artifact. Items proven only
   by a measurement or a deployment are tagged `[measure]` / `[deploy]`.
5. **Generated test plans.** Table rows live in a case file: a `.cases.ts`
   module exporting `testPlanRows`, or a `.cases.json` array that Go table
   tests read. `pnpm docs:test-plan` renders it between
   `<!-- test-plan:start <case file> -->` and `<!-- test-plan:end -->`.
6. **Every boundary named in Behavior gets a case on each side.**

A new or changed spec is a core decision: present Intent, Example,
simplification review, and test plan, and wait for acceptance.

## Implementing (stage 4)

- Write tests first and record each one failing (command and output, or a
  mutation result). A test never seen failing proves nothing.
- **Positive control:** a test of an absence ("writes nothing", "is not
  counted") also asserts the positive case on the same input path.
- Run one mutation per acceptance behavior; list caught and surviving mutants.
  A survivor gets a new case row, not a weaker mutant.
- Test names carry the ID: Vitest `test("L5: …")`, Ginkgo `It("L5: …")` or
  `Entry("L7: …")`, Go `t.Run("L3: …", …)`. Go function names cannot contain
  `:`, so use `t.Run`.
- Self-review the diff line by line and look for something simpler.

## Independent verification (stage 5)

Prompt shape:

> Verify commit `<sha>` against `<spec path>`. Do not trust the PR text or the
> implementer's claims. For each acceptance ID, run it against the running
> system and record pass / fail / unverifiable with evidence. Run the gates.
> Run your own mutation pass and report survivors. Report spec/behavior
> mismatches even when tests pass.

- The verifier works in its own fresh worktree, keeps scratch files in its own
  scratchpad subfolder, and stops only processes and containers it started
  (no broad `pkill`, no `docker compose down` on stacks it did not start).
  Several agents share the machine and the morefine host.
- Any new commit invalidates the verdict. A conflict-free merge of `main` into
  a verified head keeps it once CI is green; a conflict resolution is new code.
- Post the per-ID verdict with evidence in the PR.

## Merge authority

`unknowntpo/minishop` is user-owned and **public**: anything merged is
published.

Align with the human first (core): new intent or behavior, ADRs, data formats
or contracts read by others (API payloads, event schemas, benchmark artifact
fields), credentials, cost, public surfaces (new public URLs or integrations),
infrastructure changes on the morefine host beyond what an accepted spec names,
and deletion or other irreversible operations. When unsure, treat it as core.

Merge without asking when all gates are green and the verifier passed the final
commit: implementations of an accepted spec, fixes restoring spec'd behavior,
tests, tooling, process docs, behavior-preserving refactors. Markdown-only PRs
(`docs/**`, `*.md`) need green gates but no verifier. Report each self-merged
PR in one line. Merge one PR at a time; a behind PR gets `main` merged in (no
rebase or force-push), CI on the new head, then
`gh pr merge <n> -R unknowntpo/minishop --match-head-commit <full sha>`.

## Gates and environments

There is no Dev or Prod deployment. Changes move through:

1. **Local** (this machine, Node 24 via `.nvmrc`, Go per module):
   - `pnpm check:traceability`: fails when an untagged acceptance ID in an
     enforced spec has no Vitest, Ginkgo, or `t.Run` test named `<ID>:`, or
     when a spec's case file is run by no test (TypeScript: imported and
     iterated with `.each`; Go: a `_test.go` file names the file).
   - `pnpm check:test-plan`: fails when a generated table differs from its case
     file; `pnpm docs:test-plan` rewrites it.
   - `pnpm test:gates`: the gates' own tests.
   - The Vitest, Go, and Ginkgo tests the spec names. Docker-backed suites run
     locally only: `pnpm test:e2e:go-backend:compose` (Ginkgo against
     `docker-compose.go-backend-e2e.yml`).
2. **CI** (`.github/workflows/ci.yml`, on pull requests and pushes to `main`):
   the three gate commands above, plus `go vet` and `go test` for every Go
   module (`go test` skips `services/go-backend-e2e`, which needs Docker).
   `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm deps:check` fail on
   `main` today and stay out of CI until fixed (`docs/gardening.md`).
3. **Benchmark environments**, in order; the remote run starts only after the
   local points pass:
   - `local-orbstack`: OrbStack Docker, compose or a single-node swarm via
     `DOCKER_CONTEXT=orbstack ./scripts/swarm-benchmark.sh …`.
   - `morefine-bench-swarm`: libvirt VMs `bench-swarm-01a/02/03` on the
     morefine homelab, reachable only through `ssh morefinepublic`. The host
     also runs a k0s cluster, so record host load with each point.

Benchmark evidence names the environment label, the commit, the command, and
the artifact path with its observed values.

## Evidence rules

- An agent's "done" or "LGTM" is not evidence.
- A merge needs the implementer's self-review, green gates, and the verifier's
  per-ID verdict with evidence on the final commit.

## Trust layers

Strongest first: structure (types, schemas, DB constraints) → static checks
(compiler, CI gates) → tests and measurements → rules (this file) → the
verifier → skills → human review. When anyone finds a defect, fix the instance,
then move the lesson to the strongest layer that can hold it and name that
layer in the PR. A note in a rule file is the last resort.

## Gardening

[`docs/gardening.md`](../gardening.md) lists known workarounds, stale docs,
excluded checks, and follow-ups, each with the trust layer its fix belongs in.
No new workaround lands without an entry. A gardener pass fixes or deletes
items and removes them from the list.
