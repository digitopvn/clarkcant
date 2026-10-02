---
title: "#335: dev-host semantic inspector and composition event simulator"
status: completed
created: 2026-10-01
issues: [335]
related: [195, 226, 334]
---

# Dev-host semantic inspector and composition event simulator

Pull request: [#376](https://github.com/digitopvn/clarkcant/pull/376).

## Outcome

`clark widget dev` shows the same normalized semantic document, delta, and turn context the runtime uses, and lets authors exercise declared composition events without granting real capability authority.

## Constraints

- Reuse the shared semantic and composition contracts; do not create a second normalization or event-validation implementation.
- Treat frame proposals as untrusted data and render them as text; simulated events never approve or invoke capabilities.
- Keep the simulator keyboard accessible, visible-focus, and usable in light and dark themes.
- Follow #334 in sequence because the work shares the dev-host shell and bridge.

## Phases

1. [Inspector, event simulator, and conformance](phase-01-inspector-events.md) — show normalized semantic state and deltas, validate/send declared events, and extend `clark widget test` with meaningful fixture checks.
2. [Browser proof, docs, and delivery](phase-02-browser-docs.md) — verify the actual CLI host in browser, update bilingual docs and conformance ledger, run required checks, then update official docs after feature merge.

## Acceptance

Meet every criterion in [issue #335](https://github.com/digitopvn/clarkcant/issues/335), including event refusal, truncation markers, keyboard/focus/theme coverage, `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, and Windows CI. Update official bilingual docs after merge or create the required `ai-handle` fallback issue.

## Dependencies

Build on #334's merged dev-host service simulator and shared contracts #195/#226.
