---
title: "Tree and hierarchy widget"
status: completed
created: 2026-09-30
issues: [327]
related: [198, 225, 226, 280, 281, 282, 283, 326]
---

# Tree and hierarchy widget (#327)

Pull request: [#372](https://github.com/digitopvn/clarkcant/pull/372).

## Outcome
Ship a host-rendered `canvas.tree@1` primitive that safely displays bounded hierarchical data, supports accessible keyboard navigation and persistent selection/expansion state, and exposes truthful semantic and text representations.

## Constraints
Reuse the built-in widget catalog, composition-event contracts and bounded widget state. Render labels as text; reject malformed, cyclic, over-depth/over-count, duplicate-id, hidden-character and unknown-icon inputs with a useful placement reason. Preserve stale state safely. No service loading, editing or file-browser behavior.

## Acceptance criteria
See [phase-01-tree-and-semantic.md](phase-01-tree-and-semantic.md). Issue #327 acceptance is the source of truth.

## Dependencies
#282 and #283 are merged. Follow #326 and sequence this catalog primitive before #328/#329.

## Phases
- [ ] 01 — Tree contract, runtime placement, renderer, semantics, preview and tests.

## Validation
Focused unit/catalog/runtime/client tests, browser journey at desktop and 390 px with keyboard and theme/reduced-motion coverage, `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, plan validation, CI including Windows, paired official EN/VI docs before issue closure.