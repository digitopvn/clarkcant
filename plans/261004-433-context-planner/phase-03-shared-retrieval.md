# Phase 03: shared retrieval for read-only background runs

## Context

`runInBackground` starts a worker with no roots, no capabilities and no tools: it only knows the request text. Several
background runs started from one conversation each lack the context the foreground had, and each would pay for the
same retrieval.

## Requirements

- `ContextBundle { bundleId, principalId, conversationId, refs, createdAt }`: refs only (`message:<id>`,
  `memory:<id>`) with a content digest each, frozen, held in a bounded in-process cache with a TTL, keyed by principal,
  conversation and normalized query.
- Expansion re-reads every ref through the principal-scoped readers and drops a ref whose row is gone or whose digest
  changed (a deleted memory or an edited message is never sent stale).
- The expanded text goes to the worker as `data` (data, not instructions), bounded, after any data the caller passed.
- A bundle grants nothing: no roots, no capabilities; write authority stays where it is.
- Dispatched task workers keep their envelope unchanged (follow-up).

## Files

- `apps/runtime/src/context-bundle.ts` (new), `apps/runtime/src/model-turn.ts`,
  `apps/runtime/src/bootstrap/model-bootstrap.ts`, `apps/runtime/test/context-bundle.spec.ts` (new).

## Validation

`pnpm exec vitest run apps/runtime/test/context-bundle.spec.ts apps/runtime/test/background*.spec.ts`.

## Risk and rollback

A bundle from another principal must be unreachable: the key includes the principal and expansion re-checks it.
Rollback: `CLARKCANT_CONTEXT_PLANNER=off` disables bundles with the rest of the planner.
