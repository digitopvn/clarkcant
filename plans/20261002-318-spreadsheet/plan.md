---
title: "#318 Reference app B: spreadsheet"
status: completed
created: 2026-10-02
issues: [318]
related: [200, 313, 314, 317, 382]
---

# #318 Reference app B: spreadsheet

## Outcome

`examples/reference-apps/spreadsheet/` is a manifest v2 package with one isolated-UI facet and no service. It imports and exports CSV and TSV through #313 ArtifactRefs, keeps the sheet bounded, edits cells, evaluates a closed formula set without `eval`, neutralizes CSV injection on export, publishes a bounded semantic document, and applies percent formatting that Clark chose through a host-attached agent binding.

## Constraints and non-goals

- No new dependency. XLSX is not supported: no vetted parser is in the tree, and the type is not on the #313 allowlist.
- TSV was not on the #313 allowlist; it is added to the primitive (contracts, broker, blobs, desktop picker) in its own commit, under the CSV rules.
- No new bridge API, no path, no network, no raw secret in the frame. Formulas are parsed and evaluated by the package's own interpreter; `eval` and `Function` are never used.
- Widget state stays under 16 KiB: the source ArtifactRef plus a bounded edit overlay. A full overlay is checkpointed into a working artifact.
- A request typed in the composer only informs Clark through the semantic note; it cannot change the frame. That gap is tracked in #382. The widget offers an agent binding whose closed-vocabulary reply the widget applies.
- Do not touch `packages/widget-cli/src/cli.ts` templates (owned by #317).

## Dependencies

- #313 (artifacts) and #314 (action bindings, agent replies) are merged on `main`.
- #317 runs in parallel and shares the vitest and tsconfig include lines, `apps/web/e2e/fixtures/directory.json` and `fixture-model.ts`; each adds only its own entries.

## Phases

1. [TSV in the artifact primitive](phase-01-tsv-artifact-type.md)
2. [Spreadsheet package and unit tests](phase-02-spreadsheet-package.md)
3. [Host fixtures, browser journeys, docs and verification](phase-03-journeys-docs-verification.md)

## Acceptance

- Import, edit, export, reimport gives the same values; CSV and TSV both work; XLSX is recorded as unsupported.
- A large file stays responsive, renders virtually and shows a truncation notice; nothing beyond the bound enters widget state.
- Formulas: arithmetic, SUM, AVERAGE, MIN, MAX, COUNT; circular references and errors are reported; no `eval`/`Function`.
- Exported text cells that start with `=`, `+`, `-`, `@`, tab or CR are neutralized the same way as the host's table export.
- The semantic document carries the selected A1 range, a bounded values excerpt, the active cell's formula and the dimensions.
- Selecting a range and asking Clark to format it as percent applies the format, with the fixture model proving it saw the host-read range.
- No host path in frame traffic; keyboard grid navigation; light and dark themes; 390 px with the grid scrolling inside its card.
- `clark widget test` and `clark widget pack` pass; focused tests, `pnpm verify` and `pnpm verify:full` pass; docs are bilingual.

## Status

- Phase 1: done (`feat(artifacts): accept tab-separated values as a text type`).
- Phase 2: done (`feat(examples): add a reference spreadsheet package`).
- Phase 3: done (`test(e2e): walk the reference spreadsheet through files, Clark and the keyboard`, `docs(widgets): describe the reference spreadsheet and its limits`).
- Verification and evidence: `plans/reports/fullstack-261002-318-spreadsheet.md`.
- Official docs (`digitopvn/clarkcant-web`) follow once the PR merges, so they do not describe unshipped behavior.
