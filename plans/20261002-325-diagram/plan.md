---
title: "Diagram and graph widget"
status: completed
created: 2026-10-02
issues: [325]
related: [198, 326, 327, 282, 283]
---

# Diagram and graph widget (#325)

Pull request: [#396](https://github.com/digitopvn/clarkcant/pull/396).

## Outcome
Ship a host-rendered `canvas.diagram@1` primitive that draws a bounded node-and-edge graph as SVG text nodes with no script run, lays it out deterministically, reads a documented Mermaid flowchart subset on the host into the same model, and supports keyboard navigation along edges, persisted selection, and truthful semantic and text representations.

## Constraints
No new dependency: layout and the Mermaid subset are written in the contracts package. Mermaid's renderer is never loaded and its source is never stored. Labels are text; no HTML, `foreignObject`, link, image or handler reaches the page. Malformed, over-count, repeated-id, missing-node, self-loop, repeated-edge and hidden-character input is refused at placement with the host's reason; every Mermaid construct that configures its renderer is refused by line.

## Non-goals
Editing the graph, loading data from a service, Mermaid diagram types other than flowchart, a composed-layout slot for the diagram (the tree precedent adds none either).

## Acceptance criteria
See [phase-01-diagram-contract-and-renderer.md](phase-01-diagram-contract-and-renderer.md). Issue #325 acceptance is the source of truth.

## Dependencies
#282 and #283 are merged; follows the #327 tree primitive pattern.

## Phases
- [ ] 01 — Diagram contract, layout, Mermaid subset, runtime placement, renderer, semantics, preview and tests.

## Validation
Focused unit/catalog/runtime/client tests, browser journey at desktop and 390 px with keyboard, theme and reduced-motion coverage, `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, plan validation, paired official EN/VI docs before issue closure.
