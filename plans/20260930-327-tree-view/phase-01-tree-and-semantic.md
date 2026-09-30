# Phase 01 — Tree contract and accessible hierarchy

## Context
- GitHub issue #327, including its scope and acceptance list.
- Widget baseline: `plans/260930-0200-widget-platform-expansion/plan.md`.
- Relevant contracts: `packages/contracts/src/text-rules.ts`, `widget-state.ts`, `widget-semantic.ts`, `composition-graph.ts`.
- Catalog/render path: `packages/widget-catalog/src/{registry,fixtures}.ts`, `apps/runtime/src/{view-catalog,compose-layout,widget-semantic}.ts`, `packages/conversation-client/src/renderers.tsx`.
- Product interaction and accessibility: `DESIGN.md`.

## Requirements
- Define `canvas.tree@1` with bounded depth, node count and labels; validate duplicate IDs, cycles, icon enum and hidden characters.
- Keep expanded/selected IDs in bounded widget state; ignore stale IDs after props change/restore.
- Implement WAI-ARIA tree semantics and Arrow/Home/End/type-ahead interactions with visible focus.
- Emit `tree.select` and `tree.toggle` composition events; expose bounded semantic hierarchy and an indented text fallback.
- Add Widget Library preview and conversation rendering coverage. Preserve light/dark, reduced-motion and narrow-layout behavior.
- Update internal widget docs EN/VI and conformance ledger only when implementation is proven. Prepare official web docs EN/VI.

## Files to inspect/modify
- Contracts, catalog fixtures/registry, runtime placement/semantics/composition graph, conversation renderer and Widget Library.
- Focused contract/runtime/client/catalog tests and browser journeys.
- `docs/widget-development{,.vi}.md`, `docs/widgets-and-extensions{,.vi}.md`, `docs/conformance-traceability.md`.
- Official docs in a separate `digitopvn/clarkcant-web` branch after code behavior is stable.

## Steps
1. Reconcile the issue with the merged #326 source and current catalog architecture; identify exact bounds and compatible keyboard interaction pattern.
2. Add schema/meaning checks and runtime placement refusal reasons; test each rejection and state restoration behavior.
3. Add accessible renderer, composition events, semantic document and text fallback; keep actions local to widget state.
4. Add catalog preview and focused browser journeys for conversation and library at 1280/390, light/dark and reduced motion; exercise keyboard and focus.
5. Update docs/ledger based on verified behavior; run focused tests then full verification/invariants.
6. Review public contract, UX/accessibility/security and docs; create code PR and paired official docs PR; merge code first, docs second; close #327 only with per-criterion evidence.

## Validation
- Focused tests for contract validation, runtime, client renderer, catalog and composition event bindings.
- Browser E2E for preview and conversation, responsive and keyboard coverage.
- `pnpm verify`, `pnpm verify:full`, `pnpm invariants`; CI green including Windows.
- `ak plan validate` passes; official docs preview/link checks and PR merge verified.

## Risks and rollback
A tree renderer can hide state or trap keyboard focus if selection and expansion semantics diverge; test stored stale IDs and every keyboard branch. Revert the PR if a supported platform or assistive interaction regresses; no migration is expected.