---
title: "Kanban board widget"
status: in-progress
created: 2026-10-01
issues: [328]
related: [198, 226, 314, 327]
---

# Kanban board widget (#328)

## Outcome
Ship a bounded `canvas.board@1` built-in. People can reorder and move cards with keyboard, pointer, or touch; local moves remain view state, while changes to external data go through a bound `invoke` capability and show only truthful pending/confirmed/refused outcomes.

## Constraints
Reuse the catalog/composition/action pipeline. Keep props and state bounded; render supplied text only; validate IDs, column references, limits, tones and hidden characters. Do not add card editing, swimlanes, provider sync, unbound external writes or fake success. Follow `DESIGN.md` and the widget trust-lane/accessibility contracts.

## Acceptance criteria
See [phase-01-kanban-board.md](phase-01-kanban-board.md) and issue #328. Required: independent keyboard/pointer/touch operation; screen-reader pickup/movement/drop feedback; local view-state behavior when no binding exists; pending then confirmed or reasoned rollback when bound; bounded semantics/text fallback; preview and conversation E2E; EN/VI internal and official docs; full verification and Windows CI.

## Dependencies
#327 is merged. #314's invoke executor and limits/cancel path are available; no provider-specific integration is in scope. Keep this catalog sequence ahead of #329 and later P2 widgets because they share renderer/registry anchors.

## Phases
- [ ] 01 — Contract, runtime binding, accessible multi-input renderer, semantics, preview, docs and tests.

## Validation
Focused contract/runtime/client/catalog/composition tests; E2E keyboard/pointer/touch, bound/unbound outcomes, themes/reduced-motion/responsive at 390 px; `pnpm verify`, `pnpm verify:full`, `pnpm invariants`; official docs PR after code merge; `ak plan validate`.