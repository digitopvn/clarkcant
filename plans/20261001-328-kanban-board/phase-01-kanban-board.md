# Phase 01 — Kanban contract, interactions and truthful bound moves

## Context
- GitHub issue #328 and parent epic #198.
- Ordered widget plan: `plans/260930-0200-widget-platform-expansion/phase-02-198-remaining-widgets.md` (#326 → #327 → #328 → #329).
- Reuse composition event contract from #226 and invoke executor/limits from #314.
- Product interaction, focus, touch and motion: `DESIGN.md`; trust, binding and state: `docs/widget-development.md` and `docs/widgets-and-extensions.md`.

## Requirements
- Define bounded `canvas.board@1` props and checks for columns/cards, unique IDs, valid column references, limits, text, label tones and hidden characters.
- Keep user reordering as bounded view state. Emit a host-checked `board.move` event for composition state.
- Provide independently usable keyboard pickup/move/drop/cancel, pointer drag and touch drag, with visible focus and screen-reader announcements for pickup, each position and drop. Preserve 40–44 px touch targets and reduced-motion behavior.
- With no external binding, clearly identify moves as local view changes. With an `invoke` binding, show the tentative move as pending; settle it only on the capability result, or restore the prior order with the refusal reason. Reuse host invocation, revision, dedup and policy semantics; the page must never write provider data directly.
- Expose bounded semantic counts, selected card and pending move; provide headed-list text fallback. Add a Widget Library fixture/preview and conversation placement.
- Update internal EN/VI widget docs and the English-only conformance ledger after verification. Prepare official EN/VI docs; merge those only after code PR lands.

## Files to inspect/modify
- Contracts and tests, composition graph and tests, catalog registry/fixtures and tests.
- Runtime placement/action and semantic document paths and tests.
- Conversation renderer/styles, widget action surface state, client tests, Widget Library and browser journeys.
- `docs/widget-development{,.vi}.md`, `docs/widgets-and-extensions{,.vi}.md`, `docs/conformance-traceability.md`.
- A separate official-docs worktree in `digitopvn/clarkcant-web` after behavior is stable.

## Steps
1. Re-read #328 comments, #226/#314 contracts, #327 implementation and current main; confirm no duplicate issue/PR and identify the existing binding response path.
2. Choose the smallest native drag model that works separately for mouse and touch and remains keyboard-operable; avoid adding a dependency unless existing browser behavior cannot meet acceptance.
3. Add schemas, meaning checks, fixtures, local state/event semantics and binding compilation/invocation; test refusal, pending, success, rollback and unbound outcomes.
4. Build the renderer using host-owned state and accessible announcements; test keyboard, pointer, touch, focus, 390 px, light/dark and reduced motion in the real conversation and Library preview.
5. Update internal docs and conformance evidence only from passing tests; run focused tests, full verification and invariants; validate this plan.
6. Review public contracts and trust boundaries, open code/docs PRs, merge code first and docs second, then close #328 with criterion-by-criterion evidence.

## Validation
- Contract/catalog/runtime/client/composition tests, including malicious/malformed props and action result handling.
- Browser journeys independently exercise keyboard, mouse and touch, unbound local moves, bound pending/confirmed and refusal rollback, Widget Library and conversation render, 390 px light/dark, reduced motion, focus and screen-reader live feedback.
- `pnpm verify`, `pnpm verify:full`, `pnpm invariants`; required CI including Windows.
- `ak plan validate plans/20261001-328-kanban-board --json`; docs link and language checks.

## Risks and rollback
External mutation and optimistic view order can diverge. Keep the last confirmed order available until the binding settles, and never claim external success from local movement. A pointer drag must not disable keyboard/touch paths. On regression, revert only this widget PR; do not remove previously merged #327.