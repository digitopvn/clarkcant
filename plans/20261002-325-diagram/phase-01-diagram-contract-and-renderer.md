# Phase 01 — Diagram contract, layout and accessible renderer

## Context
- GitHub issue #325, including its scope and acceptance list.
- Precedent: the `canvas.tree@1` change (#327) for catalog, runtime, semantic and renderer wiring.
- Relevant contracts: `packages/contracts/src/{text-rules,widget-state,widget-semantic,composition-graph}.ts`.
- Catalog/render path: `packs/data-canvas/src/index.ts`, `packages/widget-catalog/src/{registry,fixtures}.ts`, `apps/runtime/src/{view-catalog,widget-semantic}.ts`, `packages/core/src/widget-service.ts`, `packages/conversation-client/src/renderers.tsx`.
- Product interaction and accessibility: `DESIGN.md`.

## Requirements
- Define `canvas.diagram@1` with at most 60 nodes and 120 edges, bounded ids and labels, four shapes, three edge directions, `layered`/`tree` layouts and `TB`/`LR` directions; refuse malformed graphs with a reason.
- Lay out deterministically in bounded time in the contracts package, shared by node and client.
- Read a documented Mermaid flowchart subset on the host into the model; store only the model; refuse every renderer-configuring construct by line.
- Keep the selected node in bounded widget state through `diagram.select`; ignore stale ids.
- Render SVG with text nodes only; each node a keyboard button named with shape, group and neighbours; keys follow edges; visible focus; highlight not by colour alone; overflow scrolls inside the card.
- Bounded semantic document and adjacency-list text alternative; Widget Library fixtures and preview.
- Update internal widget docs EN/VI and the conformance ledger once proven; prepare official web docs EN/VI.

## Files to inspect/modify
- `packages/contracts/src/diagram-{view,layout,mermaid}.ts` and their tests.
- Catalog, runtime placement/semantics, widget service, client renderer, navigation, i18n and styles.
- `apps/web/e2e/diagram-view.spec.ts`.
- `docs/widget-development{,.vi}.md`, `docs/widgets-and-extensions{,.vi}.md`, `docs/conformance-traceability.md`.

## Steps
1. Add the model, checks, state, text and semantic functions; test each refusal.
2. Add the layered and tree layouts; test determinism, no overlap and the time bound.
3. Add the Mermaid subset reader; test accepted syntax and each refused construct.
4. Wire catalog definition, runtime view, widget service operation, semantic branch and composition event.
5. Add the renderer, keyboard navigation, i18n, styles, fixtures and preview.
6. Add the browser journey; update docs and ledger; run full verification; open the PR and the official docs follow-up.

## Validation
- Focused contract, runtime, client and catalog tests.
- Browser E2E for conversation and library, keyboard, DOM safety, Mermaid input, refusals, 390 px in both themes and reduced motion.
- `pnpm verify`, `pnpm verify:full`, `pnpm invariants`; CI green including Windows.
- `ak plan validate` passes.

## Risks and rollback
A layout that is not deterministic would draw differently on node and client; a Mermaid construct read loosely could reach a renderer. Both are covered by focused tests. Revert the PR if a supported platform or assistive interaction regresses; no migration is involved.
