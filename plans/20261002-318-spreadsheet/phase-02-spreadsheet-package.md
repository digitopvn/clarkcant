# Phase 02 — Spreadsheet package and unit tests

## Context

- Follow `apps/web/e2e/fixtures/artifact-widget/` for the isolated-app package layout and the frame runtime (`window.clarkcantWidget`).
- The frame cannot import workspace packages; the CSV neutralization rule mirrors `toCsv` in `packages/contracts/src/table-view.ts`, held equal by a test.

## Requirements

- Manifest v2, one `ui` facet with `isolated-ui` isolation, no service; fixtures default, empty, error, compact.
- Core modules as plain ES modules: `csv.js` (RFC 4180 parse and write, TSV, neutralization), `formula.js` (tokenizer, recursive-descent parser, evaluator, cycle detection), `sheet.js` (bounds, overlay, A1 helpers), `semantic.js` (bounded semantic document).
- Bounds: a cell-count ceiling and a column ceiling; reading stops at the ceiling and a notice names what was shown. Rows are virtualized.
- Grid: `role="grid"`, active descendant, arrows, Shift+arrows, Home/End, Ctrl+Home/End, PageUp/PageDown, Enter/F2 edit, typing starts an edit, Escape cancels, Delete clears.
- Agent formatting: an `agent` binding id arrives in props; the reply must be exactly `format: percent|number|plain <range>` naming the selection at press time, or it is refused visibly.

## Files to create

- `examples/reference-apps/spreadsheet/**`
- `vitest.config.ts` and `tsconfig.json`: one include line each for `examples/reference-apps/*/test`.

## Steps

1. Write the core modules and their unit tests (CSV round trip, neutralization parity, evaluator errors and cycles, bounds and notice, semantic document).
2. Write the widget shell, styles and themes, then the fixtures and README.
3. Run `clark widget test` and `clark widget pack` on the package.

## Validation

- `corepack pnpm exec vitest run examples/reference-apps/spreadsheet`
- `node packages/widget-cli/src/cli.ts test examples/reference-apps/spreadsheet` and `pack`

## Risks and rollback

- Formula evaluation cost grows with ranges; a dependency-scan budget yields `#LIMIT!` with a notice instead of freezing.
- Widget state overflow: checkpoint the overlay into a working artifact before the 16 KiB limit.
