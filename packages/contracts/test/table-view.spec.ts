import { describe, expect, it } from "vitest";

import {
  TABLE_LIMITS,
  foldTableText,
  normalizeTableColumns,
  normalizeTableFilters,
  normalizeTablePageSize,
  normalizeTableSelectedIds,
  normalizeTableSelection,
  resolveTableRowIds,
  tableSemanticState,
  tableView,
  toCsv,
} from "../src/index.ts";

/**
 * The table view model the browser draws and the node exports.
 *
 * Both sides run these functions, so a person's CSV holds the rows they were looking at. The
 * inputs are untrusted; several cases below feed nonsense and expect a clamped, usable view.
 */

const ROWS = [
  { id: "a", name: "Đồng Nai", runs: 12, day: "2026-09-03", ok: true },
  { id: "b", name: "Hà Nội", runs: 3, day: "2026-09-01", ok: false },
  { id: "c", name: "hue", runs: null, day: "2026-09-02", ok: true },
  { id: "d", name: "An Giang", runs: 40, day: "", ok: false },
  { id: "e", name: "item 10", runs: 7, day: "2026-08-30", ok: true },
  { id: "f", name: "item 9", runs: 7, day: "2026-08-29", ok: true },
];

describe("columns", () => {
  it("infers columns and their types from the rows when none are declared", () => {
    const columns = normalizeTableColumns(undefined, ROWS);
    expect(columns.map((column) => column.key)).toEqual(["id", "name", "runs", "day", "ok"]);
    expect(columns.find((column) => column.key === "runs")).toMatchObject({ type: "number", align: "end" });
    expect(columns.find((column) => column.key === "ok")).toMatchObject({ type: "boolean", align: "start" });
    // Dates are only dates when declared: a string column is text.
    expect(columns.find((column) => column.key === "day")?.type).toBe("text");
  });

  it("follows declared columns: their order, labels and set, and nothing else", () => {
    const columns = normalizeTableColumns(
      ["runs", { key: "name", label: "Tỉnh", align: "center" }, { key: "day", type: "date" }, "runs", { label: "no key" }],
      ROWS,
    );
    expect(columns).toEqual([
      { key: "runs", label: "runs", type: "number", align: "end" },
      { key: "name", label: "Tỉnh", type: "text", align: "center" },
      { key: "day", label: "day", type: "date", align: "start" },
    ]);
  });

  it("clamps a declared format and drops what it does not understand", () => {
    const [column] = normalizeTableColumns(
      [{ key: "runs", format: { decimals: 99, unit: " lần ", style: "percent", colour: "red" } }],
      ROWS,
    );
    expect(column?.format).toEqual({ decimals: TABLE_LIMITS.maxDecimals, unit: "lần", style: "percent" });
  });

  it("falls back to inference when every declared column is unusable, and caps the count", () => {
    expect(normalizeTableColumns([42, { key: "" }], ROWS).map((column) => column.key)).toContain("name");
    const wide = Array.from({ length: 60 }, (_, index) => `c${index}`);
    expect(normalizeTableColumns(wide, [])).toHaveLength(TABLE_LIMITS.maxColumns);
    expect(normalizeTableColumns(undefined, [])).toEqual([]);
  });
});

describe("normalization", () => {
  it("clamps the page size to 5-200 and defaults it to 25", () => {
    expect(normalizeTablePageSize(undefined)).toBe(25);
    expect(normalizeTablePageSize("10")).toBe(25);
    expect(normalizeTablePageSize(1)).toBe(5);
    expect(normalizeTablePageSize(10_000)).toBe(200);
    expect(normalizeTablePageSize(12.6)).toBe(13);
  });

  it("defaults selection to single", () => {
    expect(normalizeTableSelection(undefined)).toBe("single");
    expect(normalizeTableSelection("multi")).toBe("multi");
    expect(normalizeTableSelection("all")).toBe("single");
  });

  it("keeps selected ids that are strings, once each, within the selection mode", () => {
    expect(normalizeTableSelectedIds(["a", "a", 3, "", "b"], "multi")).toEqual(["a", "b"]);
    expect(normalizeTableSelectedIds(["a", "b"], "single")).toEqual(["a"]);
    expect(normalizeTableSelectedIds(["a"], "none")).toEqual([]);
    const many = Array.from({ length: 100 }, (_, index) => String(index));
    expect(normalizeTableSelectedIds(many, "multi")).toHaveLength(TABLE_LIMITS.maxSelectedIds);
  });

  it("keeps only primitive filter values and never touches the prototype", () => {
    const filters = normalizeTableFilters(JSON.parse('{"__proto__": "x", "ok": true, "bad": {"a": 1}, "n": null}'));
    expect(Object.getPrototypeOf(filters)).toBe(Object.prototype);
    expect(Object.keys(filters)).toEqual(["__proto__", "ok", "n"]);
    expect(normalizeTableFilters("ok=true")).toEqual({});
  });
});

describe("row ids", () => {
  it("uses the id field when every row has a distinct one", () => {
    expect(resolveTableRowIds(ROWS)).toEqual({ ids: ["a", "b", "c", "d", "e", "f"], stable: true });
  });

  it("uses a named field", () => {
    expect(resolveTableRowIds([{ key: 7 }, { key: 8 }], "key")).toEqual({ ids: ["7", "8"], stable: true });
  });

  it("falls back to positions, and says so, when an id is missing or repeated", () => {
    expect(resolveTableRowIds([{ id: "x" }, { name: "no id" }])).toEqual({ ids: ["0", "1"], stable: false });
    expect(resolveTableRowIds([{ id: "x" }, { id: "x" }])).toEqual({ ids: ["0", "1"], stable: false });
  });
});

describe("tableView", () => {
  it("sorts numbers numerically, stably, with empty cells last in either direction", () => {
    const ascending = tableView(ROWS, { sort: { column: "runs", direction: "asc" } });
    expect(ascending.rows.map((entry) => entry.id)).toEqual(["b", "e", "f", "a", "d", "c"]);
    const descending = tableView(ROWS, { sort: { column: "runs", direction: "desc" } });
    expect(descending.rows.map((entry) => entry.id)).toEqual(["d", "a", "e", "f", "b", "c"]);
  });

  it("sorts text naturally and ignores case and accents", () => {
    const view = tableView(ROWS, { columns: ["id", "name"], sort: { column: "name", direction: "asc" } });
    expect(view.rows.map((entry) => entry.row.name)).toEqual(["An Giang", "Đồng Nai", "Hà Nội", "hue", "item 9", "item 10"]);
  });

  it("sorts a declared date column by time", () => {
    const view = tableView(ROWS, { columns: [{ key: "day", type: "date" }], sort: { column: "day", direction: "asc" } });
    expect(view.rows.map((entry) => entry.id)).toEqual(["f", "e", "b", "c", "a", "d"]);
  });

  it("ignores a sort on a column the table does not show", () => {
    expect(tableView(ROWS, { columns: ["name"], sort: { column: "runs", direction: "asc" } }).sort).toBeNull();
  });

  it("searches the shown columns, every term, without case or accents", () => {
    expect(tableView(ROWS, { query: "dong" }).rows.map((entry) => entry.id)).toEqual(["a"]);
    expect(tableView(ROWS, { query: "HA noi" }).rows.map((entry) => entry.id)).toEqual(["b"]);
    expect(tableView(ROWS, { query: "item 1" }).rows.map((entry) => entry.id)).toEqual(["e"]);
    // `id` is not shown, so it is not searched.
    expect(tableView(ROWS, { columns: ["name"], query: "a" }).rows.map((entry) => entry.id)).not.toContain("c");
  });

  it("filters on exact values, including a field the table does not show", () => {
    expect(tableView(ROWS, { columns: ["name"], filters: { ok: false } }).rows.map((entry) => entry.id)).toEqual(["b", "d"]);
    expect(tableView(ROWS, { filters: { runs: null } }).rows.map((entry) => entry.id)).toEqual(["c"]);
    expect(tableView(ROWS, { filters: { runs: "7" } }).total).toBe(2);
  });

  it("pages within bounds and never returns more rows than the page size", () => {
    const rows = Array.from({ length: 153 }, (_, index) => ({ n: index }));
    const view = tableView(rows, { pageSize: 25, page: 2 });
    expect(view).toMatchObject({ total: 153, pageCount: 7, page: 2, pageSize: 25 });
    expect(view.pageRows.map((entry) => entry.row.n)).toEqual(Array.from({ length: 25 }, (_, index) => 25 + index));
    expect(tableView(rows, { pageSize: 25, page: 99 }).page).toBe(7);
    expect(tableView(rows, { pageSize: 25, page: 99 }).pageRows).toHaveLength(3);
    expect(tableView(rows, { page: -4 }).page).toBe(1);
    expect(tableView([], {})).toMatchObject({ total: 0, page: 1, pageCount: 1, pageRows: [] });
  });

  it("totals every matching row, not only the page", () => {
    const view = tableView(ROWS, {
      pageSize: 5,
      filters: { ok: true },
      totals: [
        { column: "runs", fn: "sum" },
        { column: "runs", fn: "avg" },
        { column: "runs", fn: "min" },
        { column: "runs", fn: "max" },
        { column: "runs", fn: "count" },
        { column: "name", fn: "sum" },
        { column: "missing", fn: "sum" },
        { column: "runs", fn: "median" },
      ],
    });
    expect(view.totals).toEqual([
      { column: "runs", fn: "sum", value: 26 },
      { column: "runs", fn: "avg", value: 26 / 3 },
      { column: "runs", fn: "min", value: 7 },
      { column: "runs", fn: "max", value: 12 },
      { column: "runs", fn: "count", value: 3 },
      { column: "name", fn: "sum", value: null },
    ]);
  });

  it("totals a large dataset without overflowing the stack", () => {
    const rows = Array.from({ length: 200_000 }, (_, index) => ({ n: index }));
    expect(tableView(rows, { totals: [{ column: "n", fn: "max" }] }).totals[0]?.value).toBe(199_999);
  });

  it("survives rows that are not objects", () => {
    const view = tableView([null, "x", { a: 1 }] as unknown[], { columns: ["a"] });
    expect(view.rows.map((entry) => entry.row.a)).toEqual([undefined, undefined, 1]);
    expect(view.stableIds).toBe(false);
  });
});

describe("tableSemanticState", () => {
  it("summarizes the view in bounded English and carries the selection", () => {
    const view = tableView(ROWS, { query: "i", sort: { column: "runs", direction: "desc" }, pageSize: 5 });
    const state = tableSemanticState(view, { title: "Tỉnh", selectedIds: ["a", "b", "a"], selection: "multi" });
    expect(state).toMatchObject({ selectedIds: ["a", "b"], sort: { column: "runs", direction: "desc" }, query: "i", page: 1, stableIds: true });
    expect(state.summary).toContain('Table "Tỉnh"');
    expect(state.summary).toContain(`${view.total} of 6 rows`);
    expect(state.summary).toContain("sorted by runs descending");
    expect(state.summary).toContain("2 selected");
    expect(state.summary).not.toContain("positions");
  });

  it("says when row ids are positions", () => {
    const state = tableSemanticState(tableView([{ n: 1 }, { n: 2 }]), {});
    expect(state.stableIds).toBe(false);
    expect(state.summary).toContain("row ids are positions");
  });

  it("keeps the summary within the semantic view limit", () => {
    const columns = Array.from({ length: 40 }, (_, index) => ({ key: `c${index}`, label: "x".repeat(100) }));
    const state = tableSemanticState(tableView([], { columns }), { title: "t" });
    expect(state.summary.length).toBeLessThanOrEqual(TABLE_LIMITS.maxSummaryLength);
  });
});

describe("toCsv", () => {
  const columns = normalizeTableColumns(["name", "value"], []);

  it("writes a header and CRLF lines, quoting per RFC 4180", () => {
    const csv = toCsv(columns, [
      { name: 'say "hi"', value: "a,b" },
      { name: "two\nlines", value: 3.5 },
      { name: null, value: true },
    ]);
    expect(csv).toBe('name,value\r\n"say ""hi""","a,b"\r\n"two\nlines",3.5\r\n,true\r\n');
  });

  it("defuses every cell a spreadsheet would run as a formula", () => {
    const csv = toCsv(columns, [
      { name: '=HYPERLINK("http://x","y")', value: "+1" },
      { name: "-2+3", value: "@SUM(A1)" },
      { name: "\tlead tab", value: "\rlead cr" },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://x"",""y"")",'+1`);
    expect(lines[2]).toBe("'-2+3,'@SUM(A1)");
    expect(lines[3]).toBe(`'\tlead tab,"'\rlead cr"`);
  });

  it("keeps a negative number a number, since it cannot carry a formula", () => {
    expect(toCsv(columns, [{ name: "n", value: -5 }])).toBe("name,value\r\nn,-5\r\n");
  });

  it("defuses a header label too", () => {
    const [header] = toCsv(normalizeTableColumns([{ key: "a", label: "=cmd" }], []), []).split("\r\n");
    expect(header).toBe("'=cmd");
  });
});

describe("foldTableText", () => {
  it("folds Vietnamese to plain lowercase letters", () => {
    expect(foldTableText("Đồng Tháp Mười")).toBe("dong thap muoi");
  });
});
