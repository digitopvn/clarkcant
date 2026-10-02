import { type TableColumn, toCsv } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import {
  createDelimitedReader,
  delimiterFor,
  exportedCellText,
  parseDelimited,
  sheetCellText,
  writeDelimited,
} from "../widgets/main/csv.js";
import { evaluateSheet } from "../widgets/main/formula.js";
import { MAX_CELL_CHARS, classifyInput, createSheet } from "../widgets/main/sheet.js";

const wide = { delimiter: ",", maxRows: 5_000, maxColumns: 64, maxCells: 25_000, maxCellChars: MAX_CELL_CHARS };

/** The values a sheet built from these rows shows, cell by cell, an error as its code. */
function valuesOf(rows: string[][]): (string | number | null)[][] {
  const sheet = createSheet(rows);
  const evaluation = evaluateSheet(sheet);
  const size = sheet.used();
  return Array.from({ length: size.rows }, (_, row) =>
    Array.from({ length: size.columns }, (_, column) => {
      const value = evaluation.get(row, column) as string | number | null | { error: string };
      return typeof value === "object" && value !== null ? value.error : value;
    }),
  );
}

describe("reading delimited text", () => {
  it("reads quoted fields, escaped quotes, line breaks inside quotes and both line ends", () => {
    const text = '\uFEFFten,ghi chú\r\n"Nguyễn, An","nói ""chào""\nrồi đi"\nB,\n';
    expect(parseDelimited(text, wide).rows).toEqual([
      ["ten", "ghi chú"],
      ["Nguyễn, An", 'nói "chào"\nrồi đi'],
      ["B", ""],
    ]);
  });

  it("reads the same rows however the text is split into chunks", () => {
    const text = 'a,"b\r\nc",""""\r\n1,2,3\r\n"x"",y",z';
    const whole = parseDelimited(text, wide).rows;
    for (const size of [1, 2, 3, 7]) {
      const reader = createDelimitedReader(wide);
      for (let index = 0; index < text.length; index += size) reader.push(text.slice(index, index + size));
      expect(reader.finish().rows).toEqual(whole);
    }
    expect(whole).toEqual([["a", "b\r\nc", '"'], ["1", "2", "3"], ['x",y', "z"]]);
  });

  it("splits tab-separated values on tabs and picks the delimiter from the type or the name", () => {
    expect(parseDelimited("a\tb,c\n1\t2\n", { ...wide, delimiter: "\t" }).rows).toEqual([["a", "b,c"], ["1", "2"]]);
    expect(delimiterFor("text/tab-separated-values", "x.csv")).toBe("\t");
    expect(delimiterFor("text/csv", "bang.tsv")).toBe("\t");
    expect(delimiterFor("text/csv", "bang.csv")).toBe(",");
  });

  it("keeps a prefix of the file at the ceiling and says what it dropped", () => {
    const rows = Array.from({ length: 50 }, (_, row) => Array.from({ length: 10 }, (_, column) => String(row * 10 + column)).join(","));
    const reader = createDelimitedReader({ ...wide, maxCells: 105 });
    const full = reader.push(`${rows.join("\n")}\n`);
    expect(full).toBe(true);
    const result = reader.finish();
    expect(result.rows).toHaveLength(10);
    expect(result.cells).toBe(100);
    expect(result.truncated).toEqual({ rows: true, columns: false, clipped: false });

    const columns = parseDelimited("a,b,c,d\n1,2,3,4\n", { ...wide, maxColumns: 2 });
    expect(columns.rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(columns.truncated.columns).toBe(true);

    const long = parseDelimited(`${"x".repeat(50)},y\n`, { ...wide, maxCellChars: 8 });
    expect(long.rows).toEqual([["xxxxxxxx", "y"]]);
    expect(long.truncated.clipped).toBe(true);

    const rowsOnly = parseDelimited("1\n2\n3\n", { ...wide, maxRows: 2 });
    expect(rowsOnly.rows).toEqual([["1"], ["2"]]);
    expect(rowsOnly.truncated.rows).toBe(true);
  });

  it("does not report a file that fits exactly as cut", () => {
    const result = parseDelimited("1,2\n3,4\n", { ...wide, maxCells: 4, maxRows: 2 });
    expect(result.rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(result.truncated).toEqual({ rows: false, columns: false, clipped: false });
  });

  it("does not call a file cut for blank lines at its end, and keeps blank lines between rows", () => {
    const end = parseDelimited("1\n2\n\n\r\n", { ...wide, maxRows: 2 });
    expect(end.rows).toEqual([["1"], ["2"]]);
    expect(end.truncated.rows).toBe(false);
    expect(parseDelimited("1\n\n3\n", wide).rows).toEqual([["1"], [""], ["3"]]);
    // A blank line still counts once a row follows it.
    expect(parseDelimited("1\n\n3\n", { ...wide, maxRows: 2 }).truncated.rows).toBe(true);
  });

  it("bounds the rectangle a ragged file makes, as the sheet does, not just its fields", () => {
    const text = `${["a,b,c,d,e,f,g,h,i,j", ...Array.from({ length: 30 }, () => "x")].join("\n")}\n`;
    const result = parseDelimited(text, { ...wide, maxCells: 100 });
    // Ten rows of the widest row's ten columns is the most that fits, though the fields would number only 19.
    expect(result.rows).toHaveLength(10);
    expect(result.truncated.rows).toBe(true);
  });

  it("drops the unfinished last line of a read that stopped early, and keeps it when the file ended there", () => {
    const stopped = createDelimitedReader(wide);
    stopped.push("12345,hello world\n12");
    expect(stopped.finish({ dropPartial: true })).toMatchObject({ rows: [["12345", "hello world"]], truncated: { rows: true } });
    const ended = createDelimitedReader(wide);
    ended.push("12345,hello world\n12");
    expect(ended.finish()).toMatchObject({ rows: [["12345", "hello world"], ["12"]], truncated: { rows: false } });
  });
});

describe("writing an export", () => {
  it("neutralizes text a spreadsheet would run, exactly as the host's table export does", () => {
    const samples: (string | number | null)[] = [
      "=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tlead", "\rlead", "plain", "a,b", 'say "hi"', "dòng\nhai",
      -5, 0.25, 1e21, null, "",
    ];
    const columns: TableColumn[] = samples.map((_, index) => ({ key: `c${String(index)}`, label: `c${String(index)}`, type: "text", align: "start" }));
    const row = Object.fromEntries(samples.map((value, index) => [`c${String(index)}`, value]));
    const host = toCsv(columns, [row]).split("\r\n")[1];
    const ours = writeDelimited([samples], ",").split("\r\n")[0];
    expect(ours).toBe(host);
    expect(exportedCellText("=1+2")).toBe("'=1+2");
    expect(exportedCellText(-5)).toBe("-5");
    expect(exportedCellText(Number.NaN)).toBe("");
  });

  it("quotes a tab inside a TSV field, and writes raw input untouched for the widget's own copy", () => {
    expect(writeDelimited([["a\tb", "c"]], "\t")).toBe('"a\tb"\tc\r\n');
    expect(writeDelimited([["=A1+1", "'x"]], ",", { neutralize: false })).toBe("=A1+1,'x\r\n");
    expect(writeDelimited([], ",")).toBe("");
  });

  it("writes text that would read back as a number, or that starts with a quote, behind a quote", () => {
    // Typed as `'007`, `'1e3` and `''x`: text whose values are 007, 1e3 and 'x.
    const sheet = createSheet([["'007", "'1e3", "''x", "007", "chữ"]]);
    const before = valuesOf(sheet.rawRows());
    expect(before).toEqual([["007", "1e3", "'x", 7, "chữ"]]);
    expect(writeDelimited(before, ",")).toBe("'007,'1e3,''x,7,chữ\r\n");
    expect(valuesOf(parseDelimited(writeDelimited(before, ","), wide).rows)).toEqual(before);
    expect(sheetCellText("=1")).toBe("'=1");
    expect(sheetCellText(" 12 ")).toBe("' 12 ");
  });

  it("reimports an export to the same values: formulas as their results, errors as their codes", () => {
    const rows = [
      ["Tên", "Số", "Tỉ lệ", "Ghi chú"],
      ["An", "10", "=B2/40", "=bad"],
      ["Bình", "-30", "=B3/40", "'@mention"],
      ["Tổng", "=SUM(B2:B3)", "=C2+C3", "-dash"],
    ];
    const before = valuesOf(rows);
    for (const delimiter of [",", "\t"]) {
      const text = `\uFEFF${writeDelimited(before, delimiter)}`;
      const reread = parseDelimited(text, { ...wide, delimiter }).rows;
      expect(valuesOf(reread)).toEqual(before);
      // Nothing that comes back runs as a formula.
      for (const cells of reread) for (const raw of cells) expect(classifyInput(raw).kind).not.toBe("formula");
    }
    // A formula that cannot be read exports its error as text, which reads back as the same text.
    expect(before[1]?.[3]).toBe("#PARSE!");
    expect(before[3]).toEqual(["Tổng", -20, -0.5, "-dash"]);
  });
});
