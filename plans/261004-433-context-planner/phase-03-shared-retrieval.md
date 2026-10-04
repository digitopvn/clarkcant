# Phase 03: shared retrieval for background runs and task workers

## Context

`runInBackground` starts a worker with no roots, no capabilities and no tools, and a dispatched task worker starts
from its goal alone: neither knows what the conversation already holds. Several runs started from one conversation
each lack the context the foreground had, and each would pay for the same retrieval.

## Requirements

- `ContextBundle { bundleId, principalId, conversationId, refs, createdAt }`: refs only (`message:<id>`,
  `memory:<id>`) with a sha256 digest each, frozen, held in a bounded in-process cache (10 minutes, 64 held), keyed by
  principal, conversation, message count and normalized query; one cache per database (`contextBundlesFor`).
- On-demand reading, not up-front expansion: `reader(bundle, principalId)` answers `{}` with the item list (a
  160-character preview each, 3,000 characters at most) and `{ item: "cN" }` with one item (2,000 characters at most),
  24 reads per run. Every read re-reads the ref through the principal-scoped readers and refuses one whose row is gone
  or whose digest changed, even mid-run; another principal reads nothing.
- Background runs: the list goes as `data` after the caller's data, plus a read-only `read_context` tool.
- Task workers: the brief carries only `contextItems` (a count, 0–64); the worker's `read_context` tool asks the host
  over IPC (`clarkcant.context.request`/`reply`), answered by the same reader. The tool is offered and active but is
  never wrapped as evidence and never in the permitted capability set.
- Everything returned sits under a data-not-instructions header. A bundle grants nothing. A failed retrieval leaves
  the run without context.
- `context-bundle` stderr line per bundle given out: counts only (items, built, reused, held, dropped).

## Files

- `apps/runtime/src/context-bundle.ts`, `apps/runtime/src/bootstrap/context-wiring.ts`,
  `apps/runtime/src/task-dispatch.ts`, `apps/runtime/src/worker-process.ts`,
  `apps/runtime/src/bootstrap/runtime-bootstrap.ts`, `apps/worker/src/{index,main,tools}.ts`; tests
  `apps/runtime/test/context-bundle.spec.ts`, `apps/runtime/test/task-dispatch-context.spec.ts`,
  `apps/worker/test/worker.spec.ts`.

## Validation

`pnpm exec vitest run apps/runtime/test/context-bundle.spec.ts apps/runtime/test/task-dispatch-context.spec.ts
apps/worker/test/worker.spec.ts`.

## Risk and rollback

A bundle from another principal must be unreachable: the key includes the principal and every read re-checks it.
Context text never enters the brief file. Rollback: `CLARKCANT_CONTEXT_PLANNER=off` disables bundles for background
runs and task workers with the rest of the planner.