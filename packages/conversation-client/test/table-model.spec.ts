import { describe, expect, it } from "vitest";

import { normalizeTableColumns, tableView } from "@clarkcant/contracts";

import { GatewayClient, GatewayError, attachmentFilename } from "../src/api.ts";
import {
  formatTableTotal,
  nextTableSort,
  pageSelectionState,
  readTableViewState,
  tableAriaSort,
  tableCellFormatter,
  tableExportRequest,
  tableExportRequestFrom,
  tablePageLabel,
  tableSelectionFull,
  togglePageSelection,
  toggleTableSelection,
} from "../src/table-model.ts";

/**
 * The table renderer's decisions, without a DOM.
 *
 * How a cell reads in each language, what a header does to the sort, what a checkbox does to the selection and
 * what an export asks the node for are all decided here; the browser journey covers the drawing.
 */

const LABELS = { yes: "Có", no: "Không" };
const column = (spec: Record<string, unknown>) => {
  const [resolved] = normalizeTableColumns([spec], []);
  if (resolved === undefined) throw new Error("column did not resolve");
  return resolved;
};

describe("cell formatting", () => {
  it("formats numbers for the reader's language, with decimals and a unit", () => {
    const amount = column({ key: "amount", type: "number", format: { decimals: 2, unit: "₫" } });
    expect(tableCellFormatter(amount, "vi", LABELS)(1234.5)).toBe("1.234,50 ₫");
    expect(tableCellFormatter(amount, "en", LABELS)(1234.5)).toBe("1,234.50 ₫");
    // A number spelled as text is still a number; text that is not one is shown as it is.
    expect(tableCellFormatter(amount, "en", LABELS)("7")).toBe("7.00 ₫");
    expect(tableCellFormatter(amount, "en", LABELS)("n/a")).toBe("n/a");
    expect(tableCellFormatter(amount, "en", LABELS)(null)).toBe("");
  });

  it("formats a fraction as a percentage", () => {
    const share = column({ key: "share", type: "number", format: { style: "percent", decimals: 1 } });
    expect(tableCellFormatter(share, "en", LABELS)(0.125)).toBe("12.5%");
    // Vietnamese may put a (non-breaking) space before the sign; `\s` matches either kind.
    expect(tableCellFormatter(share, "vi", LABELS)(0.125).replace(/\s/g, "")).toBe("12,5%");
  });

  it("formats a calendar day without shifting it across time zones", () => {
    const day = column({ key: "day", type: "date" });
    expect(tableCellFormatter(day, "en", LABELS)("2026-09-03")).toBe("Sep 3, 2026");
    expect(tableCellFormatter(day, "vi", LABELS)("2026-09-03")).toContain("2026");
    expect(tableCellFormatter(day, "en", LABELS)("not a date")).toBe("not a date");
  });

  it("names booleans in the reader's language", () => {
    const ok = column({ key: "ok", type: "boolean" });
    expect(tableCellFormatter(ok, "vi", LABELS)(true)).toBe("Có");
    expect(tableCellFormatter(ok, "vi", LABELS)(false)).toBe("Không");
  });

  it("formats a total like its column, and a count as a whole number", () => {
    const amount = column({ key: "amount", type: "number", format: { decimals: 1 } });
    expect(formatTableTotal({ column: "amount", fn: "sum", value: 1234 }, amount, "vi", LABELS)).toBe("1.234,0");
    expect(formatTableTotal({ column: "amount", fn: "count", value: 1234 }, amount, "vi", LABELS)).toBe("1.234");
    expect(formatTableTotal({ column: "amount", fn: "avg", value: null }, amount, "en", LABELS)).toBe("–");
  });
});

describe("sorting from a header", () => {
  it("cycles ascending, descending, then back to the data's order", () => {
    const first = nextTableSort(null, "runs");
    expect(first).toEqual({ column: "runs", direction: "asc" });
    const second = nextTableSort(first, "runs");
    expect(second).toEqual({ column: "runs", direction: "desc" });
    expect(nextTableSort(second, "runs")).toBeNull();
    // Another column starts its own cycle.
    expect(nextTableSort(second, "week")).toEqual({ column: "week", direction: "asc" });
  });

  it("reports aria-sort for the sorted column only", () => {
    const sort = { column: "runs", direction: "desc" } as const;
    expect(tableAriaSort(sort, "runs")).toBe("descending");
    expect(tableAriaSort(sort, "week")).toBe("none");
    expect(tableAriaSort(null, "runs")).toBe("none");
  });
});

describe("selection", () => {
  it("replaces or clears a single selection", () => {
    expect(toggleTableSelection([], "a", "single")).toEqual(["a"]);
    expect(toggleTableSelection(["a"], "b", "single")).toEqual(["b"]);
    expect(toggleTableSelection(["a"], "a", "single")).toEqual([]);
    expect(toggleTableSelection(["a"], "b", "none")).toEqual([]);
  });

  it("adds and removes rows in multi-select, up to the limit", () => {
    expect(toggleTableSelection(["a"], "b", "multi")).toEqual(["a", "b"]);
    expect(toggleTableSelection(["a", "b"], "a", "multi")).toEqual(["b"]);
    const full = Array.from({ length: 64 }, (_, index) => String(index));
    expect(toggleTableSelection(full, "extra", "multi")).toHaveLength(64);
  });

  it("selects a whole page, and clears it when it already is", () => {
    expect(pageSelectionState(["a"], ["a", "b"])).toBe("some");
    expect(togglePageSelection(["x", "a"], ["a", "b"])).toEqual(["x", "a", "b"]);
    expect(pageSelectionState(["x", "a", "b"], ["a", "b"])).toBe("all");
    expect(togglePageSelection(["x", "a", "b"], ["a", "b"])).toEqual(["x"]);
    expect(pageSelectionState([], [])).toBe("none");
  });

  it("clears a page the full selection could only partly cover, so the header is never stuck", () => {
    // 60 rows already selected elsewhere; the page has ten, of which only four fit.
    const elsewhere = Array.from({ length: 60 }, (_, index) => `x${String(index)}`);
    const page = Array.from({ length: 10 }, (_, index) => `p${String(index)}`);
    const filled = togglePageSelection(elsewhere, page);
    expect(filled).toHaveLength(64);
    expect(tableSelectionFull(filled)).toBe(true);
    expect(pageSelectionState(filled, page)).toBe("some");
    // The second press takes the page's rows back out rather than doing nothing.
    const cleared = togglePageSelection(filled, page);
    expect(cleared).toEqual(elsewhere);
    expect(pageSelectionState(cleared, page)).toBe("none");
    // A partly selected page with room left still fills first.
    expect(togglePageSelection(["p0"], page)).toHaveLength(10);
    expect(tableSelectionFull(["p0"])).toBe(false);
  });
});

describe("view state", () => {
  it("reads only the view fields, clamped, and ignores host signals", () => {
    expect(
      readTableViewState({
        sort: { column: "runs", direction: "sideways" },
        page: 2.7,
        query: "abc",
        filters: { ok: true, bad: {} },
        selectedIds: ["a", 1, "a"],
        exportStatus: "pending",
      }),
    ).toEqual({ sort: { column: "runs", direction: "asc" }, page: 2, query: "abc", filters: { ok: true }, selectedIds: ["a"] });
    expect(readTableViewState(undefined)).toEqual({ sort: null, page: 1, query: "", filters: {}, selectedIds: [] });
    expect(readTableViewState({ sort: "runs", page: -3 })).toMatchObject({ sort: null, page: 1 });
  });
});

describe("the export request", () => {
  const rows = [{ week: "W1", runs: 3 }, { week: "W2", runs: 5 }];

  it("carries the view and the shown columns, never the rows", () => {
    const view = tableView(rows, { sort: { column: "runs", direction: "desc" }, query: "w", filters: { week: "W2" } });
    const request = tableExportRequest(view);
    expect(request).toEqual({
      sort: { column: "runs", direction: "desc" },
      query: "w",
      filters: { week: "W2" },
      columns: ["week", "runs"],
    });
    expect(JSON.stringify(request)).not.toContain("W1");
  });

  it("leaves out what the view does not constrain", () => {
    expect(tableExportRequest(tableView(rows, {}))).toEqual({ columns: ["week", "runs"] });
  });

  it("is rebuilt by the host from an event payload, dropping anything else it carries", () => {
    expect(
      tableExportRequestFrom({ sort: { column: "runs", direction: "asc" }, columns: ["runs", 3, ""], rows: [{ x: 1 }] }),
    ).toEqual({ sort: { column: "runs", direction: "asc" }, columns: ["runs"] });
    expect(tableExportRequestFrom({ query: "   " })).toEqual({});
  });
});

describe("pagination label", () => {
  it("reads like the spec in both languages, with locale-formatted counts", () => {
    const view = { page: 2, pageCount: 7, total: 1530 };
    expect(tablePageLabel("Trang {page}/{pageCount} · {total} dòng", view, "vi")).toBe("Trang 2/7 · 1.530 dòng");
    expect(tablePageLabel("Page {page} of {pageCount} · {total} rows", view, "en")).toBe("Page 2 of 7 · 1,530 rows");
  });
});

describe("exporting through the gateway client", () => {
  function clientFor(response: Response, recorded: { url?: string; init?: RequestInit | undefined }): GatewayClient {
    return new GatewayClient({
      baseUrl: "http://127.0.0.1:8765",
      token: "tok",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        recorded.url = String(url);
        recorded.init = init;
        return response;
      }) as unknown as typeof fetch,
    });
  }

  it("posts the view with the token and returns the file with the name the node gave it", async () => {
    const recorded: { url?: string; init?: RequestInit | undefined } = {};
    const client = clientFor(
      new Response("name\r\n", {
        status: 200,
        headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="doanh-thu.csv"' },
      }),
      recorded,
    );
    const result = await client.exportTable("conv_1", "winst_1", { query: "a", columns: ["name"] });
    expect(recorded.url).toBe("http://127.0.0.1:8765/conversations/conv_1/widgets/winst_1/export");
    expect(recorded.init?.method).toBe("POST");
    expect(recorded.init?.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(JSON.parse(String(recorded.init?.body))).toEqual({ query: "a", columns: ["name"] });
    expect(result.filename).toBe("doanh-thu.csv");
    expect(await result.blob.text()).toBe("name\r\n");
  });

  it("throws the node's own refusal", async () => {
    const client = clientFor(
      new Response(JSON.stringify({ code: "NOT_AUTHORIZED", message: "that instance belongs to another principal" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
      {},
    );
    const failure = await client.exportTable("conv_1", "winst_1", {}).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure).toMatchObject({ status: 403, code: "NOT_AUTHORIZED" });
  });

  it("reads a download name safely from either disposition form", () => {
    expect(attachmentFilename('attachment; filename="a.csv"')).toBe("a.csv");
    expect(attachmentFilename("attachment; filename*=UTF-8''doanh%20thu.csv")).toBe("doanh thu.csv");
    expect(attachmentFilename('attachment; filename="../../etc/passwd"')).toBe("....etcpasswd");
    expect(attachmentFilename('attachment; filename=".."')).toBeUndefined();
    expect(attachmentFilename(null)).toBeUndefined();
  });
});
