import { SEMANTIC_LIMITS, canonicalSemanticDoc, normalizeSemanticDoc } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { MAX_FORMATS, applyFormat, displayValue, formatAt, readFormatDirective, withFormat } from "../widgets/main/formats.js";
import { evaluateSheet } from "../widgets/main/formula.js";
import { semanticDocument } from "../widgets/main/semantic.js";
import {
  MAX_CELLS,
  MAX_COLUMNS,
  MAX_ROWS,
  cellName,
  classifyInput,
  columnIndex,
  columnName,
  createSheet,
  parseCellName,
  parseRangeName,
  rangeName,
  truncationNotice,
} from "../widgets/main/sheet.js";

describe("cell addresses", () => {
  it("names columns and cells both ways", () => {
    expect([0, 25, 26, 51, 52, 63].map(columnName)).toEqual(["A", "Z", "AA", "AZ", "BA", "BL"]);
    expect(columnIndex("bl")).toBe(63);
    expect(columnIndex("A1")).toBe(-1);
    expect(cellName(11, 1)).toBe("B12");
    expect(parseCellName("$B$12")).toEqual({ row: 11, column: 1 });
    expect(parseCellName("B0")).toBeUndefined();
    expect(rangeName({ top: 1, left: 1, bottom: 8, right: 3 })).toBe("B2:D9");
    expect(parseRangeName("D9:B2")).toEqual({ top: 1, left: 1, bottom: 8, right: 3 });
    expect(parseRangeName("B2:C3:D4")).toBeUndefined();
  });

  it("reads raw input as empty, number, text or formula, with a leading quote meaning text", () => {
    expect(classifyInput("")).toEqual({ kind: "empty" });
    expect(classifyInput(" 12.5 ")).toEqual({ kind: "number", value: 12.5 });
    expect(classifyInput("-3e2")).toEqual({ kind: "number", value: -300 });
    expect(classifyInput("12 cái")).toEqual({ kind: "text", value: "12 cái" });
    expect(classifyInput("=A1")).toEqual({ kind: "formula", source: "A1" });
    expect(classifyInput("'=A1")).toEqual({ kind: "text", value: "=A1" });
    expect(classifyInput("=")).toEqual({ kind: "text", value: "=" });
  });
});

describe("the sheet's bounds", () => {
  it("refuses a write that would take the used area past the cell ceiling, and allows clearing", () => {
    const sheet = createSheet();
    expect(MAX_CELLS).toBe(25_000);
    expect(sheet.set(0, 0, "x")).toBe(true);
    expect(sheet.set(MAX_ROWS - 1, 0, "y")).toBe(true);
    // 5,000 rows by 6 columns is 30,000 cells.
    expect(sheet.set(0, 5, "z")).toBe(false);
    expect(sheet.raw(0, 5)).toBe("");
    expect(sheet.set(0, 4, "z")).toBe(true);
    expect(sheet.set(MAX_ROWS, 0, "past")).toBe(false);
    expect(sheet.set(0, MAX_COLUMNS, "past")).toBe(false);
    expect(sheet.set(MAX_ROWS - 1, 0, "")).toBe(true);
    expect(sheet.used()).toEqual({ rows: 1, columns: 5 });
  });

  it("says what a cut file shows and what export writes", () => {
    expect(truncationNotice({ rows: false, columns: false, clipped: false }, { rows: 3, columns: 2 }, "en")).toBeUndefined();
    expect(truncationNotice({ rows: true, columns: false, clipped: false }, { rows: 2500, columns: 10 }, "en")).toBe(
      "Showing the first 2500 rows and 10 columns; the rest of the file was not loaded. Export writes only what is shown.",
    );
    expect(truncationNotice({ rows: false, columns: true, clipped: true }, { rows: 4, columns: 64 }, "vi")).toContain(
      "Chỉ hiện 4 hàng và 64 cột đầu tiên",
    );
  });
});

describe("formats and Clark's instruction", () => {
  it("shows a number under a format without changing it", () => {
    expect(displayValue(0.25, "percent")).toBe("25%");
    expect(displayValue(0.1234, "percent")).toBe("12.34%");
    expect(displayValue(1 / 3, "number")).toBe("0.33");
    expect(displayValue(0.1 + 0.2, "plain")).toBe("0.3");
    expect(displayValue("chữ", "percent")).toBe("chữ");
    expect(displayValue({ error: "#DIV/0!" }, "percent")).toBe("#DIV/0!");
    expect(displayValue(null, "percent")).toBe("");
  });

  it("keeps the latest format for a range in effect", () => {
    let formats = withFormat([], { top: 0, left: 0, bottom: 9, right: 3 }, "number");
    formats = withFormat(formats, { top: 1, left: 1, bottom: 2, right: 2 }, "percent");
    expect(formatAt(formats, 1, 1)).toBe("percent");
    expect(formatAt(formats, 0, 0)).toBe("number");
    expect(formatAt(formats, 20, 0)).toBe("plain");
    formats = withFormat(formats, { top: 1, left: 1, bottom: 2, right: 2 }, "plain");
    expect(formats).toHaveLength(2);
    expect(formatAt(formats, 1, 1)).toBe("plain");
    for (let index = 0; index < 40; index += 1) formats = withFormat(formats, { top: index, left: 0, bottom: index, right: 0 }, "percent");
    expect(formats).toHaveLength(32);
  });

  it("names the formats it had to drop to stay within the bound, so the widget can say so", () => {
    let formats: { range: string; format: string }[] = [];
    for (let index = 0; index < MAX_FORMATS; index += 1) {
      const next = applyFormat(formats, { top: index, left: 0, bottom: index, right: 0 }, "percent");
      expect(next.dropped).toEqual([]);
      formats = next.formats;
    }
    const over = applyFormat(formats, { top: 99, left: 0, bottom: 99, right: 1 }, "percent");
    expect(over.formats).toHaveLength(MAX_FORMATS);
    expect(over.dropped).toEqual([{ range: "A1", format: "percent" }]);
    // Replacing a range already in the list drops nothing.
    expect(applyFormat(over.formats, { top: 99, left: 0, bottom: 99, right: 1 }, "number").dropped).toEqual([]);
  });

  it("applies only the exact instruction for the range that was selected", () => {
    const selected = { top: 1, left: 1, bottom: 8, right: 3 };
    expect(readFormatDirective("  format: percent B2:D9\n", selected)).toEqual({ ok: true, format: "percent", range: selected });
    expect(readFormatDirective("format: percent B2:D9", { top: 0, left: 0, bottom: 0, right: 0 })).toEqual({
      ok: false,
      reason: "other-range",
      range: "B2:D9",
    });
    for (const reply of [
      "Sure! format: percent B2:D9",
      "format: percent B2:D9\nformat: number A1",
      "format: currency B2:D9",
      "FORMAT: percent B2:D9",
      "format: percent b2:d9",
      "format: percent B2:D9; =HYPERLINK()",
      "",
      undefined,
    ]) {
      expect(readFormatDirective(reply, selected).ok, String(reply)).toBe(false);
    }
  });
});

describe("the semantic document", () => {
  const rows = Array.from({ length: 40 }, (_, row) => Array.from({ length: 20 }, (_, column) => (row === 0 ? `Cột ${String(column)}` : String(row * column))));
  rows[1] = ["=SUM(B3:B40)", ...(rows[1] ?? []).slice(1)];
  const sheet = createSheet(rows);
  const evaluation = evaluateSheet(sheet);

  const build = (selection: { top: number; left: number; bottom: number; right: number }) =>
    semanticDocument({
      title: "Doanh thu".repeat(30),
      locale: "vi",
      size: sheet.used(),
      selection,
      active: { row: 1, column: 0 },
      raw: sheet.raw,
      value: (row: number, column: number) => evaluation.get(row, column),
      formats: [{ range: "B2:D9", format: "percent" }],
      truncated: true,
      cycles: [],
    });

  it("carries the range, an excerpt, the active formula and the size", () => {
    const doc = build({ top: 1, left: 1, bottom: 3, right: 2 });
    expect(doc.selectedIds).toEqual(["B2:C4"]);
    expect(doc.values).toMatchObject({
      range: "B2:C4",
      rows: 40,
      columns: 20,
      activeCell: "A2",
      activeFormula: "=SUM(B3:B40)",
      activeValue: "779",
      selectionFormat: "percent",
      excerptComplete: true,
      truncated: true,
    });
    expect(doc.values.excerpt).toEqual(["B2: 100% | 200%", "B3: 200% | 400%", "B4: 300% | 600%"]);
  });

  it("stays inside the host's limits for a selection of the whole sheet, so the host cuts nothing", () => {
    const doc = build({ top: 0, left: 0, bottom: 39, right: 19 });
    expect(doc.values.excerpt).toHaveLength(12);
    expect(doc.values.excerptComplete).toBe(false);
    expect(doc.summary.length).toBeLessThanOrEqual(SEMANTIC_LIMITS.summary);
    const normalized = normalizeSemanticDoc({
      instanceId: "winst_sheet",
      definitionId: "com.example.spreadsheet.main@1",
      summary: doc.summary,
      values: doc.values,
      selectedIds: doc.selectedIds,
      source: "frame",
    });
    expect(normalized.values).toEqual(doc.values);
    expect(normalized.selectedIds).toEqual(doc.selectedIds);
    expect(normalized.summary).toBe(doc.summary);
    expect(new TextEncoder().encode(canonicalSemanticDoc(normalized)).byteLength).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);
  });

  it("names the cells on a circular reference", () => {
    const circular = createSheet([["=B1", "=A1"]]);
    const result = evaluateSheet(circular);
    const doc = semanticDocument({
      title: "",
      locale: "en",
      size: circular.used(),
      selection: { top: 0, left: 0, bottom: 0, right: 1 },
      active: { row: 0, column: 0 },
      raw: circular.raw,
      value: (row: number, column: number) => result.get(row, column),
      formats: [],
      truncated: false,
      cycles: result.cycles,
    });
    expect(doc.values.circular).toEqual(["A1", "B1"]);
    expect(doc.values.excerpt).toEqual(["A1: #CIRC! | #CIRC!"]);
    expect(doc.summary).toContain("Spreadsheet");
  });
});
