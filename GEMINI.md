## Specs and process

- Specs live in `docs/specs/NNN-slug/spec.md`; the process, gates, and environments are in `docs/process/workflow.md`.
- Spectra is no longer used. `openspec/` and `.claude/skills/spectra-*` are historical background; do not add to them.

## Runtime

- This repo expects Node `>=24 <25`.
- If you use `nvm`, run `nvm use` in the repo root before `pnpm dev`, `pnpm check`, or `pnpm build`.
- The repo includes `.nvmrc` pinned to Node 24 for that workflow.
