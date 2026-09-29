/**
 * The `canvas.table@1` view model, shared by the renderer and the node.
 *
 * A table shows a page of a dataset, sorted, searched and filtered. The same pure functions
 * run in the browser, to draw the page, and on the node, to answer a CSV export, so what a
 * person downloads is exactly the rows they were looking at, in the same order, and the node
 * never has to trust a client-supplied list of rows.
 *
 * Every input is untrusted: props come from a model or a package, state comes from a client.
 * Each field is therefore accepted as `unknown` and clamped here, rather than trusting the
 * props validator, which checks only the top level of a props object.
 */

export type TableColumnType = "text" | "number" | "date" | "datetime" | "boolean";
export type TableAlign = "start" | "center" | "end";
export type TableSortDirection = "asc" | "desc";
export type TableTotalFn = "sum" | "avg" | "min" | "max" | "count";
export type TableSelection = "none" | "single" | "multi";
export type TableFilterValue = string | number | boolean | null;
export type TableRow = Readonly<Record<string, unknown>>;

export const TABLE_COLUMN_TYPES: readonly TableColumnType[] = ["text", "number", "date", "datetime", "boolean"];
export const TABLE_ALIGNS: readonly TableAlign[] = ["start", "center", "end"];
export const TABLE_TOTAL_FNS: readonly TableTotalFn[] = ["sum", "avg", "min", "max", "count"];
export const TABLE_SELECTIONS: readonly TableSelection[] = ["none", "single", "multi"];

export const TABLE_LIMITS = {
  minPageSize: 5,
  maxPageSize: 200,
  defaultPageSize: 25,
  maxColumns: 40,
  maxKeyLength: 200,
  maxLabelLength: 120,
  maxUnitLength: 16,
  maxDecimals: 6,
  maxQueryLength: 200,
  maxFilters: 20,
  maxFilterValueLength: 200,
  maxSelectedIds: 64,
  maxRowIdLength: 200,
  maxSummaryLength: 600,
} as const;

export interface TableColumnFormat {
  decimals?: number;
  unit?: string;
  style?: "percent";
}

/** A column after normalization: every field the renderer and the CSV writer need is present. */
export interface TableColumn {
  key: string;
  label: string;
  type: TableColumnType;
  align: TableAlign;
  format?: TableColumnFormat;
}

export interface TableSort {
  column: string;
  direction: TableSortDirection;
}

export interface TableTotalSpec {
  column: string;
  fn: TableTotalFn;
}

/** A computed total. `value` is null when the column held no number to aggregate. */
export interface TableTotal extends TableTotalSpec {
  value: number | null;
}

export interface TableViewRow {
  /** The row's id: its `rowIdField` value when that is usable, else its dataset position. */
  id: string;
  /** The row's position in the dataset. */
  index: number;
  row: TableRow;
}

/** Everything a table view depends on. Each field is untrusted and normalized. */
export interface TableViewInput {
  columns?: unknown;
  rowIdField?: unknown;
  sort?: unknown;
  query?: unknown;
  filters?: unknown;
  page?: unknown;
  pageSize?: unknown;
  totals?: unknown;
}

export interface TableView {
  columns: TableColumn[];
  /** Every matching row, in display order. The CSV export writes these. */
  rows: TableViewRow[];
  /** The rows on the current page; never more than `pageSize`. */
  pageRows: TableViewRow[];
  /** How many rows match the query and filters. */
  total: number;
  /** How many rows the dataset holds. */
  datasetTotal: number;
  page: number;
  pageCount: number;
  pageSize: number;
  sort: TableSort | null;
  query: string;
  filters: Record<string, TableFilterValue>;
  /** Totals over every matching row, not only the current page. */
  totals: TableTotal[];
  /** False when rows are identified by position, which changes when the data changes. */
  stableIds: boolean;
}

export interface TableSemanticState {
  summary: string;
  selectedIds: string[];
  sort: TableSort | null;
  query: string;
  page: number;
  stableIds: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

function isEmptyCell(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (typeof value === "number" && Number.isNaN(value));
}

/** A cell as a finite number, when it is one or is a string that spells one. */
export function tableNumericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A cell as epoch milliseconds, when it is a timestamp or a parseable date string. */
export function tableDateValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A cell as plain text, for search, filters and the CSV writer. */
export function tableCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Case- and accent-insensitive text, so "dong" finds "Đồng" in either language. */
export function foldTableText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

function asRow(value: unknown): TableRow {
  return isRecord(value) ? value : {};
}

function inferColumnType(rows: readonly TableRow[], key: string): TableColumnType {
  let sawNumber = false;
  let sawBoolean = false;
  for (const row of rows) {
    const value = row[key];
    if (isEmptyCell(value)) continue;
    if (typeof value === "number" && Number.isFinite(value)) sawNumber = true;
    else if (typeof value === "boolean") sawBoolean = true;
    else return "text";
    if (sawNumber && sawBoolean) return "text";
  }
  if (sawNumber) return "number";
  if (sawBoolean) return "boolean";
  return "text";
}

function normalizeFormat(value: unknown): TableColumnFormat | undefined {
  if (!isRecord(value)) return undefined;
  const format: TableColumnFormat = {};
  const { decimals, unit, style } = value;
  if (typeof decimals === "number" && Number.isFinite(decimals)) {
    format.decimals = Math.min(TABLE_LIMITS.maxDecimals, Math.max(0, Math.round(decimals)));
  }
  const boundedUnit = boundedString(unit, TABLE_LIMITS.maxUnitLength);
  if (boundedUnit !== undefined) format.unit = boundedUnit;
  if (style === "percent") format.style = "percent";
  return Object.keys(format).length === 0 ? undefined : format;
}

function column(
  rows: readonly TableRow[],
  key: string,
  spec: { label?: unknown; type?: unknown; format?: unknown; align?: unknown },
): TableColumn {
  const type = TABLE_COLUMN_TYPES.includes(spec.type as TableColumnType)
    ? (spec.type as TableColumnType)
    : inferColumnType(rows, key);
  const align = TABLE_ALIGNS.includes(spec.align as TableAlign)
    ? (spec.align as TableAlign)
    : type === "number"
      ? "end"
      : "start";
  const format = normalizeFormat(spec.format);
  return {
    key,
    label: boundedString(spec.label, TABLE_LIMITS.maxLabelLength) ?? key,
    type,
    align,
    ...(format === undefined ? {} : { format }),
  };
}

/**
 * The table's columns.
 *
 * When `columns` names any usable column, those are shown in that order and no others. When
 * it names none, the columns are the first row's fields, as before columns could be declared.
 */
export function normalizeTableColumns(input: unknown, rows: readonly unknown[]): TableColumn[] {
  const records = rows.map(asRow);
  const seen = new Set<string>();
  const declared: TableColumn[] = [];
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (declared.length >= TABLE_LIMITS.maxColumns) break;
      const spec = typeof entry === "string" ? { key: entry } : isRecord(entry) ? entry : undefined;
      const key = typeof spec?.key === "string" ? spec.key : undefined;
      if (spec === undefined || key === undefined || key === "" || key.length > TABLE_LIMITS.maxKeyLength) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      declared.push(column(records, key, spec));
    }
  }
  if (declared.length > 0) return declared;
  const first = records[0];
  if (first === undefined) return [];
  return Object.keys(first)
    .filter((key) => key !== "" && key.length <= TABLE_LIMITS.maxKeyLength)
    .slice(0, TABLE_LIMITS.maxColumns)
    .map((key) => column(records, key, {}));
}

export function normalizeTablePageSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return TABLE_LIMITS.defaultPageSize;
  return Math.min(TABLE_LIMITS.maxPageSize, Math.max(TABLE_LIMITS.minPageSize, Math.round(value)));
}

export function normalizeTableSelection(value: unknown): TableSelection {
  return TABLE_SELECTIONS.includes(value as TableSelection) ? (value as TableSelection) : "single";
}

/** A sort is kept only when it names a column the table shows. */
export function normalizeTableSort(value: unknown, columns: readonly TableColumn[]): TableSort | null {
  if (!isRecord(value)) return null;
  const { column: key, direction } = value;
  if (typeof key !== "string" || !columns.some((candidate) => candidate.key === key)) return null;
  return { column: key, direction: direction === "desc" ? "desc" : "asc" };
}

export function normalizeTableQuery(value: unknown): string {
  return typeof value === "string" ? value.slice(0, TABLE_LIMITS.maxQueryLength) : "";
}

/**
 * Exact-match filters, keyed by field. A field need not be a shown column, so a state graph
 * can filter on a field the table does not display; values are primitives only.
 */
export function normalizeTableFilters(value: unknown): Record<string, TableFilterValue> {
  const filters: Record<string, TableFilterValue> = {};
  if (!isRecord(value)) return filters;
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= TABLE_LIMITS.maxFilters) break;
    if (key === "" || key.length > TABLE_LIMITS.maxKeyLength) continue;
    let filter: TableFilterValue | undefined;
    if (raw === null || typeof raw === "boolean") filter = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) filter = raw;
    else if (typeof raw === "string" && raw.length <= TABLE_LIMITS.maxFilterValueLength) filter = raw;
    if (filter === undefined) continue;
    Object.defineProperty(filters, key, { value: filter, enumerable: true, writable: true, configurable: true });
    count += 1;
  }
  return filters;
}

/** Totals are kept only for shown columns, once per column and function. */
export function normalizeTableTotals(value: unknown, columns: readonly TableColumn[]): TableTotalSpec[] {
  if (!Array.isArray(value)) return [];
  const specs: TableTotalSpec[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (specs.length >= TABLE_LIMITS.maxColumns) break;
    if (!isRecord(entry)) continue;
    const { column: key, fn } = entry;
    if (typeof key !== "string" || !columns.some((candidate) => candidate.key === key)) continue;
    if (!TABLE_TOTAL_FNS.includes(fn as TableTotalFn)) continue;
    const signature = `${key}\u0000${String(fn)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    specs.push({ column: key, fn: fn as TableTotalFn });
  }
  return specs;
}

/** Selected row ids: strings, de-duplicated, bounded, and none or one unless multi-select. */
export function normalizeTableSelectedIds(value: unknown, selection: TableSelection = "multi"): string[] {
  if (selection === "none" || !Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "" || entry.length > TABLE_LIMITS.maxRowIdLength) continue;
    if (ids.includes(entry)) continue;
    ids.push(entry);
    if (ids.length >= (selection === "single" ? 1 : TABLE_LIMITS.maxSelectedIds)) break;
  }
  return ids;
}

function rowIdCandidate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value !== "" && value.length <= TABLE_LIMITS.maxRowIdLength) return value;
  return undefined;
}

/**
 * Each row's id.
 *
 * The id field is `rowIdField`, or `id` when no field is named. It is used only when every
 * row has a distinct string or number there; otherwise the dataset position stands in, and
 * `stable` says so, because a position names a different row once the data changes.
 */
export function resolveTableRowIds(rows: readonly unknown[], rowIdField?: unknown): { ids: string[]; stable: boolean } {
  const field = typeof rowIdField === "string" && rowIdField !== "" ? rowIdField : "id";
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const candidate = rowIdCandidate(asRow(row)[field]);
    if (candidate === undefined || seen.has(candidate)) {
      return { ids: rows.map((_, index) => String(index)), stable: false };
    }
    seen.add(candidate);
    ids.push(candidate);
  }
  return { ids, stable: true };
}

// One collator for the browser and the node, so both sort text the same way.
const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

interface SortKey {
  /** 0 a number, 1 text, 2 empty. */
  kind: 0 | 1 | 2;
  number: number;
  text: string;
}

function sortKey(value: unknown, type: TableColumnType): SortKey {
  if (isEmptyCell(value)) return { kind: 2, number: 0, text: "" };
  let number: number | undefined;
  if (type === "number") number = tableNumericValue(value);
  else if (type === "date" || type === "datetime") number = tableDateValue(value);
  else if (type === "boolean" && typeof value === "boolean") number = value ? 1 : 0;
  if (number !== undefined) return { kind: 0, number, text: "" };
  return { kind: 1, number: 0, text: tableCellText(value) };
}

function compareKeys(left: SortKey, right: SortKey): number {
  if (left.kind !== right.kind) return left.kind - right.kind;
  if (left.kind === 0) return left.number - right.number;
  if (left.kind === 1) return COLLATOR.compare(left.text, right.text);
  return 0;
}

function matchesFilters(row: TableRow, filters: Record<string, TableFilterValue>): boolean {
  for (const [key, expected] of Object.entries(filters)) {
    const actual = Object.hasOwn(row, key) ? row[key] : undefined;
    if (expected === null) {
      if (!isEmptyCell(actual)) return false;
    } else if (tableCellText(actual) !== String(expected)) {
      return false;
    }
  }
  return true;
}

function computeTotal(spec: TableTotalSpec, rows: readonly TableViewRow[]): TableTotal {
  if (spec.fn === "count") {
    return { ...spec, value: rows.filter((entry) => !isEmptyCell(entry.row[spec.column])).length };
  }
  const numbers: number[] = [];
  for (const entry of rows) {
    const value = tableNumericValue(entry.row[spec.column]);
    if (value !== undefined) numbers.push(value);
  }
  if (numbers.length === 0) return { ...spec, value: null };
  // Reduced rather than spread into Math.min/max, which overflows the stack on a large dataset.
  let value: number;
  if (spec.fn === "sum") value = numbers.reduce((sum, next) => sum + next, 0);
  else if (spec.fn === "avg") value = numbers.reduce((sum, next) => sum + next, 0) / numbers.length;
  else if (spec.fn === "min") value = numbers.reduce((least, next) => Math.min(least, next));
  else value = numbers.reduce((most, next) => Math.max(most, next));
  return { ...spec, value };
}

/**
 * The rows a table shows: filtered, searched, sorted, paged, with totals.
 *
 * Search matches every whitespace-separated term against the shown columns, ignoring case
 * and accents. Sorting is stable, and empty cells sort last in either direction. The page is
 * 1-based and clamped to the pages that exist.
 */
export function tableView(dataset: readonly unknown[], input: TableViewInput = {}): TableView {
  const records = dataset.map(asRow);
  const columns = normalizeTableColumns(input.columns, records);
  const { ids, stable } = resolveTableRowIds(records, input.rowIdField);
  const sort = normalizeTableSort(input.sort, columns);
  const query = normalizeTableQuery(input.query);
  const filters = normalizeTableFilters(input.filters);
  const pageSize = normalizeTablePageSize(input.pageSize);
  const terms = foldTableText(query).split(/\s+/).filter((term) => term !== "");

  let rows: TableViewRow[] = records.map((row, index) => ({ id: ids[index] ?? String(index), index, row }));
  if (Object.keys(filters).length > 0) rows = rows.filter((entry) => matchesFilters(entry.row, filters));
  if (terms.length > 0) {
    rows = rows.filter((entry) => {
      const haystack = columns.map((candidate) => foldTableText(tableCellText(entry.row[candidate.key]))).join("\u0000");
      return terms.every((term) => haystack.includes(term));
    });
  }
  if (sort !== null) {
    const type = columns.find((candidate) => candidate.key === sort.column)?.type ?? "text";
    const sign = sort.direction === "desc" ? -1 : 1;
    const keyed = rows.map((entry) => ({ entry, key: sortKey(entry.row[sort.column], type) }));
    keyed.sort((left, right) => {
      if (left.key.kind === 2 || right.key.kind === 2) {
        const empties = compareKeys(left.key, right.key);
        if (empties !== 0) return empties;
      } else {
        const compared = sign * compareKeys(left.key, right.key);
        if (compared !== 0) return compared;
      }
      return left.entry.index - right.entry.index;
    });
    rows = keyed.map(({ entry }) => entry);
  }

  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const requested = typeof input.page === "number" && Number.isFinite(input.page) ? Math.floor(input.page) : 1;
  const page = Math.min(pageCount, Math.max(1, requested));
  const start = (page - 1) * pageSize;
  return {
    columns,
    rows,
    pageRows: rows.slice(start, start + pageSize),
    total,
    datasetTotal: records.length,
    page,
    pageCount,
    pageSize,
    sort,
    query,
    filters,
    totals: normalizeTableTotals(input.totals, columns).map((spec) => computeTotal(spec, rows)),
    stableIds: stable,
  };
}

/**
 * What the table shows, in words, for an assistant reading the conversation.
 *
 * The summary is English and bounded; it names the counts, the sort, the search, the page
 * and the selection, and says when row ids are positions rather than stable ids.
 */
export function tableSemanticState(
  view: TableView,
  input: { title?: unknown; selectedIds?: unknown; selection?: unknown } = {},
): TableSemanticState {
  const selectedIds = normalizeTableSelectedIds(input.selectedIds, normalizeTableSelection(input.selection));
  const title = boundedString(input.title, TABLE_LIMITS.maxLabelLength);
  const parts: string[] = [];
  const matched = view.total === view.datasetTotal ? `${view.total} rows` : `${view.total} of ${view.datasetTotal} rows`;
  parts.push(`${title === undefined ? "Table" : `Table "${title}"`}: ${matched}`);
  if (view.columns.length > 0) parts.push(`columns ${view.columns.map((candidate) => candidate.label).join(", ")}`);
  if (view.query.trim() !== "") parts.push(`search "${view.query.trim()}"`);
  const filterText = Object.entries(view.filters).map(([key, value]) => `${key}=${value === null ? "empty" : String(value)}`);
  if (filterText.length > 0) parts.push(`filtered by ${filterText.join(", ")}`);
  if (view.sort !== null) {
    const label = view.columns.find((candidate) => candidate.key === view.sort?.column)?.label ?? view.sort.column;
    parts.push(`sorted by ${label} ${view.sort.direction === "desc" ? "descending" : "ascending"}`);
  }
  if (view.total > 0) {
    const first = (view.page - 1) * view.pageSize + 1;
    const last = first + view.pageRows.length - 1;
    parts.push(`page ${view.page} of ${view.pageCount} showing rows ${first}-${last}`);
  }
  if (selectedIds.length > 0) parts.push(`${selectedIds.length} selected`);
  if (!view.stableIds) parts.push("row ids are positions and change when the data changes");
  const summary = `${parts.join("; ")}.`;
  return {
    summary: summary.length > TABLE_LIMITS.maxSummaryLength ? `${summary.slice(0, TABLE_LIMITS.maxSummaryLength - 1)}…` : summary,
    selectedIds,
    sort: view.sort,
    query: view.query,
    page: view.page,
    stableIds: view.stableIds,
  };
}

// A spreadsheet runs a cell that starts with one of these as a formula.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvText(value: unknown): string {
  // A finite number is written as itself, so -5 stays a number a spreadsheet can add up;
  // it cannot carry a formula.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = tableCellText(value);
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

/**
 * A CSV document: a header of column labels, then one line per row.
 *
 * Fields are quoted per RFC 4180 and lines end in CRLF. Any text cell, header included, that
 * a spreadsheet would run as a formula is prefixed with `'`. Totals are not written; they are
 * a view of the rows, and a spreadsheet recomputes them.
 */
export function toCsv(columns: readonly TableColumn[], rows: readonly TableRow[]): string {
  const lines = [columns.map((candidate) => csvField(csvText(candidate.label))).join(",")];
  for (const row of rows) {
    lines.push(columns.map((candidate) => csvField(csvText(row[candidate.key]))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
