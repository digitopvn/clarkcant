# Phase 2 — Renderers, host semantics and user journeys

## Context

- Issue: https://github.com/digitopvn/clarkcant/issues/329
- Depends on phase 1.
- Primary owners: `packages/conversation-client/src/renderers.tsx`, `apps/runtime/src/widget-semantic.ts`, and `packages/conversation-client/src/use-surface-renderer.tsx`.

## Requirements

- Persist selected/current gallery or carousel item and local video playing/paused/ended status, duration and coalesced position.
- A restore seeks to the stored position after metadata loads, without autoplay. A removed/reordered item safely normalizes selection against current props.
- Host semantics for image alt and known dimensions; gallery/carousel count, current index and alt; video state/duration/position; YouTube validated id/title only.
- The same rebuilt semantic document must reach `inspect_ui`, voice and next-turn notes through existing #195 paths.
- Preserve local-only Widget Library behavior and read-only snapshots.

## Files to modify

- `packages/conversation-client/src/renderers.tsx` and relevant CSS only if the existing media layout needs adjustment.
- `apps/runtime/src/widget-semantic.ts`.
- `apps/runtime/src/view-catalog.ts`, `packages/core/src/widget-service.ts`, `packages/conversation-client/src/use-surface-renderer.tsx`, and `packages/contracts/src/composition-graph.ts` for durable bound state and composition event routing.
- Focused unit tests in contracts/data-canvas, runtime, conversation-client and widget-catalog as appropriate.
- `apps/web/e2e/` media journey for gallery selection, video pause in `inspect_ui`, and carousel pin restoration.
- `docs/widget-development.md`, `docs/widget-development.vi.md`, `docs/widgets-and-extensions.md`, `docs/widgets-and-extensions.vi.md`, and `docs/conformance-traceability.md`.

## Steps

1. Wire renderer props/state callbacks and transition events through the phase-1 helper.
2. Add semantic branches for the five media definitions; prove changed state updates the semantic revision and reaches both inspection and the next turn.
3. Add compatibility, keyboard/focus, reduced-motion, light/dark and 390 px checks, including view state that survives pinning and a reload, with no autoplay.
4. Update the smallest relevant internal doc sections and T76 in the English-only ledger.
5. Run focused tests, then `pnpm verify`, `pnpm verify:full`, and `pnpm invariants`.

## Risk and rollback

Browser media events can arrive faster than durable writes. The coalescer must be the only writer for playback position; transition changes flush once and cleanup cancels timers. If restore fails, keep the widget usable at time zero without starting playback.

## Resolved blocker

The local-video journey was blocked because the page CSP had no `media-src blob:`, so Chromium rejected the authenticated `imageObjectUrl` object URL assigned to `<video>` ([blocker record](reports/329-local-video-csp-blocker.md)). [#374](https://github.com/digitopvn/clarkcant/issues/374) was decided as option 2: allow only app-created object URLs for media (`media-src 'self' blob:`) in `apps/web/index.html` and the desktop window policy, with no remote media origin and the host fetch path unchanged.

## Status

Done on `codex/329-media-semantic-state`. The local-video pause/`inspect_ui`/restore-without-autoplay journey now passes in Chromium alongside the gallery and carousel journeys.
