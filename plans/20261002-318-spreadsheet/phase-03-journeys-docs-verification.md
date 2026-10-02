# Phase 03 — Host fixtures, browser journeys, docs and verification

## Context

- The fixture model (`apps/runtime/src/test-support/fixture-model.ts`) places package widgets for E2E and answers agent presses.
- `apps/web/e2e/fixtures/directory.json` lists local packages the frame-grant route can serve.

## Requirements

- A placement branch that creates the spreadsheet instance and its agent binding, passing the binding id in props.
- An agent-reply branch keyed on the binding intent, ahead of the generic press branch, that reads the selection from the host-read context and replies with the directive.
- Browser E2E: round trip; percent via Clark; large file with truncation notice; no host path in frame traffic; keyboard navigation; light and dark; 390 px.
- Docs: a reference-app section in `docs/widget-development{,.vi}.md`, status in `docs/widgets-and-extensions{,.vi}.md`, ledger row if one applies, and the composer gap tracked in #382.

## Files to modify/create

- `apps/runtime/src/test-support/fixture-model.ts`, `apps/web/e2e/fixtures/directory.json`
- `apps/web/e2e/spreadsheet.spec.ts`
- Docs listed above, `docs/manifest.json`

## Steps

1. Add the fixture branches and the directory entry.
2. Write the E2E journeys and run them alone, then with the suite.
3. Write the docs in both languages and refresh the manifest.
4. Run `pnpm verify` and `pnpm verify:full` with the assigned E2E ports.

## Validation

- `corepack pnpm exec playwright test apps/web/e2e/spreadsheet.spec.ts`
- `pnpm verify`; `pnpm verify:full` with `CC_E2E_NODE_PORT=9376 CC_E2E_WEB_PORT=4673 CC_E2E_NPM_REGISTRY_PORT=9378`

## Risks and rollback

- Shared fixture files are also edited by #317; keep each addition self-contained so a merge only appends.
