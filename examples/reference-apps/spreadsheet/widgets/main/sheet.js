/*
 * The sheet: its bounds, its cell addresses, and the raw input each cell holds.
 *
 * A cell holds what the person typed or the file said, as text. What it shows is derived from that: a number, text, or
 * the result of a formula. Only raw input is kept, so an edit and an import are the same kind of change.
 */

/** At most this many cells are loaded from a file or made by editing, whatever the file holds. */
export const MAX_CELLS = 25_000;
export const MAX_COLUMNS = 64;
export const MAX_ROWS = 5_000;
/** A cell longer than this is cut, and the notice says so. */
export const MAX_CELL_CHARS = 2_000;

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** "A" for 0, "Z" for 25, "AA" for 26. */
export function columnName(index) {
  let name = "";
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

/** The zero-based column for letters, or -1 for anything that is not one to three letters. */
export function columnIndex(letters) {
  if (!/^[A-Za-z]{1,3}$/u.test(letters)) return -1;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

export function cellName(row, column) {
  return `${columnName(column)}${String(row + 1)}`;
}

/** `{ row, column }` (zero-based) for "B12", or `undefined` for anything else. */
export function parseCellName(text) {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/u.exec(String(text).trim());
  if (match === null) return undefined;
  return { row: Number(match[2]) - 1, column: columnIndex(match[1] ?? "") };
}

/** A range with its corners in order. */
export function normalizeRange(a, b) {
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.column, b.column),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.column, b.column),
  };
}

/** "B2:D9", or "B2" for a single cell. */
export function rangeName(range) {
  const start = cellName(range.top, range.left);
  return range.top === range.bottom && range.left === range.right ? start : `${start}:${cellName(range.bottom, range.right)}`;
}

/** A range for "B2:D9" or "B2", or `undefined`. */
export function parseRangeName(text) {
  const [first, second, extra] = String(text).trim().split(":");
  if (extra !== undefined || first === undefined) return undefined;
  const a = parseCellName(first);
  const b = second === undefined ? a : parseCellName(second);
  return a === undefined || b === undefined ? undefined : normalizeRange(a, b);
}

export function sameRange(a, b) {
  return a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right;
}

export function inRange(range, row, column) {
  return row >= range.top && row <= range.bottom && column >= range.left && column <= range.right;
}

/**
 * What raw input means: empty, a number, text, or a formula.
 *
 * A leading `'` makes the rest text, as in other spreadsheets, so a value exported as `'=1+2` is read back as the text
 * `=1+2` rather than run.
 */
export function classifyInput(raw) {
  const text = raw ?? "";
  if (text === "") return { kind: "empty" };
  if (text.startsWith("'")) return { kind: "text", value: text.slice(1) };
  if (text.startsWith("=") && text.length > 1) return { kind: "formula", source: text.slice(1) };
  const trimmed = text.trim();
  if (NUMBER.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isFinite(value)) return { kind: "number", value };
  }
  return { kind: "text", value: text };
}

/**
 * The raw grid. Rows are arrays of raw strings and may be ragged; a missing cell is empty.
 */
export function createSheet(rows = []) {
  const grid = rows.map((row) => row.slice(0, MAX_COLUMNS).map((cell) => String(cell ?? "")));
  let version = 0;

  const raw = (row, column) => grid[row]?.[column] ?? "";

  /** The rows and columns that hold anything, counting from A1. */
  const used = () => {
    let rowsUsed = 0;
    let columnsUsed = 0;
    for (let row = 0; row < grid.length; row += 1) {
      const cells = grid[row] ?? [];
      for (let column = cells.length - 1; column >= 0; column -= 1) {
        if ((cells[column] ?? "") !== "") {
          rowsUsed = row + 1;
          columnsUsed = Math.max(columnsUsed, column + 1);
          break;
        }
      }
    }
    return { rows: rowsUsed, columns: columnsUsed };
  };

  /**
   * Whether writing a value at this cell keeps the sheet inside its bounds. Clearing a cell always does.
   */
  const fits = (row, column, value) => {
    if (row < 0 || column < 0 || row >= MAX_ROWS || column >= MAX_COLUMNS) return false;
    if (value === "") return true;
    const now = used();
    const rows = Math.max(now.rows, row + 1);
    const columns = Math.max(now.columns, column + 1);
    return rows * columns <= MAX_CELLS;
  };

  const set = (row, column, value) => {
    const text = String(value ?? "").slice(0, MAX_CELL_CHARS);
    if (!fits(row, column, text)) return false;
    while (grid.length <= row) grid.push([]);
    const cells = grid[row] ?? [];
    while (cells.length <= column) cells.push("");
    cells[column] = text;
    version += 1;
    return true;
  };

  /** Every non-empty cell, for evaluation and for saving. */
  const forEach = (visit) => {
    for (let row = 0; row < grid.length; row += 1) {
      const cells = grid[row] ?? [];
      for (let column = 0; column < cells.length; column += 1) {
        const value = cells[column] ?? "";
        if (value !== "") visit(row, column, value);
      }
    }
  };

  /** The used area as rows of raw text. */
  const rawRows = () => {
    const size = used();
    const out = [];
    for (let row = 0; row < size.rows; row += 1) {
      const cells = [];
      for (let column = 0; column < size.columns; column += 1) cells.push(raw(row, column));
      out.push(cells);
    }
    return out;
  };

  return { raw, set, fits, used, forEach, rawRows, version: () => version };
}

/**
 * Empty every cell of a range that holds anything, and name the cells that changed. One pass over the range: the caller
 * records the names as one batch, so clearing the whole sheet costs the same as reading it.
 */
export function clearRange(sheet, range) {
  const cleared = [];
  for (let row = range.top; row <= range.bottom; row += 1) {
    for (let column = range.left; column <= range.right; column += 1) {
      if (sheet.raw(row, column) !== "" && sheet.set(row, column, "")) cleared.push(cellName(row, column));
    }
  }
  return cleared;
}

/** The sentence that says a file was not loaded whole, or `undefined` when it was. */
export function truncationNotice(truncated, size, locale) {
  if (!truncated.rows && !truncated.columns && !truncated.clipped) return undefined;
  const vi = locale === "vi";
  const parts = [];
  if (truncated.rows || truncated.columns) {
    parts.push(
      vi
        ? `Chỉ hiện ${String(size.rows)} hàng và ${String(size.columns)} cột đầu tiên; phần còn lại của tệp không được tải.`
        : `Showing the first ${String(size.rows)} rows and ${String(size.columns)} columns; the rest of the file was not loaded.`,
    );
  }
  if (truncated.clipped) {
    parts.push(
      vi
        ? `Ô dài hơn ${String(MAX_CELL_CHARS)} ký tự bị cắt.`
        : `Cells longer than ${String(MAX_CELL_CHARS)} characters were cut.`,
    );
  }
  parts.push(vi ? "Khi xuất, chỉ những gì đang hiện được ghi ra." : "Export writes only what is shown.");
  return parts.join(" ");
}
