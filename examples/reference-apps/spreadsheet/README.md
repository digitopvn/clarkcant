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
  node holds it, so a press made straight after changing the selection still reaches Clark with that range. A request
  typed in the
  composer reaches Clark through the semantic document but cannot change the frame; that gap is tracked in
  [#382](https://github.com/digitopvn/clarkcant/issues/382).

Keyboard: the grid is one tab stop, and Tab and Shift+Tab leave it. Arrows move, Shift+arrows extend the selection,
Home/End and Ctrl+Home/End jump, Page Up/Down page, Enter or F2 edits, typing starts an edit, Escape cancels an edit or
collapses a range, Delete clears the selection, Ctrl+Z undoes the last format. While editing, Tab commits and moves
right.

Pointer and touch: click, Shift+click or drag with a mouse. On touch, tap a cell; "Select range" makes the next taps
extend the selection. Buttons are at least 40 px high.

Run `clark widget test examples/reference-apps/spreadsheet` and `clark widget pack examples/reference-apps/spreadsheet`.
Unit tests are in `test/`, and the browser journey is `apps/web/e2e/spreadsheet.spec.ts`.
