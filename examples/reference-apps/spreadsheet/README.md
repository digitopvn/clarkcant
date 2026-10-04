# Reference app: spreadsheet

English | [Tiếng Việt](README.vi.md)

A ClarkCant package with one isolated UI facet and no service. It shows how a widget works with files, keeps a large
document bounded, describes itself to Clark, and applies a change Clark chose.

- **Files.** Import a CSV or TSV file through `api.artifacts.pick`; the widget reads it in 256 KiB chunks and never sees
  a path. Export writes a new file through `create`, `write`, `finalize` and `export`. XLSX is not supported: no
  vetted parser is in the tree, and the type is not one the host's artifact broker accepts.
- **Bounds.** At most 25,000 cells, 64 columns and 5,000 rows are loaded, and a file is read no further than 8 MiB.
  The cell ceiling is on the rectangle the rows make (rows times the widest row), as for an edit, so a ragged file is
  cut where its rectangle stops fitting. Reading stops at the ceiling and a notice says how much was shown and that
  export writes only that. A read stopped at 8 MiB drops the line it stopped in and says the file was cut, and blank lines at the end of a file
  do not count. Rows and columns are rendered virtually, so a large sheet keeps a few hundred cells in the page.
- **State.** Widget state holds the source file's reference, the edits made since and the formats (the host allows
  16 KiB). The active cell and the selection are `ephemeralStateKeys`: view state the host never writes to the node.
  Straight after an import the sheet is written to the widget's own file, because the grant to read a picked file lasts
  24 hours; if that write fails, the status says so and the next edit tries again. When the edits outgrow 10 KiB, the
  widget writes the whole sheet to its own file the same way and starts again from that one. One such checkpoint runs at
  a time; edits made while it is written are kept and saved after it. Once a checkpoint is committed the widget asks
  the host to discard the file it replaces; a discard the host refuses leaves that file in place. The sheet itself is
  never copied into state.
- **Loading.** Until the sheet is read back from its source on mount, the grid takes no edits and the buttons wait. If
  the source cannot be read, the status says so, the grid takes no edits, and nothing is saved over the saved sheet.
- **Formulas.** Arithmetic (`+ - * / ^`, unary minus, parentheses), references (`B2`, `$B$2`), ranges and `SUM`,
  `AVERAGE`, `MIN`, `MAX`, `COUNT`. A parser builds a tree and the widget walks it; no text is ever run as code.
  Errors are values: `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#PARSE!`, `#NUM!`, `#CIRC!` (a circular reference, named
  in the notice) and `#LIMIT!`, which marks only a formula that reaches too far and the formulas that read it.
- **CSV injection.** Export writes computed values, never formulas. A text value starting with `=`, `+`, `-`, `@`, a tab
  or a carriage return is written with a leading `'`, the rule the host's own table export uses. So is text this sheet
  would read back as something else (`007`, `1e3`, or text starting with `'`). Import reads a leading `'` as "this is
  text", so an export reimports to the same values. Formats are not written to CSV.
- **What Clark reads.** The semantic document carries the selected A1 range, an excerpt of up to 12 rows by 8 columns,
  the active cell's formula and value, and the sheet's size, inside the host's semantic limits.
- **Formatting through Clark.** The host attaches an `agent` action to the instance and passes its id as the
  `formatBinding` prop. The press sends nothing; the host reads the selection from the widget's semantic document and
  asks Clark for exactly one line. The widget accepts `format: percent|number|plain <range>` and applies it only for
  the range selected at the press, which stays locked until the reply arrives; otherwise it says so visibly. At most
  32 formats are kept, and the status names one that had to go. "Undo format", or Ctrl+Z in the grid, takes back
  Clark's change. Before it runs the press, the host sends the widget's pending semantic document and waits until the
  node holds it, so a press made straight after changing the selection still reaches Clark with that range.
- **Formatting from the composer.** The widget offers Clark a `format` action (`{format: percent|number|plain,
  range?}`) through `actions.perform@1`. A request typed in the composer, such as "format this as a percentage", lets
  Clark call `perform_widget_action`; the sheet formats the given range, or the selection, says so in its status line
  and refuses with `SHEET_BUSY`, `FORMAT_UNKNOWN` or `RANGE_INVALID` otherwise. A format that is shown but cannot be
  saved is reported as a failure, which Clark treats as an uncertain outcome. "Undo format" takes it back. The
  `place_widget` tool binds this action, and the `formatBinding` button when asked, in a real installation; see
  [widget development §10.3](https://github.com/digitopvn/clarkcant/blob/main/docs/widget-development.md#103-actions-clark-performs-actionsperform1).

Keyboard: the grid is one tab stop, and Tab and Shift+Tab leave it. Arrows move, Shift+arrows extend the selection,
Home/End and Ctrl+Home/End jump, Page Up/Down page, Enter or F2 edits, typing starts an edit, Escape cancels an edit or
collapses a range, Delete clears the selection, Ctrl+Z undoes the last format. While editing, Tab commits and moves
right.

Pointer and touch: click, Shift+click or drag with a mouse. On touch, tap a cell; "Select range" makes the next taps
extend the selection. Buttons are at least 40 px high.

Run `clark widget test examples/reference-apps/spreadsheet` and `clark widget pack examples/reference-apps/spreadsheet`.
Unit tests are in `test/`, and the browser journey is `apps/web/e2e/spreadsheet.spec.ts`.

## npm package: CSV Explorer

This app is packaged for npm as **`@clarkcant/csv-explorer`** 1.0.0. Its licence is pending the maintainer's
decision: `package.json` and `clarkcant.json` declare Apache-2.0 while the `LICENSE` file holds MIT text, and the
package will not be published until the two agree. **It is not on npm yet.** Publishing needs an account that owns the `@clarkcant` npm scope, and no version has been
published, so no Marketplace lists it either. The source is
[examples/reference-apps/spreadsheet](https://github.com/digitopvn/clarkcant/tree/main/examples/reference-apps/spreadsheet).
Its package id is still `com.example.spreadsheet`, with publisher id `example`.

- **What it asks for:** nothing. No network origin, no filesystem path, no microphone or camera, no requested
  capability and no lifecycle script. Files reach it only through the host's picker and export prompt.
- **Platforms:** `darwin-arm64`, `linux-x64`, `win32-x64` and `web`, as `clarkcant.json` declares. Other targets
  (Intel macOS, Linux on arm64) are not declared.
- **What the archive ships:** `clarkcant.json`, `widgets/`, the four `fixtures/` prop sets, the READMEs and the
  licence. The tests stay in the repository.
- **Build the archive:** `node packages/widget-cli/src/cli.ts widget pack examples/reference-apps/spreadsheet` writes
  `dist/clarkcant-csv-explorer-1.0.0.tgz`, and `widget publish` prepares `dist/directory-entry.json`, which names that
  exact npm version and the archive's content digest. Neither command uploads anything, and `dist/` is not committed.
- **Install it today:** put the entry `widget publish --source local` prepares in a JSON array, point the node's
  `CC_DIRECTORY_INDEX` at that file, and install it from Clark's directory search.
- **Install it once published:** a node installs the exact npm version a directory entry names, and refuses the
  archive unless npm's integrity and the entry's content digest both match.
- **Known limits:** CSV and TSV only, no XLSX; the bounds above (25,000 cells, 64 columns, 5,000 rows, an 8 MiB read);
  export writes values, not formulas or formats. The package has no preview screenshots yet.
