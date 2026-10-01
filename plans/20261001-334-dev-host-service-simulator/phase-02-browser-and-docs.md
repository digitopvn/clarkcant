# Phase 2 — Browser evidence and docs

## Context

- Issue: https://github.com/digitopvn/clarkcant/issues/334
- Depends on phase 1.
- Domain docs: `docs/widget-development.md` and `docs/widget-development.vi.md` §§16–17; `docs/conformance-traceability.md`.

## Requirements

- Browser-test `clark widget dev` with the checked-in notes-service fixture: loading, ready response, blocked, one capability unhealthy while another remains ready, offline refusal, restart recovery, and malformed response refusal.
- Prove service simulator makes no provider/container call and preserves keyboard focus, visible focus, and light/dark panel behavior.
- Extend `clark widget test` frame facts so missing/blank blocked and offline render states fail instead of passing.
- Document simulator fixture shape and its non-production boundary in English and Vietnamese; mark conformance status truthfully.

## Validation

- Run relevant browser E2E, `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, and `ak plan validate plans/20261001-334-dev-host-service-simulator`.
- `git diff --check`; after PR creation verify required CI including Windows and update/merge official bilingual docs.

## Risk and rollback

- Keep browser-server ports deterministic for this worktree and verify the test runner exits its children.
- If a browser condition cannot be established, leave the conformance item unverified and report the exact missing evidence.
