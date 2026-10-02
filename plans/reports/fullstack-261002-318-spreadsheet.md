# #318 Reference app B: spreadsheet — implementation report

Branch `codex/318-spreadsheet` (worktree `D:/wt328`), based on `origin/main` at 605d8d38. Plan:
[plans/20261002-318-spreadsheet](../20261002-318-spreadsheet/plan.md).

## Commits

| Commit | Subject |
|---|---|
| 62876b17 | feat(artifacts): accept tab-separated values as a text type |
| 5fa4e4b2 | docs(plans): plan the spreadsheet reference app |
| 3acd8a19 | feat(examples): add a reference spreadsheet package |
| 97134422 | test(e2e): walk the reference spreadsheet through files, Clark and the keyboard |
| 166a3d2d | docs(widgets): describe the reference spreadsheet and its limits |
| (this one) | docs(plans): record the spreadsheet verification and PR body |

## Acceptance evidence

| Acceptance item | Evidence |
|---|---|
| Manifest v2 package, one isolated-UI facet, no service | `examples/reference-apps/spreadsheet/clarkcant.json`; `clark widget test` 22 passed, 0 failed, 12 need the dev host; `clark widget pack` gives `sha256:4cb9b90ed6f1eb4399915975a4cc79010d99cd6bbacf4889906a89fafbca3e1a` |
| CSV and TSV through #313 refs | TSV added to the primitive with a broker test ("takes tab-separated values as text like comma-separated ones…") and a desktop bridge check. E2E test 1 imports CSV, exports CSV and TSV through the host's Save As download, and reimports both |
| XLSX recorded as unsupported | Package README (EN and VI), `docs/widget-development{,.vi}.md` §24.1, status §4.1 |
| Import, edit, export, reimport gives the same values | E2E test 1 checks both exported files byte for byte (the BOM, values, quoted text) and confirms both reimports show the same A1:D4 values; unit test "reimports an export to the same values" |
| Bounds, truncation notice, virtualized rendering, no whole-sheet copy into state | E2E test 2: a 12,000-row file (more than 256 KiB) loads 5,000 rows and the notice reads "Chỉ hiện 5000 hàng và 5 cột đầu tiên". Fewer than 80 rows and fewer than 1,000 cells are rendered. The timings were load 348 ms, Ctrl+End 26 ms, Ctrl+Home 44 ms, 5×PageDown 83 ms, edit and recompute 111 ms. Unit tests cover the reader ceilings. State holds only refs, edits and formats, with a checkpoint above 10 KiB |
| Editable cells | E2E tests 1 and 3: Enter, F2, typing, Escape, Delete, and formula edits recompute |
| Closed formula set, no eval, circular references reported | `test/formula.spec.ts` (10 tests), including a source scan for `eval`/`Function`/`innerHTML`, cycles named, and the `#LIMIT!` budget |
| CSV injection neutralized on export | Unit parity with `toCsv`. E2E: `-dash` and `@mention` export as `'-dash` and `'@mention`, and a formula exports as its value |
| Semantic document | `test/sheet.spec.ts`: range, excerpt, active formula and size, with canonical bytes within `SEMANTIC_LIMITS.bytes`. E2E waits for the semantic POST that carries `B2:C3` |
| Percent formatting by Clark through a bound action, with the fixture model proving it saw the host-read range | E2E test 1: select B2:C3, press, and the result is `applied`. The cells show 1000%, 25% and 75%, cells outside the range are unchanged, and the bridge carries `format: percent B2:C3`. The fixture reply is derived only from the turn's data section |
| No host path in frame traffic | E2E test 1: bridge messages in both directions, plus every request the frame made (URL and body), checked against the place regex: no matches |
| Keyboard grid navigation, light and dark, 390 px with the grid scrolling inside its card | E2E test 3: arrows, Shift-extend, Home/End, Tab, Ctrl+Home, and `aria-activedescendant`/`aria-selected`. `data-scheme` follows light and dark, and the active-cell outline is visible. The grid's scrollWidth is greater than its clientWidth and scrollLeft is greater than 0 after moving right. Page horizontal overflow is `{"390-light":0,"390-dark":0}` |
| Docs EN and VI | `docs/widget-development{,.vi}.md` §24.1, `docs/widgets-and-extensions{,.vi}.md` §4.1, the V12 ledger in `docs/conformance-traceability.md`, and `--fix-manifest` |

Screenshots (not committed): `plans/reports/evidence/spreadsheet/` contains formatted-1280-light, large-1280-dark, 390-light and 390-dark.

## Verification

- Package unit tests: 28/28.
- `apps/web/e2e/spreadsheet.spec.ts` alone: 3/3. The first run failed 2 tests on a strict-mode locator (the cell editor also carries `data-cell`). Cell locators were scoped to `.cell`, and the spec then passed 3/3 twice.
- `pnpm verify` (final run): invariants 12/12, typecheck and lint clean, and vitest with 397 files passed and 1 skipped, 5063 tests passed and 34 skipped. Earlier runs on this loaded machine failed only timing-bound tests:
  - `task-dispatch-scoped`, `managed-worktree` and `driver`, which passed 32/32 when rerun alone;
  - `scoped-fs`, which passed 30/30 when rerun alone.
- `pnpm verify:full` with the assigned ports:
  - verify passed;
  - widget dev host: 42/42;
  - widget browser: 4/4;
  - reference-theme browser: failed once with `net::ERR_NO_BUFFER_SPACE` (Windows socket exhaustion), then passed 8/8 alone;
  - `pnpm run test:e2e`, run on its own afterwards: 360 passed, 3 skipped, 0 failed.
- No E2E processes are left listening on 9376, 4673 or 9378.

## Open questions

1. **Official docs.** `digitopvn/clarkcant-web` was not touched, because the brief keeps other repositories out of scope and the behavior is not on `main` yet. After merge, someone needs to land the EN and VI docs there or open the `ai-handle` tracking issue that AGENTS.md requires.
2. **Docs §24 merge with #317.** The "## 24. Reference apps" heading is shared with #317's section. Whichever PR merges second should keep one heading and number the subsections.
3. **Placing a package widget with a bound action.** Only the fixture node does this today. #382 is the tracking issue; consider widening it to state this explicitly if it does not already.

Status: DONE
Summary: The spreadsheet reference app, TSV support in the artifact primitive, the fixture-node placement and agent reply, three browser journeys and the bilingual docs are committed and pushed on `codex/318-spreadsheet`. Every acceptance item has test evidence.
Concerns/Blockers: The official clarkcant-web docs are deferred until merge. On this shared machine, verify and verify:full saw timing and socket-exhaustion failures in unrelated suites, and each of those passed when rerun alone.
