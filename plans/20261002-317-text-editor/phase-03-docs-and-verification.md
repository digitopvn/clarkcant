# Phase 03 — Docs, verification and PR body

## Context

- Internal docs are bilingual (EN canonical, VI paired); `docs/conformance-traceability.md` is English-only.
- Official docs live in `digitopvn/clarkcant-web` and follow the product merge.

## Requirements

- Reference-app walkthrough in `docs/widget-development{,.vi}.md`.
- Definition-of-done status for reference app A in `docs/widgets-and-extensions{,.vi}.md`.
- Ledger row in `docs/conformance-traceability.md` when one applies; then `node tools/check-invariants.mjs --fix-manifest`.
- Record the composer gap against #382.

## Files to modify/create

- `docs/widget-development.md`, `docs/widget-development.vi.md`
- `docs/widgets-and-extensions.md`, `docs/widgets-and-extensions.vi.md`
- `docs/conformance-traceability.md` (if applicable) and the invariants manifest
- `plans/reports/pr-body-317.md`, `plans/reports/fullstack-261002-317-text-editor.md`

## Steps

1. Write docs against the shipped behavior only.
2. Run focused tests, `pnpm verify`, `pnpm verify:full` with the session ports.
3. Push the branch, write the PR body with exact counts; do not open the PR.

## Validation

- `ak plan validate plans/20261002-317-text-editor`
- `corepack pnpm verify`, `corepack pnpm verify:full`

## Risks and rollback

- Docs must not describe target behavior as shipped. Revert docs with the code if the PR is dropped.

## Status

Completed on 2026-10-02.
