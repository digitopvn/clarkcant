/*
 * What the widget tells Clark about itself: the selected range, a few of its values, the active cell's formula and the
 * sheet's size. Bounded here to the host's own limits, so nothing the host would cut is sent, and never the whole sheet.
 */

import { displayValue, formatAt } from "./formats.js";
import { cellName, classifyInput, rangeName } from "./sheet.js";

export const SEMANTIC_BOUNDS = Object.freeze({
  summaryChars: 300,
  stringChars: 200,
  listEntries: 12,
  entryChars: 80,
  /** Columns of the selection quoted in one excerpt line. */
  excerptColumns: 8,
});

function clip(text, limit) {
  const points = Array.from(String(text));
  return points.length <= limit ? points.join("") : `${points.slice(0, limit - 1).join("")}…`;
}

/**
 * The semantic document's three parts.
 *
 * `input` holds: `title`, `locale`, `size` ({ rows, columns } in use), `selection` (a range), `active` ({ row, column }),
 * `raw(row, column)`, `value(row, column)`, `formats`, `truncated` (whether the file was not loaded whole) and `cycles`
 * (cell names on a circular reference).
 */
export function semanticDocument(input) {
  const vi = input.locale === "vi";
  const range = rangeName(input.selection);
  const activeName = cellName(input.active.row, input.active.column);
  const activeRaw = input.raw(input.active.row, input.active.column);
  const activeInput = classifyInput(activeRaw);

  const excerpt = [];
  const { top, left, bottom, right } = input.selection;
  const lastRow = Math.min(bottom, top + SEMANTIC_BOUNDS.listEntries - 1);
  const lastColumn = Math.min(right, left + SEMANTIC_BOUNDS.excerptColumns - 1);
  for (let row = top; row <= lastRow; row += 1) {
    const cells = [];
    for (let column = left; column <= lastColumn; column += 1) {
      cells.push(displayValue(input.value(row, column), formatAt(input.formats, row, column)) || "–");
    }
    excerpt.push(clip(`${cellName(row, left)}: ${cells.join(" | ")}`, SEMANTIC_BOUNDS.entryChars));
  }
  const excerptComplete = lastRow === bottom && lastColumn === right;

  const title = clip(input.title === "" ? (vi ? "Bảng tính" : "Spreadsheet") : input.title, 80);
  const summary = vi
    ? `Bảng tính “${title}”: ${String(input.size.rows)} hàng × ${String(input.size.columns)} cột đang dùng; vùng chọn ${range}, ô hiện tại ${activeName}.`
    : `Spreadsheet “${title}”: ${String(input.size.rows)} rows × ${String(input.size.columns)} columns in use; selection ${range}, active cell ${activeName}.`;

  /** @type {Record<string, string | number | boolean | string[]>} */
  const values = {
    range,
    rows: input.size.rows,
    columns: input.size.columns,
    activeCell: activeName,
    activeFormula: activeInput.kind === "formula" ? clip(activeRaw, SEMANTIC_BOUNDS.stringChars) : "",
    activeValue: clip(
      displayValue(input.value(input.active.row, input.active.column), formatAt(input.formats, input.active.row, input.active.column)),
      SEMANTIC_BOUNDS.stringChars,
    ),
    selectionFormat: formatAt(input.formats, top, left),
    excerpt,
    excerptComplete,
    truncated: input.truncated,
  };
  if (input.cycles.length > 0) {
    values.circular = input.cycles.slice(0, SEMANTIC_BOUNDS.listEntries).map((name) => clip(name, SEMANTIC_BOUNDS.entryChars));
  }
  return { summary: clip(summary, SEMANTIC_BOUNDS.summaryChars), selectedIds: [range], values };
}
