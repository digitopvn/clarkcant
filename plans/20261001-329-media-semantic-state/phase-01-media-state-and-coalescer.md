# Phase 1 — Media state and playback coalescer

## Context

- Issue: https://github.com/digitopvn/clarkcant/issues/329
- Parent: `plans/260930-0200-widget-platform-expansion/plan.md`
- Base: `origin/main` at `12181669` (after #375 and #376).
- Existing contracts: `packages/contracts/src/widgets.ts`, `packages/contracts/src/widget-state.ts`, `packages/contracts/src/widget-semantic.ts`.

## Requirements

- Read and normalize image, selected-media and local-video state from bounded props/state only.
- Preserve stateVersion 0 snapshots; declare and test a forward migration for each definition that gains durable state.
- Store gallery/carousel selection and local-video status/position. Keep gallery count/index and semantic text bounded by `SEMANTIC_LIMITS`.
- Add one pure shared playback-state coalescer that flushes meaningful transitions (pause, seek, end) and rate-limits continuous play updates to a few seconds at most.
- Keep YouTube semantics limited to its validated id/title; never subscribe to player messages.

## Likely files

- `packs/data-canvas/src/index.ts` and a focused media-view contract module/test.
- `packages/conversation-client/src/` shared playback coalescer and focused tests.
- `packages/contracts/src/widget-semantic.ts` and tests only if the semantic reader belongs at the shared contract boundary; otherwise keep the reader in data-canvas.
- `packages/core/src/widget-service.ts`, `apps/runtime/src/view-catalog.ts`, and `packages/conversation-client/src/use-surface-renderer.tsx` for host-compiled persistent view operations. Renderer-local `onStateChange` alone is session state and does not survive pin restore.
- `packages/contracts/src/composition-graph.ts` and its tests for the `media.select` event contract.
- Relevant widget-state and media tests.

## Steps

1. Confirm where image dimensions can be learned from current host data; include them only when a validated source actually provides them.
2. Add pure readers and bounded schemas for gallery/carousel and video state, including old-state defaults and migration definitions. Wire one host-compiled media view operation into the node state write path and validate payloads against the instance definition.
3. Add the shared playback coalescer; test initial write, transition flush, interval ceiling, and write-count bound without timers or a wall-clock flaky assertion.
4. Validate definition schemas, migration coverage and fixture agreement.

## Validation

- Focused contract/state and coalescer tests.
- `pnpm invariants` after definitions/migrations change.

## Risk and rollback

A malformed historic state must default safely without losing the snapshot. Revert the renderer integration while retaining the old-state reader if compatibility is at risk; do not reset stored state or change the DB schema.
