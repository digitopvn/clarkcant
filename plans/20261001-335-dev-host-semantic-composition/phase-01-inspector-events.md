# Inspector, event simulator, and conformance

## Context

- Issue: https://github.com/digitopvn/clarkcant/issues/335
- Semantic contract: `packages/contracts/src/widget-semantic.ts`
- Composition graph contract: `packages/contracts/src/composition-graph.ts`
- Existing dev host: `packages/widget-cli/src/dev-host.ts`, `dev-shell.ts`
- Existing package conformance: `packages/widget-cli/src/conformance.ts`

## Requirements

- Derive the inspector from shared runtime normalization, delta, and context-note helpers.
- Mark values or fields clipped/dropped by normalization and identify frame-proposed content as untrusted.
- Show previous-to-current delta, context note, and `inspect_ui` text; warn on publication churn.
- List declared composition inputs/outputs; validate simulated payloads using the same declaration/schema path, log validated fields, and refuse undeclared or malformed events.
- Add conformance checks over fixture-derived semantic input and declared event contracts.

## Files

- `packages/widget-cli/src/dev-host.ts`
- `packages/widget-cli/src/dev-shell.ts`
- `packages/widget-cli/src/conformance.ts`
- focused tests under `packages/widget-cli/test/`
- bilingual `docs/widget-development{,.vi}.md`
- English `docs/conformance-traceability.md`

## Validation

Run focused unit and browser tests first, then `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, and the plan validator. Confirm visible focus, keyboard flow, and both themes in the real dev host.

## Risks

A UI-only approximation of runtime semantic or graph validation could mislead authors. Keep validation on shared pure helpers and make every refusal visible.
