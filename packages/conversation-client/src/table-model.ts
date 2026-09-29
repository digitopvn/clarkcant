import {
  TABLE_LIMITS,
  normalizeTableFilters,
  normalizeTableQuery,
  normalizeTableSelectedIds,
  tableCellText,
  tableDateValue,
  tableNumericValue,
  type TableColumn,
  type TableFilterValue,
  type TableSelection,
  type TableSort,
  type TableTotal,
  type TableView,
} from "@clarkcant/contracts";

import type { TableExportRequest } from "./api.ts";
import type { LocaleChoice } from "./i18n/locale.ts";

/**
 * The table renderer's decisions, as pure functions.
 *
 * The client has no DOM test environment, so everything the table decides without drawing (how a
 * cell reads in each language, what a header click does to the sort, what a checkbox does to the
 * selection) is decided here and unit-tested; the drawing itself is covered by the browser journey.
 */

export interface TableBooleanLabels {
  yes: string;
  no: string;
}

/** A date with no time is a calendar day, not midnight UTC: it is formatted in UTC so it never shifts a day. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A formatter for one column's cells, in the reader's language. */
export function tableCellFormatter(
  column: TableColumn,
  locale: LocaleChoice,
  labels: TableBooleanLabels,
): (value: unknown) => string {
  if (column.type === "number") {
    const format = column.format;
    const options: Intl.NumberFormatOptions = {};
    if (format?.style === "percent") options.style = "percent";
    if (format?.decimals !== undefined) {
      options.minimumFractionDigits = format.decimals;
      options.maximumFractionDigits = format.decimals;
    }
    const numbers = new Intl.NumberFormat(locale, options);
    const unit = format?.unit;
    return (value) => {
      const number = tableNumericValue(value);
      if (number === undefined) return tableCellText(value);
      const text = numbers.format(number);
      return unit === undefined ? text : `${text} ${unit}`;
    };
  }
  if (column.type === "date" || column.type === "datetime") {
    const style: Intl.DateTimeFormatOptions =
      column.type === "date" ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" };
    const local = new Intl.DateTimeFormat(locale, style);
    const calendarDay = new Intl.DateTimeFormat(locale, { ...style, timeZone: "UTC" });
    return (value) => {
      const time = tableDateValue(value);
      if (time === undefined) return tableCellText(value);
      const formatter = typeof value === "string" && DATE_ONLY.test(value.trim()) ? calendarDay : local;
      return formatter.format(new Date(time));
    };
  }
  if (column.type === "boolean") {
    return (value) => (typeof value === "boolean" ? (value ? labels.yes : labels.no) : tableCellText(value));
  }
  return tableCellText;
}

/** A total, formatted like the column it sums; a count is always a plain whole number. */
export function formatTableTotal(
  total: TableTotal,
  column: TableColumn,
  locale: LocaleChoice,
  labels: TableBooleanLabels,
): string {
  if (total.value === null) return "–";
  if (total.fn === "count" || column.type !== "number") return new Intl.NumberFormat(locale).format(total.value);
  return tableCellFormatter(column, locale, labels)(total.value);
}

/** The `aria-sort` a column header carries. */
export function tableAriaSort(sort: TableSort | null, key: string): "ascending" | "descending" | "none" {
  if (sort === null || sort.column !== key) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

/** A header activation cycles that column ascending, descending, then back to the data's own order. */
export function nextTableSort(sort: TableSort | null, key: string): TableSort | null {
  if (sort === null || sort.column !== key) return { column: key, direction: "asc" };
  if (sort.direction === "asc") return { column: key, direction: "desc" };
  return null;
}

/**
 * The selection after a row is toggled.
 *
 * Single-select replaces the selection, or clears it when the selected row is toggled again;
 * multi-select adds or removes the row, up to the limit a semantic view can carry.
 */
export function toggleTableSelection(selected: readonly string[], id: string, selection: TableSelection): string[] {
  if (selection === "none") return [];
  const has = selected.includes(id);
  if (selection === "single") return has ? [] : [id];
  if (has) return selected.filter((candidate) => candidate !== id);
  return selected.length >= TABLE_LIMITS.maxSelectedIds ? [...selected] : [...selected, id];
}

/** Whether none, some or all of a page's rows are selected, for the header checkbox. */
export function pageSelectionState(selected: readonly string[], pageIds: readonly string[]): "none" | "some" | "all" {
  const count = pageIds.filter((id) => selected.includes(id)).length;
  if (count === 0) return "none";
  return count === pageIds.length ? "all" : "some";
}

/** Whether the selection holds as many rows as a table can, so no further row can be added to it. */
export function tableSelectionFull(selected: readonly string[]): boolean {
  return selected.length >= TABLE_LIMITS.maxSelectedIds;
}

/**
 * The header checkbox: selects every row on the page, or clears them when all already are.
 *
 * A page that is only partly selected because the selection is full clears instead, so the header always does
 * something: without that, a second press would add nothing and the checkbox would stay stuck half-checked.
 */
export function togglePageSelection(selected: readonly string[], pageIds: readonly string[]): string[] {
  const state = pageSelectionState(selected, pageIds);
  if (pageIds.length > 0 && (state === "all" || (state === "some" && tableSelectionFull(selected)))) {
    return selected.filter((id) => !pageIds.includes(id));
  }
  const next = [...selected];
  for (const id of pageIds) {
    if (tableSelectionFull(next)) break;
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

/** What a table remembers about how it is being looked at. */
export interface TableViewState {
  sort: TableSort | null;
  page: number;
  query: string;
  filters: Record<string, TableFilterValue>;
  selectedIds: string[];
}

/**
 * A table's view state, read from a host-supplied state object.
 *
 * The object may also carry host signals (an export in progress, for one); only the view fields
 * are read, each clamped, so a malformed state renders the data's own first page instead of failing.
 */
export function readTableViewState(state: Readonly<Record<string, unknown>> | undefined): TableViewState {
  const raw = state ?? {};
  const sortRaw = raw.sort;
  let sort: TableSort | null = null;
  if (typeof sortRaw === "object" && sortRaw !== null && !Array.isArray(sortRaw)) {
    const { column, direction } = sortRaw as Record<string, unknown>;
    if (typeof column === "string" && column !== "" && column.length <= TABLE_LIMITS.maxKeyLength) {
      sort = { column, direction: direction === "desc" ? "desc" : "asc" };
    }
  }
  const page = typeof raw.page === "number" && Number.isFinite(raw.page) ? Math.max(1, Math.floor(raw.page)) : 1;
  return {
    sort,
    page,
    query: normalizeTableQuery(raw.query),
    filters: normalizeTableFilters(raw.filters),
    selectedIds: normalizeTableSelectedIds(raw.selectedIds, "multi"),
  };
}

/** The `export.requested` payload for a view: the view only, never its rows. */
export function tableExportRequest(view: TableView): TableExportRequest {
  return {
    ...(view.sort === null ? {} : { sort: view.sort }),
    ...(view.query.trim() === "" ? {} : { query: view.query }),
    ...(Object.keys(view.filters).length === 0 ? {} : { filters: view.filters }),
    columns: view.columns.map((column) => column.key),
  };
}

/**
 * The export a table asked for, rebuilt from its event payload by the host that answers it.
 *
 * Only the view's shape is carried over; the node clamps every field again and reads the rows itself.
 */
export function tableExportRequestFrom(payload: Readonly<Record<string, unknown>>): TableExportRequest {
  const view = readTableViewState(payload);
  const columns = Array.isArray(payload.columns)
    ? payload.columns
        .filter((key): key is string => typeof key === "string" && key !== "" && key.length <= TABLE_LIMITS.maxKeyLength)
        .slice(0, TABLE_LIMITS.maxColumns)
    : [];
  return {
    ...(view.sort === null ? {} : { sort: view.sort }),
    ...(view.query.trim() === "" ? {} : { query: view.query }),
    ...(Object.keys(view.filters).length === 0 ? {} : { filters: view.filters }),
    ...(columns.length === 0 ? {} : { columns }),
  };
}

/** Fills a pagination template's `{page}`, `{pageCount}` and `{total}` with locale-formatted numbers. */
export function tablePageLabel(
  template: string,
  view: { page: number; pageCount: number; total: number },
  locale: LocaleChoice,
): string {
  const numbers = new Intl.NumberFormat(locale);
  return template
    .replace("{page}", numbers.format(view.page))
    .replace("{pageCount}", numbers.format(view.pageCount))
    .replace("{total}", numbers.format(view.total));
}
