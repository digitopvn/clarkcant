## Summary

Addresses #318. Part of #200.

Reference app B: a spreadsheet package in `examples/reference-apps/spreadsheet`. It is a manifest v2 package with one isolated UI facet and no service. It works on files by reference (#313), keeps a large sheet within bounds, describes itself to Clark, and applies a format Clark chose through an `agent` binding (#314).

- **TSV in the artifact primitive.** `text/tab-separated-values` (`.tsv`, `.tab`, alias `text/tsv`) is now an accepted text type. It has the same sniffing, size and trust rules as CSV, and is used by the contracts, broker, blobs, delegated artifacts, desktop picker, labels and dev host. A binary file declared as TSV is still refused.
- **The package.**
  - CSV and TSV import is read in 256 KiB chunks and stops at 25,000 cells, 64 columns, 5,000 rows or 8 MiB. A notice says what was shown when the file was cut.
  - Rows and columns are virtualized.
  - The widget state holds the source ref, an edit overlay and the formats, never the sheet. A large overlay is checkpointed into the widget's own artifact.
  - Formulas are a closed set (arithmetic, references, ranges, `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`), parsed and walked with no `eval` or `Function`. Errors are values, and circular references are named.
  - Export writes computed values with a BOM and neutralizes text that starts with `=`, `+`, `-`, `@`, tab or CR exactly like `toCsv`.
  - The semantic document carries the A1 range, a bounded excerpt, the active formula and the size, within the host's limits.
  - XLSX is not supported: there is no vetted parser in the tree, and the type is not on the broker allowlist.
- **Formatting through Clark.**
  - The "format as percent" button presses an `agent` binding with the context refs `selection` and `widget`.
  - The host reads the range from the widget's semantic document, and the intent asks for exactly one line, `format: percent <range>`.
  - The widget treats the reply as untrusted and applies it only when it is that exact line for the range selected at the press. Otherwise it shows a visible refusal.
- **Fixture node.** The fixture node places the package from its directory entry and compiles the binding the way the host compiles a model's proposal. Its reply names the range found in the turn's data section, so an applied format shows that the host-read range reached the model.
- **Docs.** The reference-app section is in `docs/widget-development{,.vi}.md` §24.1, the status in `docs/widgets-and-extensions{,.vi}.md` §4.1, and the V12 ledger evidence in `docs/conformance-traceability.md`. The broker count there is corrected from 31 to 32.

Known gaps, tracked in #382:
- Nothing in the product places a package widget with a bound action yet; only the fixture node does here.
- A request typed in the composer reaches Clark through the semantic note but cannot change the frame.

Coordination with #317:
- The shared lines are the vitest/tsconfig includes, `examples/reference-apps/package.json`, the lockfile importer, `directory.json` and `fixture-model.ts`.
- These were added as agreed, so a merge only appends. The PR that merges second combines the `test` script.
- If #317 also adds a "Reference apps" section to `docs/widget-development{,.vi}.md`, keep one §24 heading and number the subsections.

## Validation

- Unit tests for the package: 28 passed (csv 8, formula 10, sheet 10).
- `clark widget test examples/reference-apps/spreadsheet`: 22 passed, 0 failed, 12 need the dev host.
- `clark widget pack`: `com.example.spreadsheet@1.0.0`, `sha256:4cb9b90ed6f1eb4399915975a4cc79010d99cd6bbacf4889906a89fafbca3e1a`.
- `apps/web/e2e/spreadsheet.spec.ts` alone: 3 passed. Measured timings for the large file: load 348 ms, Ctrl+End 26 ms, Ctrl+Home 44 ms, five Page Downs 83 ms, an edit that recomputes 5,000 formulas 111 ms. Horizontal overflow at 390 px was 0 in light and dark.
- `pnpm verify`: invariants 12/12, typecheck, lint, and vitest with 397 files passed and 1 skipped, 5063 tests passed and 34 skipped.
  - Earlier runs on this loaded machine failed only timing-bound tests. Each passed when rerun alone:
    - `task-dispatch-scoped`, `managed-worktree` and `driver` (32/32);
    - `scoped-fs` (30/30).
- `pnpm verify:full` with `CC_E2E_NODE_PORT=9376 CC_E2E_WEB_PORT=4673 CC_E2E_NPM_REGISTRY_PORT=9378`:
  - verify passed as above;
  - widget dev host: 42 passed;
  - widget browser: 4 passed.
  - The reference-theme browser suite failed once with `net::ERR_NO_BUFFER_SPACE` (Windows socket exhaustion), then passed 8/8 when rerun alone.
  - Browser E2E (`pnpm run test:e2e`) was run on its own after that: 360 passed, 3 skipped, 0 failed, including the 3 spreadsheet journeys.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
