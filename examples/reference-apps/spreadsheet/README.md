# Reference app: spreadsheet

English | [Tiếng Việt](README.vi.md)

A ClarkCant package with one isolated UI facet and no service. It shows how a widget works with files, keeps a large
document bounded, describes itself to Clark, and applies a change Clark chose.

- **Files.** Import a CSV or TSV file through `api.artifacts.pick`; the widget reads it in 256 KiB chunks and never sees
  a path. Export writes a new file through `create`, `write`, `finalize` and `export`. XLSX is not supported: no
  vetted parser is in the tree, and the type is not one the host's artifact broker accepts.
- **Bounds.** At most 25,000 cells, 64 columns and 5,000 rows are loaded, and a file is read no further than 8 MiB.
  Reading stops at the ceiling and a notice says how much was shown and that export writes only that. Rows and columns
  are rendered virtually, so a large sheet keeps a few hundred cells in the page.
- **State.** Widget state holds the source file's reference, the edits made since, the formats and the active cell
  (the host allows 16 KiB). When the edits outgrow that, the widget writes the whole sheet to its own file and starts
  again from that one. The sheet itself is never copied into state.
- **Formulas.** Arithmetic (`+ - * / ^`, unary minus, parentheses), references (`B2`, `$B$2`), ranges and `SUM`,
  `AVERAGE`, `MIN`, `MAX`, `COUNT`. A parser builds a tree and the widget walks it; no text is ever run as code.
  Errors are values: `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#PARSE!`, `#NUM!`, `#CIRC!` (a circular reference, named
  in the notice) and `#LIMIT!`.
- **CSV injection.** Export writes computed values, never formulas. A text value starting with `=`, `+`, `-`, `@`, a tab
  or a carriage return is written with a leading `'`, the rule the host's own table export uses; import reads a leading
  `'` as "this is text", so an export reimports to the same values. Formats are not written to CSV.
- **What Clark reads.** The semantic document carries the selected A1 range, an excerpt of up to 12 rows by 8 columns,
  the active cell's formula and value, and the sheet's size, inside the host's semantic limits.
- **Formatting through Clark.** The host attaches an `agent` action to the instance and passes its id as the
  `formatBinding` prop. The press sends nothing; the host reads the selection from the widget's semantic document and
  asks Clark for exactly one line, `format: percent|number|plain <range>`. The widget applies the reply only when it is
  exactly that line for the range selected at the press, and says so visibly when it is not. A request typed in the
  composer reaches Clark through the semantic document but cannot change the frame; that gap is tracked in
  [#382](https://github.com/digitopvn/clarkcant/issues/382).

Keyboard: arrows move, Shift+arrows extend the selection, Home/End and Ctrl+Home/End jump, Page Up/Down page, Enter or
F2 edits, typing starts an edit, Escape cancels, Tab moves right, Delete clears the selection.

Run `clark widget test examples/reference-apps/spreadsheet` and `clark widget pack examples/reference-apps/spreadsheet`.
Unit tests are in `test/`, and the browser journey is `apps/web/e2e/spreadsheet.spec.ts`.
