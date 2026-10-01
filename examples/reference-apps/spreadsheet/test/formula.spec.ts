import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateFormula, evaluateSheet, parseFormula } from "../widgets/main/formula.js";
import { MAX_COLUMNS, createSheet } from "../widgets/main/sheet.js";

const widgetDir = join(import.meta.dirname, "..", "widgets", "main");

/** A lookup over a small grid of values, by A1 name. */
function cells(values: Record<string, number | string>): (row: number, column: number) => number | string | null {
  return (row, column) => {
    const name = `${String.fromCharCode(65 + column)}${String(row + 1)}`;
    return Object.hasOwn(values, name) ? (values[name] ?? null) : null;
  };
}

describe("evaluating one formula", () => {
  it("follows arithmetic precedence, unary minus and parentheses", () => {
    expect(evaluateFormula("1+2*3")).toBe(7);
    expect(evaluateFormula("(1+2)*3")).toBe(9);
    expect(evaluateFormula("-2^2")).toBe(4);
    expect(evaluateFormula("2^3^2")).toBe(64);
    expect(evaluateFormula("10/4-0.5")).toBe(2);
    expect(evaluateFormula(" 1 + +2 ")).toBe(3);
    expect(evaluateFormula("1.5e2")).toBe(150);
  });

  it("reads cells and ranges, ignoring text and empty cells inside ranges", () => {
    const lookup = cells({ A1: 1, A2: 2, A3: "tên", B1: 4 });
    expect(evaluateFormula("A1+B1", lookup)).toBe(5);
    expect(evaluateFormula("$A$1*b1", lookup)).toBe(4);
    expect(evaluateFormula("SUM(A1:B4)", lookup)).toBe(7);
    expect(evaluateFormula("sum(A1:A3, 10, B1)", lookup)).toBe(17);
    expect(evaluateFormula("AVERAGE(A1:A4)", lookup)).toBe(1.5);
    expect(evaluateFormula("MIN(A1:B2)", lookup)).toBe(1);
    expect(evaluateFormula("MAX(A1:B2)", lookup)).toBe(4);
    expect(evaluateFormula("COUNT(A1:B4)", lookup)).toBe(3);
    expect(evaluateFormula("MIN(C1:C3)", lookup)).toBe(0);
    expect(evaluateFormula("C9+1", lookup)).toBe(1);
  });

  it("reports errors as values and passes them through", () => {
    const lookup = cells({ A1: "chữ", A2: 0 });
    expect(evaluateFormula("1/0")).toEqual({ error: "#DIV/0!" });
    expect(evaluateFormula("1/A2", lookup)).toEqual({ error: "#DIV/0!" });
    expect(evaluateFormula("A1+1", lookup)).toEqual({ error: "#VALUE!" });
    expect(evaluateFormula("A1:A2", lookup)).toEqual({ error: "#VALUE!" });
    expect(evaluateFormula("AVERAGE(C1:C3)", lookup)).toEqual({ error: "#DIV/0!" });
    expect(evaluateFormula("ZZZ9999999+1")).toEqual({ error: "#REF!" });
    expect(evaluateFormula("BM1+1")).toEqual({ error: "#REF!" });
    expect(evaluateFormula("A5001")).toEqual({ error: "#REF!" });
    expect(evaluateFormula("NOW()+1")).toEqual({ error: "#PARSE!" });
    expect(evaluateFormula("POWER(2,3)")).toEqual({ error: "#NAME?" });
    expect(evaluateFormula("10^400")).toEqual({ error: "#NUM!" });
    expect(evaluateFormula("SUM(1/0, 2)")).toEqual({ error: "#DIV/0!" });
    expect(evaluateFormula("COUNT(1/0, 2)")).toBe(1);
  });

  it("refuses text that is not a formula of the closed set, without running any of it", () => {
    for (const source of ["", "1+", "(1", "1)", "SUM()", "A1:", "\"x\"", "1;2", "alert(1)", "constructor.constructor('x')()", "x=>1", "`1`"]) {
      const value = evaluateFormula(source);
      expect(value, source).toEqual(expect.objectContaining({ error: expect.stringMatching(/^#(PARSE|NAME)/u) }));
    }
    expect(parseFormula("1".repeat(1_001))).toEqual({ type: "error", code: "#PARSE!" });
    expect(parseFormula(`${"(".repeat(80)}1${")".repeat(80)}`)).toEqual({ type: "error", code: "#PARSE!" });
  });

  it("has no path from formula text to code", () => {
    for (const file of ["formula.js", "csv.js", "sheet.js", "formats.js", "semantic.js", "main.js"]) {
      const source = readFileSync(join(widgetDir, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
      expect(source, file).not.toMatch(/\beval\s*\(|\bFunction\s*\(|new\s+Function\b|setTimeout\s*\(\s*["'`]|innerHTML|insertAdjacentHTML|document\.write/u);
    }
  });
});

describe("evaluating a sheet", () => {
  it("evaluates formulas in dependency order, whatever order they sit in", () => {
    const sheet = createSheet([["=B1*2", "=C1+1", "5"], ["=SUM(A1:C1)"]]);
    const result = evaluateSheet(sheet);
    expect(result.get(0, 0)).toBe(12);
    expect(result.get(0, 1)).toBe(6);
    expect(result.get(1, 0)).toBe(23);
    expect(result.cycles).toEqual([]);
    expect(result.errors).toBe(0);
  });

  it("names the cells on a circular reference and marks what reads them", () => {
    const sheet = createSheet([["=B1+1", "=A1+1", "=A1*2", "7"], ["=A2"], ["=SUM(A1:D1)"]]);
    const result = evaluateSheet(sheet);
    expect(result.cycles).toEqual(["A1", "B1", "A2"]);
    expect(result.get(0, 0)).toEqual({ error: "#CIRC!" });
    expect(result.get(0, 1)).toEqual({ error: "#CIRC!" });
    expect(result.get(1, 0)).toEqual({ error: "#CIRC!" });
    // Not on a cycle, but reading one.
    expect(result.get(0, 2)).toEqual({ error: "#CIRC!" });
    expect(result.get(2, 0)).toEqual({ error: "#CIRC!" });
    expect(result.get(0, 3)).toBe(7);
  });

  it("treats a range that includes its own cell as circular", () => {
    const result = evaluateSheet(createSheet([["1", "2", "=SUM(A1:C1)"]]));
    expect(result.cycles).toEqual(["C1"]);
    expect(result.get(0, 2)).toEqual({ error: "#CIRC!" });
  });

  it("evaluates a long chain without exhausting the call stack", () => {
    const rows = [["1"], ...Array.from({ length: 4_999 }, (_, index) => [`=A${String(index + 1)}+1`])];
    const result = evaluateSheet(createSheet(rows));
    expect(result.get(4_999, 0)).toBe(5_000);
    const cycle = [["=A5000"], ...Array.from({ length: 4_999 }, (_, index) => [`=A${String(index + 1)}+1`])];
    expect(evaluateSheet(createSheet(cycle)).cycles).toHaveLength(5_000);
  });

  it("gives up on a sheet whose formulas reach too many cells, and says so", () => {
    // 900 formulas each summing a range of plain numbers: within the budget.
    const rows = Array.from({ length: 50 }, (_, row) =>
      Array.from({ length: Math.min(MAX_COLUMNS, 50) }, (_, column) => (row < 18 ? `=SUM(A20:AX50)+${String(column)}` : "1")),
    );
    const result = evaluateSheet(createSheet(rows));
    expect(result.limited).toBe(false);
    // 2,500 formulas each summing the whole sheet, every other formula included: past it.
    const heavy = Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => "=SUM(A1:AX50)"));
    const limited = evaluateSheet(createSheet(heavy));
    expect(limited.limited).toBe(true);
    expect(limited.get(0, 0)).toEqual({ error: "#LIMIT!" });
  });
});
