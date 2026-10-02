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

Review fixes (`plans/reports/review-261002-384-spreadsheet.md`):
- **Clearing a selection** is one batched edit, so clearing all 25,000 cells is linear.
- **Checkpoints** are serialized: one in flight, at most one queued. The checkpoint logic is in a new `store.js`.
  - Only the edits a finished save holds are cleared, so edits made during a write survive a reload.
  - The checkpoint it replaces is discarded. A refused one keeps the edits and leaves no file.
  - A sheet replaced mid-write drops its checkpoint.
- **Keyboard.** The grid is one tab stop, and Tab and Shift+Tab leave it, so Import, Export and "Ask Clark" are reachable. Arrows and Enter move, Escape collapses a range, focus stays visible, and Tab moves right only while editing.
- **Bounds on import.** The rows × columns bound applies on import (the rectangle the rows make), so a loaded sheet always takes edits. A checkpoint cut short on restore says so. A read stopped by the 8 MiB limit drops its partial last line, and trailing blank lines no longer cause a false notice.
- **The Clark round trip.** The widget still checks that the reply is for the range Clark read. The selection is locked while the request is in flight, and the 400 ms sleep is gone. The E2E keeps its wait for the semantic POST, marked `TODO(#383)`: without the host flush from #383, the host read the previous range and the widget correctly refused the reply.
- **Touch and Undo.** On touch, a tap selects and "Select range" extends the selection, and a mouse drags. "Undo format", or Ctrl+Z, takes back an applied format. The formats are a closed set (`percent|number|plain`), with a notice when the 32-format cap drops one.
- **View state.** The cursor and selection are `ephemeralStateKeys`, and cursor saves are debounced. The semantic selection context Clark reads is unchanged.
- **Smaller fixes.**
  - Text that would not reread as itself (`007`, `1e3`, a leading `'`) is exported behind a `'`.
  - `#LIMIT!` is scoped to the formulas past the budget and the formulas that read them. A running total over 3,000 rows fits.
  - The parse cache is pruned to the formulas on the sheet.
  - The export name is localized.
  - Buttons are at least 40 px high.
  - `.tab` maps to TSV in delegated artifacts. That mapping lives in `apps/runtime/src/delegated-artifacts.ts`, not `packages/*`.
  - The docs list the accepted formats.

Round-2 review changes (`plans/reports/review-261002-384-spreadsheet-round2.md`):
- **N1, nothing saved before the sheet has loaded.** The store saves and checkpoints nothing until `load()` has rebuilt the sheet, or an import has replaced it. Until then the grid takes no edits (`aria-readonly`), Import, Export and "Ask Clark" are disabled, and the status says "Đang mở bảng tính…" / "Opening the sheet…". A source that cannot be read leaves the store closed: the status says what failed, that the saved sheet is kept, and what to do next, and the grid stays read-only, so an empty sheet can never replace the saved one. An import starts over from the new file.
- **N2.** When an import supersedes a running checkpoint, the loop goes on to the save queued for the new sheet instead of stopping.
- **N3.** The first option: straight after an import, the sheet is checkpointed into the widget's own finalized file, so it no longer depends on the picked file's 24 h grant. The broker's expiry policy is unchanged. If that write fails, the status says so and the next edit retries. The docs state the 24 h grant in EN and VI.
- **N4.** Once a checkpoint's commit lands, the checkpoint it replaced is discarded, even when an import landed during the commit.
- **N5.** A refused write restores `saved` from the host plus the writes still queued behind it, rather than dropping their record.
- **N6.** A read that stops at the 8 MiB limit is flagged as cut, also when the limit falls on `\n` or between `\r` and `\n`.
- **N7.** A failed checkpoint now says that the sheet could not be written to a file, that the changes are in the frame but not saved, and that the next edit tries again. It no longer says "The sheet is unchanged".
- **N8.** `load()` reports `superseded` when an import replaced the sheet while it loaded, and the widget does not show that result. Import is also disabled while the sheet loads.
- **Docs.** EN and VI §24.1 and both READMEs now say when a replaced checkpoint is discarded and what happens when a discard is refused. They also describe the import checkpoint with the 24 h grant, the loading and unreadable states, and the cut flag at a line end. The V12 ledger row now reads 56 unit tests and 4 browser tests. `docs/manifest.json` was regenerated.

Known gaps, tracked in #382:
- Nothing in the product places a package widget with a bound action yet; only the fixture node does here.
- A request typed in the composer reaches Clark through the semantic note but cannot change the frame.

Coordination with #317:
- The shared lines are the vitest/tsconfig includes, `examples/reference-apps/package.json`, the lockfile importer, `directory.json` and `fixture-model.ts`.
- These were added as agreed, so a merge only appends. The PR that merges second combines the `test` script.
- If #317 also adds a "Reference apps" section to `docs/widget-development{,.vi}.md`, keep one §24 heading and number the subsections.

## Validation

After the round-2 changes (commit 386d9ed5):
- `pnpm typecheck`: passed.
- `pnpm exec vitest run examples/reference-apps/spreadsheet apps/runtime/test/delegated-artifacts.spec.ts apps/runtime/test/artifact-broker.spec.ts`: 6 files and **107 tests passed**.
  - The spreadsheet package has 56 tests: store 20, formula 13, csv 12 and sheet 11.
  - `delegated-artifacts.spec.ts` has 19 and `artifact-broker.spec.ts` has 32.
- **Each round-2 store test fails with its fix reverted.** Each fix was reverted alone and `store.spec.ts` was run again:
  - N1: 2 tests fail (nothing saved before load, and nothing saved after an unreadable source).
  - N2: 1 fails.
  - N3: 5 fail.
  - N4: 1 fails.
  - N5: 1 fails.
  - N6: 1 fails.
  - N8: 1 fails.
  - With every fix in place, all 20 pass.
- **`apps/web/e2e/spreadsheet.spec.ts` alone** (`CC_E2E_NODE_PORT=9476 CC_E2E_WEB_PORT=4773 CC_E2E_NPM_REGISTRY_PORT=9478`, `pnpm test:e2e`): 4 passed, in 22.4 s and 24.8 s on two runs. The new test does three things:
  - It refuses the artifact reads on a reload. The widget says why, takes no edits, and the next mount shows the saved sheet whole.
  - It holds the reads on another reload. The widget shows the loading state, the grid is read-only and Import is disabled until the sheet is back.
  - It refuses the import's checkpoint file. The message is the new one, and the next edit saves the checkpoint.
- **The new E2E test fails with each widget-side fix reverted:**
  - `main.js` at the previous commit fails on the restore message.
  - Without the edit guards, the editor opens on an unreadable sheet.
  - With the old failure text, it shows "Bảng tính giữ nguyên".
- `clark widget test examples/reference-apps/spreadsheet`: 22 passed, 0 failed, 12 need the dev host.
- **`pnpm verify`** passed: 410 test files passed and 1 skipped, and 5,240 tests passed and 34 skipped.
- **Not run on this tree:** the `verify:full` stages after `verify`, and `clark widget pack`.

After the round-1 review fixes:
- **Unit tests for the package: 47 passed** (store 11, formula 13, csv 12, sheet 11). `store.spec.ts` runs the checkpoint and restore path against a fake host that drops ephemeral keys and refuses past 16 KiB.
  - The new csv, formula and store tests were checked to fail against the code before the fix: the store tests under a mutation that removes serialization.
  - `apps/runtime/test/delegated-artifacts.spec.ts`: 19 passed, including `.tab`.
- `clark widget test examples/reference-apps/spreadsheet`: 22 passed, 0 failed, 12 need the dev host.
- **`apps/web/e2e/spreadsheet.spec.ts` alone** (`CC_E2E_NODE_PORT=9476 CC_E2E_WEB_PORT=4773 CC_E2E_NPM_REGISTRY_PORT=9478`): 3 passed, and 9/9 with `--repeat-each 3`. New coverage:
  - the selection locked while Clark answers, then Undo;
  - clearing 25,000 cells at once;
  - the Tab order out of and back into the grid, with a visible focus;
  - touch with "Select range", a mouse drag, and 40 px buttons.
- **`pnpm verify`** (invariants, typecheck, lint, vitest) passed on this tree. `docs/manifest.json` was regenerated for the four edited docs.
- **Not yet re-run on this tree:** the `verify:full` stages after `verify` (widget dev host, widget browser, reference-theme browser and the full browser E2E), and `clark widget pack`. The pack digest in the earlier body no longer applies.
- **Before the review fixes:** the full browser E2E passed 360 with 3 skipped.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
