/*
 * Comma- and tab-separated text, read in bounded pieces and written back without formulas.
 *
 * Reading is incremental: the widget feeds each chunk it reads through the host as it arrives and stops asking for more
 * once the sheet's ceiling is reached, so a file far larger than the sheet never sits in the frame whole.
 *
 * Writing follows the host's own table export rule: a text value a spreadsheet would run as a formula (one that starts
 * with `=`, `+`, `-`, `@`, a tab or a carriage return) is written with a leading `'`, and a finite number is written as
 * itself. The frame cannot import the host's contracts, so the rule is repeated here and a unit test holds the two equal.
 */

import { classifyInput } from "./sheet.js";

/** A spreadsheet runs a cell that starts with one of these as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/u;

/** The delimiter a file of this type or name uses: a tab for TSV, a comma otherwise. */
export function delimiterFor(mimeType, name) {
  if (mimeType === "text/tab-separated-values") return "\t";
  return /\.(tsv|tab)$/iu.test(String(name ?? "")) ? "\t" : ",";
}

/**
 * A reader that takes text in pieces and keeps at most `maxRows` rows, `maxColumns` columns and `maxCells` cells.
 *
 * `maxCells` bounds the rectangle the kept rows make, rows times the widest row, because that is what the sheet bounds:
 * a ragged file whose fields fit but whose rectangle does not would otherwise load a sheet that refuses every edit.
 *
 * Blank lines are held back until a row with something in it follows, so blank lines at the end of a file neither take
 * a row nor make a file that fits look cut.
 *
 * `push` returns `true` once the ceiling is reached, after which nothing more is kept and the caller should stop
 * reading. `finish` ends the last row and returns what was kept and what was not. With `dropPartial`, for a read that
 * stopped before the end of the file, the unfinished last line is dropped rather than kept as if it were whole.
 */
export function createDelimitedReader(options) {
  const delimiter = options.delimiter;
  const maxRows = options.maxRows;
  const maxColumns = options.maxColumns;
  const maxCells = options.maxCells;
  const maxCellChars = options.maxCellChars;

  const rows = [];
  let cells = 0;
  /** The widest kept row: the sheet's rectangle is the kept rows times this. */
  let width = 0;
  /** Blank lines read since the last row with something in it. */
  let blank = 0;
  let row = [];
  let field = "";
  let quoted = false;
  /** Inside a quoted field, a quote was the last character seen: it is either an escaped quote or the field's end. */
  let quoteSeen = false;
  /** A carriage return ended a row; a line feed straight after it belongs to the same line end. */
  let afterCR = false;
  let atFieldStart = true;
  let started = false;
  let full = false;
  const dropped = { rows: false, columns: false, clipped: false };

  /** A field never grows past the cell limit, however long the file's line is. */
  const append = (char) => {
    if (field.length < maxCellChars) field += char;
    else dropped.clipped = true;
  };

  const endField = () => {
    if (row.length < maxColumns) {
      row.push(field);
    } else {
      dropped.columns = true;
    }
    field = "";
    atFieldStart = true;
  };

  const endRow = () => {
    endField();
    if (full) {
      row = [];
      return;
    }
    if (row.length === 1 && row[0] === "") {
      blank += 1;
      row = [];
      return;
    }
    const count = rows.length + blank + 1;
    const nextWidth = Math.max(width, row.length);
    if (count > maxRows || count * nextWidth > maxCells) {
      // A row exists that does not fit: what is kept is a prefix of the file, and the notice says so.
      full = true;
      dropped.rows = true;
      row = [];
      return;
    }
    for (; blank > 0; blank -= 1) rows.push([""]);
    rows.push(row);
    cells += row.length;
    width = nextWidth;
    row = [];
  };

  const push = (text) => {
    for (let index = 0; index < text.length; index += 1) {
      if (full) return true;
      const char = text[index];
      if (!started) {
        started = true;
        if (char === "\uFEFF") continue;
      }
      if (afterCR) {
        afterCR = false;
        if (char === "\n") continue;
      }
      if (quoted) {
        if (quoteSeen) {
          quoteSeen = false;
          if (char === '"') {
            append('"');
            continue;
          }
          quoted = false;
          // Fall through: the quote closed the field, and this character is read as outside it.
        } else if (char === '"') {
          quoteSeen = true;
          continue;
        } else {
          append(char);
          continue;
        }
      }
      if (char === '"' && atFieldStart) {
        quoted = true;
        atFieldStart = false;
        continue;
      }
      if (char === delimiter) {
        endField();
        continue;
      }
      if (char === "\r" || char === "\n") {
        if (char === "\r") afterCR = true;
        endRow();
        continue;
      }
      atFieldStart = false;
      append(char);
    }
    return full;
  };

  const finish = (options = {}) => {
    const partial = field !== "" || row.length > 0 || !atFieldStart || quoted;
    if (!full && partial) {
      if (options.dropPartial === true) {
        // The read stopped mid-line: what is left is a fragment of a row, not a row.
        dropped.rows = true;
      } else {
        if (quoted && quoteSeen) quoted = false;
        // A file that ends with a line end has no last row to add; one that does not, does.
        endRow();
      }
    }
    row = [];
    field = "";
    return { rows, cells, truncated: { ...dropped } };
  };

  return { push, finish, isFull: () => full };
}

/** Text in one piece, read whole: for tests and for files already in memory. */
export function parseDelimited(text, options) {
  const reader = createDelimitedReader(options);
  reader.push(text);
  return reader.finish();
}

function fieldText(text, delimiter) {
  const needsQuotes = text.includes('"') || text.includes(delimiter) || text.includes("\r") || text.includes("\n");
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * A value as an exported cell: a finite number as itself, nothing for an empty cell, and text a spreadsheet would run as
 * a formula with a leading `'`. This is the host's table export rule, and a unit test holds the two equal.
 */
export function exportedCellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = String(value);
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

/**
 * A value as the sheet exports it: the host's rule, plus a leading `'` on text this sheet would otherwise read back as
 * something else — `007` or `1e3` (a number), or text that itself starts with `'` — so it imports as the same text.
 */
export function sheetCellText(value) {
  const text = exportedCellText(value);
  if (typeof value !== "string" || value === "" || text !== value) return text;
  const reread = classifyInput(value);
  return reread.kind === "text" && reread.value === value ? text : `'${value}`;
}

/**
 * Rows of values as delimited text, lines ending in CRLF. With `neutralize` (the default) every text value is written the
 * way `sheetCellText` writes it; without, each value is written as it is, which is how the widget keeps its own copy.
 */
export function writeDelimited(rows, delimiter, options = {}) {
  const neutralize = options.neutralize !== false;
  const lines = rows.map((cells) =>
    cells
      .map((value) => fieldText(neutralize ? sheetCellText(value) : value === null || value === undefined ? "" : String(value), delimiter))
      .join(delimiter),
  );
  return lines.length === 0 ? "" : `${lines.join("\r\n")}\r\n`;
}
