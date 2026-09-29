import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  checkField,
  checkFieldValue,
  checkFields,
  checkListItems,
  codeLanguage,
  codeLineRange,
  diffCounts,
  diffFileCounts,
  type DiffLineKind,
  donutSlices,
  type HiddenCharacter,
  type HiddenCharacterKind,
  hiddenCharacterCount,
  hiddenCharacterMarker,
  hiddenCharacterSegments,
  hunkHeader,
  numberedHunkLines,
  readArtifactViewer,
  emptyValueOf,
  fieldFromProps,
  type FormField,
  isEmptyValue,
  LIST_PAGE_SIZES,
  listPage,
  monthGrid,
  normalizeTableSelectedIds,
  normalizeTableSelection,
  parseFields,
  parseListItems,
  progressPercent,
  readStatusCard,
  type StatusTone,
  type StepStatus,
  stepCounts,
  tableView,
  type TableTotalFn,
  XY_CHART_KIND,
  XY_CHART_VIEW_OPERATION,
  type XyChart,
  type XyChartData,
  type XyChartView as XyChartViewState,
  readXyChart,
  readXyChartView,
  xyChartData,
  xyChartDataProblems,
  xyChartProblems,
  xyFieldLabel,
} from "@clarkcant/contracts";

import type { ResolvedDataset } from "./api.ts";
import { formatFileSize } from "./attachments.ts";
import {
  CHART_HEIGHT,
  CHART_PAD,
  type ChartGeometry,
  chartGeometry,
  type ChartPoint,
  chartPoints,
  formatTicks,
  labelStride,
  linearScale,
  markerPath,
  markerShape,
  movePointCursor,
  niceRange,
  niceSpan,
  type PointCursor,
  pointOrder,
  seriesDash,
  stackBands,
  valueLabelShown,
} from "./chart-layout.ts";
import { highlightedCode } from "./markdown.tsx";
import { vendorEmbedUrl } from "./media-embed.ts";
import { useLocale, useT } from "./i18n/locale-context.tsx";
import {
  formatTableTotal,
  nextTableSort,
  pageSelectionState,
  readTableViewState,
  tableAriaSort,
  tableCellFormatter,
  tableExportRequest,
  tablePageLabel,
  tableSelectionFull,
  type TableViewState,
  togglePageSelection,
  toggleTableSelection,
} from "./table-model.ts";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * Built-in catalog renderers.
 *
 * These are the trusted half of the widget story: components shipped with the client that
 * draw from JSON props, so a rich answer is a document rather than a bespoke app. Custom
 * mini-apps come through the isolated host instead, and never share this origin.
 *
 * Two rules are applied consistently here, and both are release gates rather than polish:
 *
 *   - **Data freshness is displayed, never assumed.** A widget whose dataset is cached or
 *     sampled says so in its own chrome, because a cached agenda that looks live is the
 *     specific misleading case the blueprint names.
 *   - **Every renderer has a text path.** An unavailable dataset or an unusable spec
 *     degrades to a readable summary instead of an empty box, so chat stays usable.
 */

/**
 * What a renderer needs, which is narrower than the wire shape: the transport also carries
 * the id and row count, and a component has no use for either.
 */
export interface RendererDataset {
  rows: Record<string, unknown>[];
  freshness: "live" | "cached" | "sample" | "unknown";
  updatedAt: string;
}

/** Adapt the transport shape to the component shape in one place. */
export function toRendererDataset(resolved: ResolvedDataset): RendererDataset {
  return {
    rows: resolved.document?.rows ?? [],
    freshness: resolved.freshness,
    updatedAt: resolved.updatedAt,
  };
}

export interface RendererProps {
  definitionId: string;
  props: Record<string, unknown>;
  /** Resolved by the host from an opaque reference; `undefined` means unavailable. */
  dataset?: RendererDataset | undefined;
  state?: Record<string, unknown> | undefined;
  /** Reports the revision the user saw, so a stale action is refused server-side. */
  onAction?: ((action: string, payload: Record<string, unknown>) => void) | undefined;
  onStateChange?: ((patch: Record<string, unknown>) => void) | undefined;
  /**
   * Resolves an imported image to a fetchable URL, or `undefined` while it is not available.
   *
   * Injected rather than built here, because the bytes are behind the gateway's bearer token and a
   * component must not know how a node is addressed.
   */
  imageUrl?: ((imageRef: string) => string | undefined) | undefined;
  /**
   * Whether the host answers `export.requested` with a file.
   *
   * A live conversation instance does; a composed section and a preview do not, and a table then
   * shows its export disabled with the reason instead of a button that silently does nothing.
   */
  canExport?: boolean | undefined;
  /**
   * When the message that placed the widget was kept: the snapshot's capture time.
   *
   * A card that shows only what the model wrote says when it was written, so a number on it is not read as a live one.
   * Absent where there is no such message (a preview in the library).
   */
  statedAt?: string | undefined;
  /**
   * The props are a fixture shown in the widget library, not anything Clark said.
   *
   * A card that would say "As Clark stated" in a conversation says "Sample" instead, so a preview never claims words
   * nobody wrote.
   */
  sample?: boolean | undefined;
}

export type CatalogRenderer = (props: RendererProps) => ReactElement | null;

/* ------------------------------------------------------------------ *
 * Shared chrome
 * ------------------------------------------------------------------ */

/**
 * How loudly each freshness speaks.
 *
 * Sample and cached data carry the warning tone because they are the two cases a reader could mistake for
 * live: a label in the same muted grey as the title bar is a label nobody reads.
 */
const FRESHNESS_TONE: Record<RendererDataset["freshness"], "ok" | "warn" | undefined> = {
  live: "ok",
  cached: "warn",
  sample: "warn",
  unknown: undefined,
};

const FRESHNESS_LABEL_KEY: Record<RendererDataset["freshness"], MessageKey> = {
  live: "widgets.freshness.live",
  cached: "widgets.freshness.cached",
  sample: "widgets.freshness.sample",
  unknown: "widgets.freshness.unknown",
};

/**
 * Freshness badge.
 *
 * Rendered as `data-freshness` so the E2E test can assert that a sample is actually
 * labelled in the browser, rather than trusting that the attribute was passed through.
 */
function Freshness({ dataset }: { dataset: RendererDataset | undefined }): ReactElement | null {
  const t = useT();
  if (!dataset) return null;
  return (
    <span className="cc-freshness cc-badge" data-freshness={dataset.freshness} data-tone={FRESHNESS_TONE[dataset.freshness]}>
      {t(FRESHNESS_LABEL_KEY[dataset.freshness])}
    </span>
  );
}

function Frame({
  title,
  dataset,
  children,
  role,
}: {
  title: string;
  dataset: RendererDataset | undefined;
  children: ReactNode;
  role: string;
}): ReactElement {
  return (
    <figure className="cc-card" data-widget-role={role} style={{ margin: 0 }}>
      <figcaption className="cc-card-head">
        <span className="cc-card-title">{title}</span>
        <Freshness dataset={dataset} />
      </figcaption>
      <div className="cc-card-body">{children}</div>
    </figure>
  );
}

function Unavailable({ reason }: { reason: string }): ReactElement {
  // Not an error state: a missing dataset is normal and the message says what to do.
  return (
    <p className="cc-freshness" data-widget-unavailable="true" style={{ margin: 0 }}>
      {reason}
    </p>
  );
}

function label(row: Record<string, unknown>, preferred: string[]): string {
  for (const key of preferred) {
    const value = row[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  const first = Object.values(row)[0];
  return first === undefined ? "" : String(first);
}

/* ------------------------------------------------------------------ *
 * Charts
 * ------------------------------------------------------------------ */

/**
 * The width a chart is actually drawn at.
 *
 * The SVG's coordinate system is its measured width, so a label set at 11 is 11 CSS pixels at every size. A
 * fixed 640-unit view box scaled into a 300-pixel card drew its axis labels at five pixels, which is decoration
 * rather than text. The first frame uses the fallback; the observer corrects it before anyone can read it.
 */
function useMeasuredWidth(fallback: number): [(element: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = undefined;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const next = new ResizeObserver((entries) => {
      const measured = Math.round(entries[0]?.contentRect.width ?? 0);
      if (measured > 0) setWidth(measured);
    });
    next.observe(element);
    observer.current = next;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

function ChartGrid({ geometry }: { geometry: ChartGeometry }): ReactElement {
  const labels = formatTicks(geometry.ticks);
  return (
    <g aria-hidden="true">
      {geometry.ticks.map((tick, index) => (
        <g key={tick}>
          <line className="grid" x1={CHART_PAD.left} x2={geometry.width - CHART_PAD.right} y1={geometry.scaleY(tick)} y2={geometry.scaleY(tick)} />
          <text className="label" x={CHART_PAD.left - 6} y={geometry.scaleY(tick)} textAnchor="end" dominantBaseline="middle">
            {labels[index]}
          </text>
        </g>
      ))}
      <line className="axis" x1={CHART_PAD.left} y1={geometry.zero} x2={geometry.width - CHART_PAD.right} y2={geometry.zero} />
    </g>
  );
}

function chartSummary(points: ChartPoint[]): string {
  return points.map((point) => `${point.label}: ${point.value}`).join(", ");
}

const CATEGORY_KEYS = ["week", "name", "label"];

/**
 * The series a surface's state chose for a chart, when it chose one: an exact-match filter on `series`. Only a numeric
 * column of the rows can be plotted, so a name that is not one is reported as missing rather than drawn as zeros.
 */
function chosenSeries(
  state: Record<string, unknown> | undefined,
  rows: readonly Record<string, unknown>[],
): { requested?: string; series?: string; label?: string } {
  const filters = state?.filters;
  const requested = typeof filters === "object" && filters !== null ? (filters as Record<string, unknown>).series : undefined;
  if (typeof requested !== "string" || requested === "") return {};
  // The words the person picked it by, when a choice on the surface set it; otherwise the series is named as it is.
  const labels = state?.filterLabels;
  const named = typeof labels === "object" && labels !== null ? (labels as Record<string, unknown>).series : undefined;
  const label = typeof named === "string" && named !== "" ? named : requested;
  return rows.some((row) => typeof row[requested] === "number") ? { requested, series: requested, label } : { requested, label };
}

/** Says which series a chart is showing when the surface chose it, and says so plainly when the choice is not there. */
function SeriesNote({ choice }: { choice: { requested?: string; series?: string; label?: string } }): ReactElement | null {
  const t = useT();
  if (choice.requested === undefined) return null;
  const named = choice.label ?? choice.requested;
  return (
    <p className="cc-freshness" data-chart-series={choice.series ?? ""} style={{ margin: 0 }}>
      {choice.series === undefined
        ? t("widgets.chart.seriesMissing").replace("{series}", named)
        : t("widgets.chart.showingSeries").replace("{series}", named)}
    </p>
  );
}

function LineChart({ props, dataset, state }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.lineChart.title"));
  const [measure, width] = useMeasuredWidth(640);
  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.lineChart.noData")} />
      </Frame>
    );
  }

  const choice = chosenSeries(state, dataset.rows);
  const seriesKey = choice.series ?? (typeof props.series === "object" && Array.isArray(props.series) && props.series.length > 0
    ? String((props.series as unknown[])[0])
    : typeof props.unit === "string" && props.unit.includes("lần")
      ? "runs"
      : Object.keys(dataset.rows[0] ?? {}).find((key) => typeof dataset.rows[0]?.[key] === "number") ?? "value");

  const points = chartPoints(dataset.rows, seriesKey, (row) => label(row, CATEGORY_KEYS));
  const values = points.map((point) => point.value);
  const geometry = chartGeometry(width, values);
  // Inset from both edges, so the first value label clears the value axis and the last one the card edge.
  const inset = Math.min(18, geometry.plotWidth / 4);
  const step = values.length > 1 ? (geometry.plotWidth - inset * 2) / (values.length - 1) : 0;
  const x = (index: number): number => CHART_PAD.left + (values.length > 1 ? inset + index * step : geometry.plotWidth / 2);
  const stride = labelStride(values.length, geometry.plotWidth);
  const line = values.map((value, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${geometry.scaleY(value)}`).join(" ");
  const area = values.length > 1 ? `${line} L ${x(values.length - 1)} ${geometry.zero} L ${x(0)} ${geometry.zero} Z` : "";

  return (
    <Frame title={title} dataset={dataset} role="chart">
      <>
        <SeriesNote choice={choice} />
        <div ref={measure} className="cc-chart-box">
          <svg className="cc-chart" viewBox={`0 0 ${width} ${CHART_HEIGHT}`} role="img" aria-label={`${title}: ${choice.series === undefined ? seriesKey : (choice.label ?? seriesKey)}`}>
            <ChartGrid geometry={geometry} />
            {area !== "" && <path className="area" d={area} />}
            <path className="series" d={line} />
            {points.map(({ label: rowLabel, value }, index) => {
              const shown = valueLabelShown(index, points.length, stride);
              return (
                <g key={index} className="datum">
                  <circle className="point" cx={x(index)} cy={geometry.scaleY(value)} r={3.5}>
                    <title>{`${rowLabel}: ${value}`}</title>
                  </circle>
                  {shown && (
                    <text className="value" x={x(index)} y={geometry.scaleY(value) - 9} textAnchor="middle">
                      {value}
                    </text>
                  )}
                  {index % stride === 0 && (
                    <text className="label" x={x(index)} y={CHART_HEIGHT - 6} textAnchor="middle">
                      {rowLabel}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
        {/* The text alternative stays in the DOM for screen readers and for the E2E check. */}
        <span className="cc-sr-only" data-chart-summary="true">
          {chartSummary(points)}
        </span>
        <TextAlternative rows={dataset.rows} />
      </>
    </Frame>
  );
}

function BarChart({ props, dataset, state }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.barChart.title"));
  const [measure, width] = useMeasuredWidth(640);
  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.barChart.noData")} />
      </Frame>
    );
  }

  const choice = chosenSeries(state, dataset.rows);
  const seriesKey =
    choice.series ?? Object.keys(dataset.rows[0] ?? {}).find((key) => typeof dataset.rows[0]?.[key] === "number") ?? "value";
  const points = chartPoints(dataset.rows, seriesKey, (row) => label(row, CATEGORY_KEYS));
  const values = points.map((point) => point.value);
  const geometry = chartGeometry(width, values);
  const slot = geometry.plotWidth / Math.max(values.length, 1);
  const barWidth = Math.min(Math.max(slot * 0.6, 6), 56);
  const stride = labelStride(values.length, geometry.plotWidth);
  const zero = geometry.zero;

  return (
    <Frame title={title} dataset={dataset} role="chart">
      <>
        <SeriesNote choice={choice} />
        <div ref={measure} className="cc-chart-box">
          <svg className="cc-chart" viewBox={`0 0 ${width} ${CHART_HEIGHT}`} role="img" aria-label={`${title}: ${choice.series === undefined ? seriesKey : (choice.label ?? seriesKey)}`}>
            <ChartGrid geometry={geometry} />
            {points.map(({ label: rowLabel, value }, index) => {
              const y = geometry.scaleY(value);
              const center = CHART_PAD.left + index * slot + slot / 2;
              return (
                <g key={index} className="datum">
                  <rect
                    className="bar"
                    x={center - barWidth / 2}
                    y={Math.min(y, zero)}
                    width={barWidth}
                    height={Math.abs(zero - y)}
                    rx={3}
                  >
                    <title>{`${rowLabel}: ${value}`}</title>
                  </rect>
                  {index % stride === 0 && (
                    <text className="value" x={center} y={Math.min(y, zero) - 6} textAnchor="middle">
                      {value}
                    </text>
                  )}
                  {index % stride === 0 && (
                    <text className="label" x={center} y={CHART_HEIGHT - 6} textAnchor="middle">
                      {rowLabel}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
        <span className="cc-sr-only" data-chart-summary="true">
          {chartSummary(points)}
        </span>
        <TextAlternative rows={dataset.rows} />
      </>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Table
 * ------------------------------------------------------------------ */

const NO_ROWS: Record<string, unknown>[] = [];

const TOTAL_LABEL_KEY: Record<TableTotalFn, MessageKey> = {
  sum: "widgets.table.total.sum",
  avg: "widgets.table.total.avg",
  min: "widgets.table.total.min",
  max: "widgets.table.total.max",
  count: "widgets.table.total.count",
};

const SORT_ICON = { ascending: "▲", descending: "▼", none: "↕" } as const;

/**
 * A table over a dataset: sortable, searchable, paged, selectable, with totals and a CSV export.
 *
 * The view (sort, search, filters, page) comes from `tableView`, the same function the node runs
 * for an export, so the file holds exactly the rows on screen in the same order. Only one page of
 * rows is ever in the DOM, whatever the dataset's size.
 *
 * The view is held here, so a table works in a preview with no host at all; a host that passes
 * `state` and `onStateChange` also remembers it, and a view it sets from outside is adopted. Events
 * carry ids and view parameters only: `row.select` sends row ids, never row contents, and
 * `export.requested` asks the host for a file rather than building one in the page.
 */
function DataTable({ props, dataset, state, onAction, onStateChange, canExport }: RendererProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const title = typeof props.title === "string" && props.title.trim() !== "" ? props.title : t("widgets.table.title");
  const rows = dataset?.rows ?? NO_ROWS;
  const selection = normalizeTableSelection(props.selection);
  const searchable = props.searchable === true;
  const yes = t("widgets.table.yes");
  const no = t("widgets.table.no");
  const exportReasonId = useId();

  const externalKey = JSON.stringify(readTableViewState(state));
  const [view, setView] = useState<TableViewState>(() => readTableViewState(state));
  const adoptedKey = useRef(externalKey);
  useEffect(() => {
    if (adoptedKey.current === externalKey) return;
    adoptedKey.current = externalKey;
    setView(JSON.parse(externalKey) as TableViewState);
  }, [externalKey]);

  // Typing stays immediate in the box; the view over every row follows when the browser has time, so a large dataset
  // never makes a keystroke wait for a full search.
  const deferredQuery = useDeferredValue(view.query);
  const computed = useMemo(
    () =>
      tableView(rows, {
        columns: props.columns,
        rowIdField: props.rowIdField,
        pageSize: props.pageSize,
        totals: props.totals,
        sort: view.sort,
        query: deferredQuery,
        filters: view.filters,
        page: view.page,
      }),
    [rows, props.columns, props.rowIdField, props.pageSize, props.totals, view.sort, deferredQuery, view.filters, view.page],
  );
  const formatters = useMemo(
    () => new Map(computed.columns.map((column) => [column.key, tableCellFormatter(column, locale, { yes, no })])),
    [computed.columns, locale, yes, no],
  );

  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="table">
        <Unavailable reason={t("widgets.table.noData")} />
      </Frame>
    );
  }

  const selectedIds = normalizeTableSelectedIds(view.selectedIds, selection);
  const multi = selection === "multi";
  const single = selection === "single";
  const pageIds = computed.pageRows.map((entry) => entry.id);
  const pageState = pageSelectionState(selectedIds, pageIds);
  const firstRowNumber = (computed.page - 1) * computed.pageSize + 1;
  const columnCount = computed.columns.length + (multi ? 1 : 0);
  const format = (key: string, value: unknown): string => formatters.get(key)?.(value) ?? "";
  // The column that names a row stays at the start edge while the rest scroll, so a phone never shows figures without
  // saying whose they are.
  const stickyClass = (index: number): string | undefined => (index === 0 ? "cc-table-sticky" : undefined);
  const matchingIds = new Set(computed.rows.map((entry) => entry.id));
  const hiddenSelected = selectedIds.filter((id) => !matchingIds.has(id)).length;
  const count = (value: number): string => new Intl.NumberFormat(locale).format(value);
  const full = multi && tableSelectionFull(selectedIds);
  const selectionStatus =
    selectedIds.length === 0 || (single && hiddenSelected === 0)
      ? ""
      : full
        ? t("widgets.table.selectionFull").replace("{max}", count(selectedIds.length))
        : hiddenSelected > 0
        ? t("widgets.table.selectedHidden").replace("{count}", count(selectedIds.length)).replace("{hidden}", count(hiddenSelected))
        : t("widgets.table.selectedCount").replace("{count}", count(selectedIds.length));

  const update = (patch: Partial<TableViewState>): void => {
    setView((current) => ({ ...current, ...patch }));
    onStateChange?.({ ...patch });
  };
  // Selection is view state: it commits nothing and calls no model; the event names rows by id only.
  const select = (next: string[]): void => {
    update({ selectedIds: next });
    onAction?.("row.select", { rowIds: next });
  };

  const exportStatus = state?.exportStatus;
  const exporting = exportStatus === "pending";
  // A refusal the node will give again (the dataset is gone, the instance is not a table) is a reason the button
  // cannot be used, not a failure to retry.
  const exportReason =
    onAction === undefined
      ? t("widgets.table.exportViewOnly")
      : canExport !== true
        ? t("widgets.table.exportUnavailable")
        : exportStatus === "unavailable"
          ? t("widgets.table.exportGone")
          : undefined;

  return (
    <Frame title={title} dataset={dataset} role="table">
      <>
        <div className="cc-table-toolbar">
          {searchable && (
            <label className="cc-table-search">
              <span className="cc-sr-only">{t("widgets.table.searchLabel")}</span>
              <input
                type="search"
                data-table-search="true"
                value={view.query}
                maxLength={200}
                placeholder={t("widgets.table.searchPlaceholder")}
                onChange={(event) => update({ query: event.currentTarget.value, page: 1 })}
              />
            </label>
          )}
          {/* The live region stays mounted while rows can be selected, so a screen reader hears every change,
              including the selection being cleared; it is simply empty when there is nothing to say. A selected row
              the search hides is counted out loud, since nothing on screen shows it any more. */}
          {selection !== "none" && (
            <span
              className="cc-table-selected"
              role="status"
              data-table-selected-count={selectedIds.length}
              data-table-selected-hidden={hiddenSelected}
            >
              {selectionStatus}
            </span>
          )}
          {selectedIds.length > 0 && (multi || hiddenSelected > 0) && (
            <button type="button" className="cc-action" data-table-clear-selection="true" onClick={() => select([])}>
              {t("widgets.table.clearSelection")}
            </button>
          )}
          <button
            type="button"
            className="cc-action cc-table-export"
            data-table-export="true"
            disabled={exportReason !== undefined || exporting}
            aria-describedby={exportReason === undefined ? undefined : exportReasonId}
            onClick={() => onAction?.("export.requested", { ...tableExportRequest(computed) })}
          >
            {exporting ? t("widgets.table.exporting") : t("widgets.table.export")}
          </button>
        </div>
        {exportReason !== undefined && (
          <p id={exportReasonId} className="cc-freshness cc-table-note" data-table-export-reason="true">
            {exportReason}
          </p>
        )}
        {exportStatus === "failed" && (
          <p className="cc-table-note" data-table-export-error="true" role="alert">
            {t("widgets.table.exportFailed")}
          </p>
        )}
        {exportStatus === "done" && (
          <p className="cc-freshness cc-table-note" data-table-export-done="true" role="status">
            {t("widgets.table.exported")}
          </p>
        )}
        {/*
         * Scrolls on its own, sideways for wide data and down for a long page, with the header held in place, so a
         * table never pushes the conversation wider than the window. Focusable so the scroll is reachable by keyboard.
         */}
        <div className="cc-table-scroll" role="region" aria-label={title} tabIndex={0}>
          <table className="cc-table" data-multi={multi ? "true" : undefined}>
            <caption className="cc-sr-only">{title}</caption>
            <thead>
              <tr>
                {multi && (
                  <th scope="col" className="cc-table-check-cell">
                    <label className="cc-table-check">
                      <input
                        type="checkbox"
                        data-table-select-page="true"
                        aria-label={t("widgets.table.selectPage")}
                        checked={pageState === "all"}
                        disabled={pageIds.length === 0 || (full && pageState === "none")}
                        ref={(element) => {
                          if (element !== null) element.indeterminate = pageState === "some";
                        }}
                        onChange={() => select(togglePageSelection(selectedIds, pageIds))}
                      />
                    </label>
                  </th>
                )}
                {computed.columns.map((column, index) => {
                  const sorted = tableAriaSort(computed.sort, column.key);
                  return (
                    <th key={column.key} scope="col" aria-sort={sorted} data-align={column.align} className={stickyClass(index)}>
                      {/* A real button, so click, Enter and Space all sort and the focus ring is the browser's own. */}
                      <button
                        type="button"
                        className="cc-table-sort"
                        data-sort-column={column.key}
                        onClick={() => update({ sort: nextTableSort(computed.sort, column.key), page: 1 })}
                      >
                        <span>{column.label}</span>
                        <span className="cc-table-sort-icon" data-sorted={sorted} aria-hidden="true">
                          {SORT_ICON[sorted]}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {computed.pageRows.length === 0 && (
                <tr>
                  <td colSpan={columnCount} className="cc-table-empty" data-table-no-matches="true">
                    {t("widgets.table.noMatches")}
                  </td>
                </tr>
              )}
              {computed.pageRows.map((entry, position) => {
                const isSelected = selectedIds.includes(entry.id);
                const toggle = (): void => select(toggleTableSelection(selectedIds, entry.id, selection));
                const firstColumn = computed.columns[0];
                const rowName =
                  (firstColumn === undefined ? "" : format(firstColumn.key, entry.row[firstColumn.key])) ||
                  String(firstRowNumber + position);
                return (
                  <tr
                    key={entry.id}
                    data-row-id={entry.id}
                    data-selectable={single ? "true" : undefined}
                    aria-selected={selection === "none" ? undefined : isSelected}
                    // Single-select rows are focusable and Enter/Space-activated, so the selection a pointer makes is
                    // reachable from the keyboard; `role="button"` is not valid on `<tr>`, so the row keeps its table
                    // semantics. Multi-select uses a real checkbox per row instead.
                    tabIndex={single ? 0 : undefined}
                    onClick={single ? toggle : undefined}
                    onKeyDown={
                      single
                        ? (event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            toggle();
                          }
                        : undefined
                    }
                  >
                    {multi && (
                      <td className="cc-table-check-cell">
                        <label className="cc-table-check">
                          <input
                            type="checkbox"
                            data-table-select-row={entry.id}
                            aria-label={t("widgets.table.selectRow").replace("{row}", rowName)}
                            checked={isSelected}
                            // A full selection takes no more rows; the status above says so and how to make room.
                            disabled={full && !isSelected}
                            onChange={toggle}
                          />
                        </label>
                      </td>
                    )}
                    {computed.columns.map((column, index) => (
                      <td key={column.key} data-align={column.align} data-type={column.type} className={stickyClass(index)}>
                        {format(column.key, entry.row[column.key])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            {computed.totals.length > 0 && (
              <tfoot>
                <tr data-table-totals="true">
                  {multi && <td className="cc-table-check-cell" />}
                  {computed.columns.map((column, index) => (
                    <td key={column.key} data-align={column.align} data-type={column.type} className={stickyClass(index)}>
                      {computed.totals
                        .filter((total) => total.column === column.key)
                        .map((total) => (
                          <span key={total.fn} className="cc-table-total" data-total-fn={total.fn}>
                            <span className="cc-table-total-fn">{t(TOTAL_LABEL_KEY[total.fn])}</span>{" "}
                            {formatTableTotal(total, column, locale, { yes, no })}
                          </span>
                        ))}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {/*
         * At the first or last page a button is marked unavailable rather than disabled: a disabled button drops the
         * keyboard focus that just pressed it, and the person paging with Enter would land back at the top of the page.
         */}
        <nav className="cc-table-pager" aria-label={t("widgets.table.pagination")}>
          {computed.pageCount > 1 && (
            <button
              type="button"
              className="cc-action"
              data-table-page="previous"
              aria-disabled={computed.page <= 1}
              onClick={() => {
                if (computed.page > 1) update({ page: computed.page - 1 });
              }}
            >
              {t("widgets.table.previousPage")}
            </button>
          )}
          <span className="cc-table-page-status" data-table-page-status="true" aria-live="polite">
            {tablePageLabel(t("widgets.table.pageStatus"), computed, locale)}
          </span>
          {computed.pageCount > 1 && (
            <button
              type="button"
              className="cc-action"
              data-table-page="next"
              aria-disabled={computed.page >= computed.pageCount}
              onClick={() => {
                if (computed.page < computed.pageCount) update({ page: computed.page + 1 });
              }}
            >
              {t("widgets.table.nextPage")}
            </button>
          )}
        </nav>
      </>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Note
 * ------------------------------------------------------------------ */

function Note({ props, state, onStateChange, onAction }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.note.title"));
  const initialBody = typeof state?.body === "string" ? state.body : String(props.body ?? "");
  const serverRevision = typeof state?.revision === "number" ? state.revision : 0;

  const [draft, setDraft] = useState(initialBody);
  const [revision, setRevision] = useState(serverRevision);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = draft !== initialBody;
  const status = useMemo(() => {
    if (conflict) return "conflict";
    if (dirty) return "draft";
    if (saved) return "saved";
    return "idle";
  }, [conflict, dirty, saved]);

  return (
    <Frame title={title} dataset={undefined} role="note">
      <>
        <textarea
          className="cc-note-area"
          value={draft}
          aria-label={t("widgets.note.bodyAria")}
          placeholder={t("widgets.note.placeholder")}
          onChange={(event) => {
            // The draft lives locally until it is saved, so a failed save cannot lose text.
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <div className="cc-note-meta" data-note-status={status} role="status">
          {status === "draft" && t("widgets.note.unsaved")}
          {status === "saved" && t("widgets.note.saved")}
          {status === "idle" && t("widgets.note.currentRevision").replace("{revision}", String(revision))}
          {status === "conflict" && t("widgets.note.conflict")}
        </div>
        <div className="cc-card-actions">
          <button
            type="button"
            className="cc-action"
            data-emphasis="primary"
            disabled={!dirty}
            onClick={() => {
              // A save reports the revision the user actually saw. If the server has moved
              // on, the save is refused and the draft is preserved rather than overwritten.
              onStateChange?.({ body: draft, revision: revision + 1 });
              onAction?.("save.requested", { body: draft, expectedRevision: revision });
              setRevision((current) => current + 1);
              setSaved(true);
              setConflict(false);
              onAction?.("draft.changed", { length: draft.length });
            }}
          >
            {t("widgets.note.save")}
          </button>
          <button
            type="button"
            className="cc-action"
            // Nothing to discard until there is a draft or a conflict; an enabled button that changes nothing
            // is a control that looks usable before its action exists.
            disabled={!dirty && !conflict}
            onClick={() => {
              // Explicit conflict resolution: fetch the newer body rather than guessing.
              setConflict(false);
              setDraft(initialBody);
            }}
          >
            {t("widgets.note.discard")}
          </button>
        </div>
      </>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Donut
 * ------------------------------------------------------------------ */

/**
 * A real donut.
 *
 * `canvas.donut@1` previously resolved to the bar renderer, which drew a correct number in the
 * wrong shape: a chart of parts of a whole that read as a comparison between unrelated bars. The
 * wedges are drawn from the same rows, and the two cases a donut cannot express — a negative share
 * and a zero total — are stated in text rather than drawn as an empty ring.
 */
/** Distinct wedge tones before they repeat; the stylesheet defines one rule per tone. */
const DONUT_TONES = 6;

function Donut({ props, dataset, state }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.donut.title"));
  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.donut.noData")} />
      </Frame>
    );
  }

  const choice = chosenSeries(state, dataset.rows);
  const valueKey = choice.series ?? Object.keys(dataset.rows[0] ?? {}).find((key) => typeof dataset.rows[0]?.[key] === "number") ?? "value";
  const entries = dataset.rows.map((row) => ({ label: label(row, ["label", "name", "category"]), value: Number(row[valueKey] ?? 0) }));
  const result = donutSlices(entries);

  if (!result.ok) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.donut.cannotDraw").replace("{reason}", result.reason)} />
      </Frame>
    );
  }

  if (result.totalZero) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.donut.zeroTotal")} />
        <TextAlternative rows={dataset.rows} />
      </Frame>
    );
  }

  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <Frame title={title} dataset={dataset} role="chart">
      <>
        <SeriesNote choice={choice} />
        <div style={{ display: "flex", gap: "var(--cc-space-md)", alignItems: "center", flexWrap: "wrap" }}>
          <svg
            className="cc-donut"
            viewBox="0 0 160 160"
            role="img"
            aria-label={t("widgets.donut.ariaSlices").replace("{title}", title).replace("{count}", String(result.slices.length))}
          >
            {result.slices.map((slice, index) => {
              const length = slice.share * circumference;
              // A hairline gap between wedges, so two neighbours in similar tones still read as two parts.
              const gap = result.slices.length > 1 ? Math.min(2, length / 2) : 0;
              const dash = `${length - gap} ${circumference - length + gap}`;
              const element = (
                <circle
                  key={slice.label}
                  className="wedge"
                  cx={80}
                  cy={80}
                  r={radius}
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                  data-slice-index={index}
                  data-slice-tone={index % DONUT_TONES}
                >
                  <title>{`${slice.label}: ${slice.value} (${Math.round(slice.share * 100)}%)`}</title>
                </circle>
              );
              offset += length;
              return element;
            })}
          </svg>
          <ul className="cc-legend">
            {result.slices.map((slice, index) => (
              <li key={slice.label}>
                <span className="cc-legend-name">
                  <span className="cc-legend-swatch" data-slice-tone={index % DONUT_TONES} aria-hidden="true" />
                  {slice.label}
                </span>
                <span data-donut-value={slice.label}>
                  {slice.value} ({Math.round(slice.share * 100)}%)
                </span>
              </li>
            ))}
          </ul>
        </div>
        <TextAlternative rows={dataset.rows} />
      </>
    </Frame>
  );
}

/**
 * The table alternative every chart carries.
 *
 * Inside a `<details>` rather than a screen-reader-only span: a chart that cannot be read as a
 * chart has to be readable by anyone, not only by assistive technology.
 */
function TextAlternative({ rows }: { rows: Record<string, unknown>[] }): ReactElement {
  const t = useT();
  const columns = Object.keys(rows[0] ?? {});
  return (
    <details className="cc-text-alt">
      <summary>{t("widgets.textAlternative.summary")}</summary>
      {/* Scroll-contained like the data table, so a wide dataset cannot widen the conversation once expanded. */}
      <div className="cc-table-scroll" role="region" aria-label={t("widgets.textAlternative.summary")} tabIndex={0}>
      <table className="cc-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column}>{String(row[column] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ *
 * Area and scatter charts
 * ------------------------------------------------------------------ */

/** Above this many rows an area chart draws its points only where a person is: the one focused, the one selected. */
const DENSE_POINTS = 60;
const MARKER_RADIUS = 4;

function withUnit(value: number | string | undefined, unit: string | undefined): string {
  return unit === undefined ? String(value ?? "") : `${String(value ?? "")} ${unit}`;
}

/** One point in the page's words: the series, where it is on x, and its value. */
function xyPointLabel(chart: XyChart, data: XyChartData, seriesIndex: number, index: number): string {
  const series = data.series[seriesIndex];
  const x = data.xs[index];
  const at = chart.kind === "scatter" ? `${xyFieldLabel(chart, chart.x)} ${withUnit(x, chart.xUnit)}` : String(x ?? "");
  const name = data.names[index];
  return `${series?.label ?? ""} · ${at}: ${withUnit(series?.values[index], chart.unit)}${name === undefined ? "" : ` (${name})`}`;
}

function xyViewPayload(view: XyChartViewState): Record<string, unknown> {
  return { hiddenSeries: view.hiddenSeries, ...(view.selected === undefined ? {} : { selected: view.selected }) };
}

/** A series' key: its line pattern and its point shape, in its tone, so the legend names what the plot draws. */
function SeriesKey({ index }: { index: number }): ReactElement {
  const dash = seriesDash(index);
  return (
    <svg className="cc-xy-key" viewBox="0 0 26 12" aria-hidden="true" data-slice-tone={index % DONUT_TONES}>
      <line x1={1} y1={6} x2={25} y2={6} {...(dash === "" ? {} : { strokeDasharray: dash })} />
      <path className="marker" d={markerPath(markerShape(index), 13, 6, 3.5)} />
    </svg>
  );
}

/** The chart's fields as a table: the rows it drew, with the columns it plots and names them as the chart does. */
function XyTable({ chart, rows }: { chart: XyChart; rows: readonly Record<string, unknown>[] }): ReactElement {
  const t = useT();
  const columns = [chart.x, ...chart.y, ...(chart.pointLabel === undefined ? [] : [chart.pointLabel])];
  return (
    <details className="cc-text-alt">
      <summary>{t("widgets.textAlternative.summary")}</summary>
      <div className="cc-table-scroll" role="region" aria-label={t("widgets.textAlternative.summary")} tabIndex={0}>
        <table className="cc-table" data-xy-table="true">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {xyFieldLabel(chart, column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column}>{String(row[column] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * An area chart or a scatter plot over named fields of a dataset.
 *
 * The fields are the ones the props name, read by the same rules the node placed the chart by, and rows that no longer
 * fit are said in words rather than drawn as zeros. Each series has its own tone, line pattern and point shape, and the
 * legend is a row of buttons that hide and show it. Every point is a button reached with the arrow keys; selecting one
 * says what it is beside the chart. What a person hides and selects is the chart's view: it is drawn at once and sent to
 * the node as `chart.view`, which keeps it and refuses a view that does not fit, and a view the node holds is adopted
 * when it changes.
 */
function XyChartRenderer({ definitionId, props, dataset, state, onAction }: RendererProps): ReactElement {
  const t = useT();
  const kind = XY_CHART_KIND[definitionId] ?? "area";
  const chart = useMemo(() => readXyChart(kind, props), [kind, props]);
  const rows = dataset?.rows ?? NO_ROWS;
  const data = useMemo(() => (chart === undefined ? undefined : xyChartData(chart, rows)), [chart, rows]);
  const title = chart?.title ?? t(kind === "area" ? "widgets.xyChart.areaTitle" : "widgets.xyChart.scatterTitle");
  const [measure, width] = useMeasuredWidth(640);
  const hintId = useId();
  const pointRefs = useRef(new Map<string, SVGPathElement>());

  // The view the node holds, adopted whenever it changes; between those, what the person just did is drawn at once.
  const stored: XyChartViewState = chart === undefined || data === undefined ? { hiddenSeries: [] } : readXyChartView(chart, state, data.shown);
  // A refusal counts up `viewReset`, so a change the node refused is undrawn even when the view it holds did not move.
  const storedKey = `${JSON.stringify(stored)}#${String(state?.viewReset ?? 0)}`;
  const [view, setView] = useState(stored);
  const [syncedKey, setSyncedKey] = useState(storedKey);
  if (syncedKey !== storedKey) {
    setSyncedKey(storedKey);
    setView(stored);
  }
  const [cursor, setCursor] = useState<PointCursor | undefined>(undefined);
  const [lastSeriesNote, setLastSeriesNote] = useState(false);

  if (chart === undefined) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.xyChart.cannotDraw").replace("{reason}", xyChartProblems(kind, props).join("; "))} />
      </Frame>
    );
  }
  if (dataset === undefined || data === undefined) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.xyChart.datasetMissing")} />
      </Frame>
    );
  }
  const problems = xyChartDataProblems(chart, rows);
  if (problems.length > 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.xyChart.cannotDraw").replace("{reason}", problems.join("; "))} />
      </Frame>
    );
  }
  if (data.shown === 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.xyChart.noData")} />
      </Frame>
    );
  }

  const commit = (next: XyChartViewState): void => {
    setView(next);
    onAction?.(XY_CHART_VIEW_OPERATION, xyViewPayload(next));
  };
  const shownSeries = data.series.flatMap((series, index) => (view.hiddenSeries.includes(series.field) ? [] : [index]));
  const order = pointOrder(data.xs);
  const stacked = chart.kind === "area" && chart.stacked;
  const bands = stacked ? stackBands(shownSeries.map((index) => data.series[index]?.values ?? [])) : [];
  const yOf = (seriesIndex: number, index: number): number => {
    if (stacked) return bands[shownSeries.indexOf(seriesIndex)]?.upper[index] ?? 0;
    return data.series[seriesIndex]?.values[index] ?? 0;
  };
  const yValues = stacked ? bands.flatMap((band) => band.upper) : shownSeries.flatMap((index) => data.series[index]?.values ?? []);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  // An area is measured from zero, since its fill is the amount; a scatter plot is measured over the values it has.
  const geometry = chartGeometry(width, yValues, chart.kind === "scatter" ? niceSpan(yMin, yMax) : niceRange(Math.min(yMin, 0), Math.max(yMax, 0)));
  const left = CHART_PAD.left;
  const right = width - CHART_PAD.right;
  const inset = Math.min(18, geometry.plotWidth / 4);

  const numericXs = data.numericX ? data.xs.map((x) => (typeof x === "number" ? x : 0)) : [];
  const xTicks = data.numericX ? niceSpan(Math.min(...numericXs), Math.max(...numericXs)) : [];
  const scaleX = linearScale([xTicks[0] ?? 0, xTicks.at(-1) ?? 1], [left + inset, right - inset]);
  const step = data.shown > 1 ? (geometry.plotWidth - inset * 2) / (data.shown - 1) : 0;
  const xAt = (index: number): number =>
    data.numericX ? scaleX(numericXs[index] ?? 0) : data.shown > 1 ? left + inset + index * step : left + geometry.plotWidth / 2;
  const xTickLabels = formatTicks(xTicks);
  const xStride = labelStride(data.numericX ? xTicks.length : data.shown, geometry.plotWidth);

  const tabStop: PointCursor =
    cursor !== undefined && shownSeries.includes(cursor.series) && cursor.index < data.shown
      ? cursor
      : view.selected !== undefined
        ? { series: data.series.findIndex((series) => series.field === view.selected?.series), index: view.selected.index }
        : { series: shownSeries[0] ?? 0, index: order[0] ?? 0 };
  const dense = chart.kind === "area" && data.shown > DENSE_POINTS;

  const toggleSeries = (field: string): void => {
    const hidden = view.hiddenSeries.includes(field);
    if (!hidden && shownSeries.length <= 1) {
      setLastSeriesNote(true);
      return;
    }
    setLastSeriesNote(false);
    const hiddenSeries = hidden ? view.hiddenSeries.filter((entry) => entry !== field) : [...view.hiddenSeries, field];
    const keepSelection = view.selected !== undefined && view.selected.series !== field;
    commit({ hiddenSeries, ...(keepSelection && view.selected !== undefined ? { selected: view.selected } : {}) });
  };
  const togglePoint = (seriesIndex: number, index: number): void => {
    const field = data.series[seriesIndex]?.field ?? "";
    const same = view.selected?.series === field && view.selected.index === index;
    commit({ hiddenSeries: view.hiddenSeries, ...(same ? {} : { selected: { series: field, index } }) });
  };
  const selectedIndex = view.selected === undefined ? -1 : data.series.findIndex((series) => series.field === view.selected?.series);
  const selectedText = view.selected === undefined || selectedIndex < 0 ? undefined : xyPointLabel(chart, data, selectedIndex, view.selected.index);
  const pathOf = (points: [number, number][]): string =>
    points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${Number(x.toFixed(2))} ${Number(y.toFixed(2))}`).join(" ");
  const indices = Array.from({ length: data.shown }, (_, index) => index);

  return (
    <Frame title={title} dataset={dataset} role="chart">
      <>
        <ul className="cc-xy-legend" aria-label={t("widgets.xyChart.legend").replace("{title}", title)} data-xy-legend="true">
          {data.series.map((series, index) => {
            const hidden = view.hiddenSeries.includes(series.field);
            return (
              <li key={series.field}>
                <button
                  type="button"
                  aria-pressed={!hidden}
                  title={t("widgets.xyChart.toggleSeries").replace("{series}", series.label)}
                  data-series={series.field}
                  onClick={() => toggleSeries(series.field)}
                >
                  <SeriesKey index={index} />
                  <span className="cc-xy-legend-name">{series.label}</span>
                  {hidden && <span className="cc-xy-legend-state">({t("widgets.xyChart.hidden")})</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {lastSeriesNote && (
          <p className="cc-freshness" role="status" data-xy-last-series="true" style={{ margin: 0 }}>
            {t("widgets.xyChart.lastSeries")}
          </p>
        )}
        {typeof state?.message === "string" && state.message !== "" && (
          <p className="cc-freshness" role="status" data-xy-message="true" style={{ margin: 0 }}>
            {state.message}
          </p>
        )}
        <div ref={measure} className="cc-chart-box">
          <svg
            className="cc-chart"
            viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
            role="group"
            aria-label={t("widgets.xyChart.points").replace("{title}", stacked ? `${title} (${t("widgets.xyChart.stacked")})` : title).replace("{count}", String(data.shown))}
            aria-describedby={hintId}
            data-xy-chart={chart.kind}
            data-stacked={stacked ? "true" : "false"}
            data-dense={dense ? "true" : "false"}
          >
            <ChartGrid geometry={geometry} />
            <g aria-hidden="true">
              {data.numericX
                ? xTicks.map((tick, index) =>
                    index % xStride === 0 ? (
                      <text key={tick} className="label" x={scaleX(tick)} y={CHART_HEIGHT - 6} textAnchor="middle">
                        {xTickLabels[index]}
                      </text>
                    ) : null,
                  )
                : data.xs.map((x, index) =>
                    index % xStride === 0 ? (
                      <text key={index} className="label" x={xAt(index)} y={CHART_HEIGHT - 6} textAnchor="middle">
                        {String(x)}
                      </text>
                    ) : null,
                  )}
            </g>
            {chart.kind === "area" && (
              <g aria-hidden="true">
                {shownSeries.map((seriesIndex, position) => {
                  const upper = indices.map((index): [number, number] => [xAt(index), geometry.scaleY(yOf(seriesIndex, index))]);
                  const lower = stacked
                    ? indices.map((index): [number, number] => [xAt(index), geometry.scaleY(bands[position]?.lower[index] ?? 0)]).reverse()
                    : [
                        [xAt(data.shown - 1), geometry.zero] as [number, number],
                        [xAt(0), geometry.zero] as [number, number],
                      ];
                  const dash = seriesDash(seriesIndex);
                  return (
                    <g key={seriesIndex} data-slice-tone={seriesIndex % DONUT_TONES}>
                      {data.shown > 1 && <path className="xy-area" d={`${pathOf([...upper, ...lower])} Z`} />}
                      <path className="xy-line" d={pathOf(upper)} {...(dash === "" ? {} : { strokeDasharray: dash })} />
                    </g>
                  );
                })}
              </g>
            )}
            {shownSeries.map((seriesIndex) => {
              const series = data.series[seriesIndex];
              if (series === undefined) return null;
              const shape = markerShape(seriesIndex);
              return (
                <g
                  key={series.field}
                  role="group"
                  aria-label={t("widgets.xyChart.seriesPoints").replace("{series}", series.label)}
                  data-slice-tone={seriesIndex % DONUT_TONES}
                  data-series-points={series.field}
                >
                  {indices.map((index) => {
                    const selected = view.selected?.series === series.field && view.selected.index === index;
                    const key = `${String(seriesIndex)}:${String(index)}`;
                    const label = xyPointLabel(chart, data, seriesIndex, index);
                    return (
                      <path
                        key={index}
                        ref={(element) => {
                          if (element === null) pointRefs.current.delete(key);
                          else pointRefs.current.set(key, element);
                        }}
                        className="marker"
                        d={markerPath(shape, xAt(index), geometry.scaleY(yOf(seriesIndex, index)), selected ? MARKER_RADIUS + 2 : MARKER_RADIUS)}
                        role="button"
                        tabIndex={tabStop.series === seriesIndex && tabStop.index === index ? 0 : -1}
                        aria-label={label}
                        aria-pressed={selected}
                        data-point={`${series.field}#${String(index)}`}
                        onFocus={() => setCursor({ series: seriesIndex, index })}
                        onClick={() => {
                          setCursor({ series: seriesIndex, index });
                          togglePoint(seriesIndex, index);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            togglePoint(seriesIndex, index);
                            return;
                          }
                          if (event.key === "Escape") {
                            if (view.selected !== undefined) {
                              event.preventDefault();
                              commit({ hiddenSeries: view.hiddenSeries });
                            }
                            return;
                          }
                          const next = movePointCursor(event.key, { series: seriesIndex, index }, shownSeries, order);
                          if (next === undefined) return;
                          event.preventDefault();
                          setCursor(next);
                          pointRefs.current.get(`${String(next.series)}:${String(next.index)}`)?.focus();
                        }}
                      >
                        <title>{label}</title>
                      </path>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
        <span id={hintId} className="cc-sr-only">
          {t("widgets.xyChart.keyboardHint")}
        </span>
        <div className="cc-xy-selected" aria-live="polite" data-selected-point={view.selected === undefined ? "" : `${view.selected.series}#${String(view.selected.index)}`}>
          {selectedText !== undefined && (
            <>
              <span>{t("widgets.xyChart.selected").replace("{point}", selectedText)}</span>
              <button type="button" className="cc-xy-clear" onClick={() => commit({ hiddenSeries: view.hiddenSeries })}>
                {t("widgets.xyChart.clearSelection")}
              </button>
            </>
          )}
        </div>
        {data.total > data.shown && (
          <p className="cc-freshness" data-xy-truncated="true" style={{ margin: 0 }}>
            {t("widgets.xyChart.truncated").replace("{shown}", String(data.shown)).replace("{total}", String(data.total))}
          </p>
        )}
        <XyTable chart={chart} rows={rows.slice(0, data.shown)} />
      </>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Metrics, filter, calendar, image, call to action
 * ------------------------------------------------------------------ */

/**
 * Summary figures.
 *
 * A tile with no value is not rendered as `0`: a figure the host could not compute and a figure
 * that is genuinely zero are different facts, and the API sends the first as absent.
 */
function Metrics({ props, dataset }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.metrics.title"));
  const rows = dataset?.rows ?? [];
  if (rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="metrics">
        <Unavailable reason={t("widgets.metrics.noData")} />
      </Frame>
    );
  }

  return (
    <Frame title={title} dataset={dataset} role="metrics">
      <>
        <ul className="cc-metrics">
          {rows.map((row, index) => {
            const value = row.value;
            const unit = typeof row.unit === "string" ? row.unit : "";
            const hint = typeof row.hint === "string" ? row.hint : undefined;
            return (
              <li key={String(row.id ?? index)} className="cc-metric" data-metric={String(row.id ?? index)}>
                <span className="cc-metric-label">{String(row.label ?? "")}</span>
                <span className="cc-metric-value">
                  {typeof value === "number" ? value : "—"}
                  {unit !== "" && typeof value === "number" ? <span className="cc-metric-unit">{unit}</span> : null}
                </span>
                {hint !== undefined && <span className="cc-metric-hint">{hint}</span>}
              </li>
            );
          })}
        </ul>
        <TextAlternative rows={rows} />
      </>
    </Frame>
  );
}

/**
 * Period selector.
 *
 * A native `<select>`: keyboard support, touch support and the platform's own popup come free,
 * and a custom listbox would have to reimplement all three. Changing it reports the intent and
 * performs no fetch of its own until the parent supplies the new view.
 */
function PeriodFilter({ props, onAction, state }: RendererProps): ReactElement {
  const t = useT();
  const current = typeof state?.period === "string" ? state.period : String(props.period ?? "week");
  const timezone = String(props.timezone ?? "UTC");
  const busy = state?.pending === true;

  return (
    <Frame title={String(props.title ?? t("widgets.periodFilter.title"))} dataset={undefined} role="filter">
      <>
        <label className="cc-filter">
          <span className="cc-sr-only">{t("widgets.periodFilter.label")}</span>
          <select
            value={current}
            disabled={busy}
            data-period-select="true"
            onChange={(event) => onAction?.("period.change", { period: event.target.value, timezone })}
          >
            <option value="week">{t("widgets.periodFilter.week")}</option>
            <option value="month">{t("widgets.periodFilter.month")}</option>
          </select>
        </label>
        <span className="cc-freshness" data-timezone={timezone}>
          {t("widgets.periodFilter.timezone").replace("{timezone}", timezone)}
          {busy ? t("widgets.periodFilter.loadingNewRange") : ""}
        </span>
      </>
    </Frame>
  );
}

/**
 * Month view of local events.
 *
 * Days are buttons, so a keyboard can reach them and the selected day is announced. Each day opens
 * a detail list rather than a modal: the transcript stays readable and nothing is hidden behind a
 * surface that a snapshot cannot reproduce.
 */
function Calendar({ props, dataset, state, onAction, onStateChange }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.calendar.title"));
  const month = String(props.month ?? "");
  const timezone = String(props.timezone ?? "UTC");
  const rows = dataset?.rows ?? [];
  const cells = useMemo(() => monthGrid(month, timezone), [month, timezone]);
  const selectedDate = typeof state?.selectedDate === "string" ? state.selectedDate : undefined;

  const byDate = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const date = String(row.date ?? "");
      const bucket = map.get(date) ?? [];
      bucket.push(row);
      map.set(date, bucket);
    }
    return map;
  }, [rows]);

  if (cells.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="calendar">
        <Unavailable reason={t("widgets.calendar.notReadable")} />
      </Frame>
    );
  }

  const selectedEvents = selectedDate === undefined ? [] : byDate.get(selectedDate) ?? [];
  const weekdays: MessageKey[] = [
    "widgets.calendar.day.mon",
    "widgets.calendar.day.tue",
    "widgets.calendar.day.wed",
    "widgets.calendar.day.thu",
    "widgets.calendar.day.fri",
    "widgets.calendar.day.sat",
    "widgets.calendar.day.sun",
  ];

  return (
    <Frame title={title} dataset={dataset} role="calendar">
      <>
        <table className="cc-calendar" data-calendar-month={month}>
          <caption className="cc-sr-only">
            {t("widgets.calendar.caption").replace("{month}", month).replace("{timezone}", timezone)}
          </caption>
          <thead>
            <tr>
              {weekdays.map((dayKey) => (
                <th key={dayKey} scope="col">
                  {t(dayKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }, (_unused, week) => (
              <tr key={week}>
                {cells.slice(week * 7, week * 7 + 7).map((cell) => {
                  const events = byDate.get(cell.date) ?? [];
                  return (
                    <td key={cell.date} data-date={cell.date} data-in-month={cell.inMonth}>
                      <button
                        type="button"
                        className="cc-calendar-day"
                        aria-pressed={selectedDate === cell.date}
                        aria-label={t("widgets.calendar.dayAriaEvents")
                          .replace("{date}", cell.date)
                          .replace("{count}", String(events.length))}
                        onClick={() => {
                          onStateChange?.({ selectedDate: cell.date });
                          onAction?.("date.select", { date: cell.date });
                        }}
                      >
                        <span>{cell.day}</span>
                        {events.length > 0 && <span className="cc-calendar-count">{events.length}</span>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="cc-calendar-detail" data-selected-date={selectedDate ?? ""}>
          {selectedDate === undefined
            ? t("widgets.calendar.selectADay")
            : selectedEvents.length === 0
              ? t("widgets.calendar.noEventsThatDay")
              : (
                <ul>
                  {selectedEvents.map((event, index) => (
                    <li key={String(event.eventId ?? index)}>
                      <strong>{String(event.title ?? "")}</strong>{" "}
                      <span className="cc-freshness">{`${String(event.startsAt ?? "")} → ${String(event.endsAt ?? "")}`}</span>
                    </li>
                  ))}
                </ul>
              )}
        </div>
        <span className="cc-freshness">{t("widgets.calendar.localOnlyNotice")}</span>
      </>
    </Frame>
  );
}

/**
 * An imported image.
 *
 * The bytes are fetched through the node with the bearer token, so a removed image becomes a
 * stated fallback rather than a broken image icon: the alt text is always rendered when the image
 * cannot be.
 */
function LocalImage({ props, imageUrl }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.image.title"));
  const alt = String(props.alt ?? "");
  const imageRef = String(props.imageRef ?? "");
  const url = imageRef === "" ? undefined : imageUrl?.(imageRef);

  return (
    <Frame title={title} dataset={undefined} role="media">
      {url === undefined ? (
        <Unavailable reason={t("widgets.image.notLoaded").replace("{alt}", alt)} />
      ) : (
        <figure className="cc-image">
          <img src={url} alt={alt} loading="lazy" decoding="async" data-image-ref={imageRef} />
          <figcaption className="cc-freshness">{alt}</figcaption>
        </figure>
      )}
    </Frame>
  );
}

/** The opaque picture references a widget was given, in the order it gave them. */
function pictureRefs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
}

/**
 * The descriptions that belong to those pictures, by position.
 *
 * By position because that is what the schema can say, and a picture without a description is a picture some
 * people cannot use at all. An entry that is missing or not text becomes an empty description rather than a
 * borrowed one: the wrong description is worse than none.
 */
function pictureAlts(value: unknown, count: number): string[] {
  const given = Array.isArray(value) ? value : [];
  return Array.from({ length: count }, (_, index) => {
    const entry = given[index];
    return typeof entry === "string" ? entry : "";
  });
}

/** Several pictures seen one at a time, with the controls a keyboard can reach. */
function Carousel({ props, imageUrl }: RendererProps): ReactElement {
  const t = useT();
  const refs = pictureRefs(props.imageRefs);
  const alts = pictureAlts(props.alts, refs.length);
  const [index, setIndex] = useState(0);
  const current = refs.length === 0 ? 0 : Math.min(index, refs.length - 1);
  const ref = refs[current];
  const alt = alts[current] ?? "";
  const url = ref === undefined ? undefined : imageUrl?.(ref);

  return (
    <Frame title={String(props.title ?? t("widgets.carousel.title"))} dataset={undefined} role="media">
      {refs.length === 0 || url === undefined ? (
        <Unavailable
          reason={t("widgets.image.notLoaded").replace("{alt}", alts.filter((entry) => entry !== "").join(" · "))}
        />
      ) : (
        <div className="cc-carousel" data-carousel-index={current}>
          <figure className="cc-image">
            <img src={url} alt={alt} loading="lazy" decoding="async" data-image-ref={ref} />
            <figcaption className="cc-freshness">{alt}</figcaption>
          </figure>
          {refs.length > 1 && (
          <div className="cc-carousel-controls">
            <button
              type="button"
              aria-label={t("widgets.carousel.previous")}
              onClick={() => setIndex(current <= 0 ? refs.length - 1 : current - 1)}
            >
              ‹
            </button>
            <span className="cc-freshness" aria-live="polite">
              {current + 1}/{refs.length}
            </span>
            <button type="button" aria-label={t("widgets.carousel.next")} onClick={() => setIndex((current + 1) % refs.length)}>
              ›
            </button>
          </div>
          )}
        </div>
      )}
    </Frame>
  );
}

/** The same pictures as a grid, for when seeing them together is the point. */
function Gallery({ props, imageUrl }: RendererProps): ReactElement {
  const t = useT();
  const refs = pictureRefs(props.imageRefs);
  const alts = pictureAlts(props.alts, refs.length);
  const shown = refs.flatMap((ref, index) => {
    const url = imageUrl?.(ref);
    return url === undefined ? [] : [{ ref, url, alt: alts[index] ?? "" }];
  });

  return (
    <Frame title={String(props.title ?? t("widgets.gallery.title"))} dataset={undefined} role="media">
      {shown.length === 0 ? (
        <Unavailable
          reason={t("widgets.image.notLoaded").replace("{alt}", alts.filter((entry) => entry !== "").join(" · "))}
        />
      ) : (
        <ul className="cc-gallery" data-gallery-count={shown.length}>
          {shown.map((picture) => (
            <li key={picture.ref}>
              <figure className="cc-image">
                <img src={picture.url} alt={picture.alt} loading="lazy" decoding="async" data-image-ref={picture.ref} />
                {picture.alt !== "" && <figcaption className="cc-freshness">{picture.alt}</figcaption>}
              </figure>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

/**
 * A YouTube video, embedded from YouTube only when the widget asks for it.
 *
 * The address is built here from an identifier the host validated, never taken from the widget: an embed is a
 * request the reader's browser makes to somebody else's server, and where it may point is the host's decision
 * rather than the model's. The nocookie host is used because a video is not a reason to be followed around the
 * internet.
 */
function YouTubeEmbed({ props }: RendererProps): ReactElement {
  const t = useT();
  const videoId = String(props.videoId ?? "");
  const title = String(props.title ?? t("widgets.video.youtubeTitle"));
  const description = typeof props.description === "string" ? props.description : "";
  const usable = /^[A-Za-z0-9_-]{6,20}$/.test(videoId);
  /*
   * Where playback stopped, when this surface is a restored pin. `restorePinnedInstance` returns the position and
   * the embed carries it in the vendor's own `start` parameter; the URL cannot ask for autoplay, because restoring
   * a pin reopens a surface rather than starting a session.
   */
  const positionSeconds = typeof props.positionSeconds === "number" ? props.positionSeconds : 0;

  return (
    <Frame title={title} dataset={undefined} role="media">
      {!usable ? (
        <Unavailable
          reason={t("widgets.video.youtubeUnavailable")
            .replace("{title}", title)
            .replace("{description}", description === "" ? "" : ` — ${description}`)}
        />
      ) : (
        <div className="cc-embed">
          <iframe
            src={vendorEmbedUrl({ videoId, positionSeconds })}
            title={title}
            loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            data-video-id={videoId}
          />
          {description !== "" && <p className="cc-freshness">{description}</p>}
        </div>
      )}
    </Frame>
  );
}

/**
 * A video the host holds, played from the same opaque reference an imported image uses.
 *
 * `imageUrl` is the host's blob resolver rather than a picture-only one: what it resolves is a reference the
 * host minted, and a video is another thing behind such a reference. A reference the host cannot resolve shows
 * the description instead of an invented address.
 */
function LocalVideo({ props, imageUrl }: RendererProps): ReactElement {
  const t = useT();
  const ref = String(props.videoRef ?? "");
  const alt = String(props.alt ?? "");
  const posterRef = typeof props.posterRef === "string" ? props.posterRef : "";
  const url = ref === "" ? undefined : imageUrl?.(ref);
  const poster = posterRef === "" ? undefined : imageUrl?.(posterRef);

  return (
    <Frame title={String(props.title ?? t("widgets.video.title"))} dataset={undefined} role="media">
      {url === undefined ? (
        <Unavailable reason={t("widgets.video.notPlayable").replace("{alt}", alt)} />
      ) : (
        <figure className="cc-video">
          <video
            controls
            preload="metadata"
            src={url}
            {...(poster === undefined ? {} : { poster })}
            aria-label={alt}
            data-video-ref={ref}
          />
          <figcaption className="cc-freshness">{alt}</figcaption>
        </figure>
      )}
    </Frame>
  );
}

/**
 * The one action in the M1 vocabulary.
 *
 * It reports an intent. It does not save, pin or dispatch anything itself: the effect is the
 * server's to authorize and to make durable, and a button that performed one optimistically would
 * show success for something that had not happened.
 */
function CallToAction({ props, onAction }: RendererProps): ReactElement {
  const t = useT();
  const label = String(props.label ?? t("widgets.cta.defaultLabel"));
  const actionId = String(props.actionId ?? "");
  // No `onAction` means this surface has no authorization to act — a historical snapshot, or a
  // surface another tab owns. Offering a live-looking button there would be a control that does
  // nothing, which is worse than one that says it is disabled.
  const actionable = onAction !== undefined && actionId !== "";
  return (
    <div className="cc-cta" data-cta-action={actionId} data-cta-actionable={actionable ? "true" : "false"}>
      <div>
        <div className="cc-card-title">{label}</div>
        {typeof props.description === "string" && <p className="cc-freshness">{props.description}</p>}
        {!actionable && <p className="cc-freshness">{t("widgets.cta.viewOnlyNotice")}</p>}
      </div>
      <button
        type="button"
        className="cc-action"
        data-emphasis="primary"
        disabled={!actionable}
        onClick={() => onAction?.("view.save", { actionId })}
      >
        {label}
      </button>
    </div>
  );
}

/** Strokes on a 24-unit grid; the set is closed, so a model can pick an icon but never draw one. */
const ACTION_ICON_PATHS: Record<string, string> = {
  play: "M8 5v14l11-7z",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  add: "M12 5v14M5 12h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  check: "M5 12.5l4.5 4.5L19 7",
};

/**
 * One button bound to one action the host holds.
 *
 * It knows what to show and nothing about what the button does: whether pressing it pins the view, calls a package
 * service, asks Clark or would run a workflow is the host's binding, which never reaches this renderer. It emits
 * `activate`; the host checks the binding again, runs it, and hands back what to say in `state`. That split is why a
 * button cannot claim an effect the host did not perform, and why the same markup serves every kind of action.
 */
function ActionButton({ props, onAction, state }: RendererProps): ReactElement {
  const t = useT();
  const label = String(props.label ?? "");
  const description = typeof props.description === "string" && props.description !== "" ? props.description : undefined;
  const iconPath = typeof props.icon === "string" ? ACTION_ICON_PATHS[props.icon] : undefined;
  const pending = state?.pending === true;
  const unavailableReason = typeof state?.unavailableReason === "string" ? state.unavailableReason : undefined;
  const message = typeof state?.message === "string" && state.message !== "" ? state.message : undefined;
  const tone = state?.tone === "refused" || state?.tone === "waiting" ? state.tone : "done";
  // No `onAction`: history, a surface another tab holds, or an instance the host bound nothing to.
  const actionable = onAction !== undefined && unavailableReason === undefined;
  const notice = !actionable ? (unavailableReason ?? t("widgets.action.viewOnlyNotice")) : undefined;
  const emphasis = props.emphasis === "secondary" ? "secondary" : "primary";
  return (
    <div className="cc-cta" data-action-widget="true" data-action-actionable={actionable ? "true" : "false"}>
      <div>
        <div className="cc-card-title">{label}</div>
        {description !== undefined && <p className="cc-freshness">{description}</p>}
        {notice !== undefined && (
          <p className="cc-freshness" data-action-unavailable="true">
            {notice}
          </p>
        )}
        {/* Polite, so the outcome of a press is read out without taking focus from the button that caused it. */}
        <p className="cc-freshness" data-action-result={message === undefined ? undefined : tone} role="status" aria-live="polite">
          {pending ? t("widgets.action.pending") : (message ?? "")}
        </p>
      </div>
      <button
        type="button"
        className="cc-action"
        data-emphasis={emphasis}
        disabled={!actionable}
        // aria-disabled while pending keeps focus on the button that was pressed; `disabled` would drop it.
        aria-disabled={pending ? "true" : undefined}
        aria-busy={pending ? "true" : undefined}
        onClick={() => {
          if (!pending) onAction?.("activate", {});
        }}
      >
        {iconPath !== undefined && (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ verticalAlign: "-2px", marginInlineEnd: "var(--cc-space-xs)" }}
          >
            <path d={iconPath} />
          </svg>
        )}
        {label}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Fields, forms, search and lists
 * ------------------------------------------------------------------ */

type Translate = (key: MessageKey) => string;

/**
 * The rule sentences `checkFieldValue` returns, said in the person's language.
 *
 * The page and the node share one set of rules and one set of sentences. The page translates the ones it knows and
 * shows any other exactly as written, so a rule added to the contract is still explained rather than dropped.
 */
const FIELD_PROBLEM_KEYS: readonly (readonly [RegExp, MessageKey])[] = [
  [/^required$/u, "widgets.field.required"],
  [/^expected text$/u, "widgets.field.expectedText"],
  [/^at most (\S+) characters$/u, "widgets.field.maxChars"],
  [/^at least (\S+) characters$/u, "widgets.field.minChars"],
  [/^expected a number$/u, "widgets.field.expectedNumber"],
  [/^at least (\S+)$/u, "widgets.field.atLeast"],
  [/^at most (\S+)$/u, "widgets.field.atMost"],
  [/^in steps of (\S+)$/u, "widgets.field.step"],
  [/^expected a date /u, "widgets.field.expectedDate"],
  [/^expected a time /u, "widgets.field.expectedTime"],
  [/^expected (?:only )?a start and an end date/u, "widgets.field.expectedRange"],
  [/^the end comes before the start$/u, "widgets.field.rangeOrder"],
  [/^expected one of the options$/u, "widgets.field.expectedOption"],
  [/^expected options from the list$/u, "widgets.field.expectedOptions"],
  [/^an option is chosen twice$/u, "widgets.field.chosenTwice"],
  [/^expected on or off$/u, "widgets.field.expectedBoolean"],
];

export function fieldProblemText(t: Translate, problem: string): string {
  for (const [pattern, key] of FIELD_PROBLEM_KEYS) {
    const match = pattern.exec(problem);
    if (match !== null) return t(key).replace("{n}", match[1] ?? "");
  }
  return problem;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A multi-choice value in the order its options are offered, whatever order they were picked in. */
function inOptionOrder(field: FormField, chosen: ReadonlySet<string>): string[] {
  return (field.options ?? []).map((option) => option.value).filter((value) => chosen.has(value));
}

interface FieldControlProps {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  /** Already in the person's language. The caller decides when to show it: once the field was left, or a send was tried. */
  error: string | undefined;
  /** The id of what takes focus for this field: the control itself, or the first control of a group. */
  controlId: string;
  disabled: boolean;
}

/**
 * One field, drawn with the control its kind calls for.
 *
 * Every control is a native element or a button, so a keyboard, a touch screen and a screen reader each get the
 * platform's own behaviour. A group (radio buttons, check boxes, chips, a date range) is a `fieldset` whose legend is the
 * label; any other control has its own `label`. The help and the problem are tied to the control with
 * `aria-describedby`, and a field with a problem is `aria-invalid`, so the sentence under it is read out with it.
 */
function FieldControl({ field, value, onChange, onBlur, error, controlId, disabled }: FieldControlProps): ReactElement {
  const t = useT();
  const helpId = `${controlId}-help`;
  const errorId = `${controlId}-error`;
  const labelId = `${controlId}-label`;
  const describedBy = [field.help === undefined ? "" : helpId, error === undefined ? "" : errorId]
    .filter((id) => id !== "")
    .join(" ");
  const aria = {
    "aria-describedby": describedBy === "" ? undefined : describedBy,
    "aria-invalid": error === undefined ? undefined : true,
  };
  const label = (
    <>
      {field.label}
      {field.required === true && (
        <>
          <span className="cc-field-required" aria-hidden="true">
            {" *"}
          </span>
          <span className="cc-sr-only"> {t("widgets.field.requiredMark")}</span>
        </>
      )}
    </>
  );
  const footer = (
    <>
      {field.help !== undefined && (
        <p id={helpId} className="cc-field-help">
          {field.help}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="cc-field-error" data-field-error={field.name}>
          {error}
        </p>
      )}
    </>
  );
  const options = field.options ?? [];
  const chosen = new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const toggleChosen = (option: string): void => {
    const next = new Set(chosen);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(inOptionOrder(field, next));
  };
  const labelled = (control: ReactNode): ReactElement => (
    <div className="cc-field" data-field={field.name} data-field-kind={field.kind}>
      <label className="cc-field-label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {footer}
    </div>
  );
  const grouped = (control: ReactNode): ReactElement => (
    <fieldset className="cc-field" data-field={field.name} data-field-kind={field.kind} disabled={disabled} {...aria}>
      <legend className="cc-field-label">{label}</legend>
      {control}
      {footer}
    </fieldset>
  );
  const blankToUndefined = (text: string): string | undefined => (text === "" ? undefined : text);

  switch (field.kind) {
    case "text":
      return labelled(
        field.multiline === true ? (
          <textarea
            id={controlId}
            className="cc-field-input"
            rows={3}
            value={textOf(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value)}
            onBlur={onBlur}
            {...aria}
          />
        ) : (
          <input
            id={controlId}
            className="cc-field-input"
            type="text"
            value={textOf(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value)}
            onBlur={onBlur}
            {...aria}
          />
        ),
      );
    case "number":
      return labelled(
        <input
          id={controlId}
          className="cc-field-input"
          type="number"
          inputMode="decimal"
          min={field.min}
          max={field.max}
          step={field.step ?? "any"}
          value={typeof value === "number" ? String(value) : textOf(value)}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            const parsed = Number(raw);
            // Text that is not a number is kept as typed, so the rule can say so instead of the value vanishing.
            onChange(raw === "" ? undefined : Number.isFinite(parsed) ? parsed : raw);
          }}
          onBlur={onBlur}
          {...aria}
        />,
      );
    case "slider": {
      const set = typeof value === "number";
      const shown = set ? String(value) : t("widgets.field.notSet");
      // A range input always draws a thumb somewhere. Until the person moves it the value is unset, and says so, rather
      // than the thumb's resting place being sent as if it had been chosen.
      const adopt = (element: HTMLInputElement): void => {
        if (!set) onChange(Number(element.value));
      };
      return labelled(
        <div className="cc-field-slider">
          <input
            id={controlId}
            type="range"
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            value={set ? value : (field.min ?? 0)}
            aria-valuetext={shown}
            disabled={disabled}
            data-field-unset={set ? undefined : "true"}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
            onClick={(event) => adopt(event.currentTarget)}
            onKeyUp={(event) => adopt(event.currentTarget)}
            onBlur={onBlur}
            {...aria}
          />
          <output htmlFor={controlId} className="cc-field-output" data-field-output={field.name}>
            {shown}
          </output>
        </div>,
      );
    }
    case "date":
    case "time":
      return labelled(
        <input
          id={controlId}
          className="cc-field-input"
          type={field.kind}
          value={textOf(value)}
          disabled={disabled}
          onChange={(event) => onChange(blankToUndefined(event.currentTarget.value))}
          onBlur={onBlur}
          {...aria}
        />,
      );
    case "date-range": {
      const range = recordOf(value);
      const setRange = (patch: { start?: string; end?: string }): void => {
        const next = { start: textOf(range.start), end: textOf(range.end), ...patch };
        onChange(next.start === "" && next.end === "" ? undefined : next);
      };
      return grouped(
        <div className="cc-field-range">
          <label className="cc-field-range-part">
            <span className="cc-field-help">{t("widgets.field.rangeStart")}</span>
            <input
              id={controlId}
              className="cc-field-input"
              type="date"
              value={textOf(range.start)}
              onChange={(event) => setRange({ start: event.currentTarget.value })}
              onBlur={onBlur}
              {...aria}
            />
          </label>
          <label className="cc-field-range-part">
            <span className="cc-field-help">{t("widgets.field.rangeEnd")}</span>
            <input
              className="cc-field-input"
              type="date"
              value={textOf(range.end)}
              onChange={(event) => setRange({ end: event.currentTarget.value })}
              onBlur={onBlur}
              {...aria}
            />
          </label>
        </div>,
      );
    }
    case "select":
      return labelled(
        <select
          id={controlId}
          className="cc-field-input"
          value={textOf(value)}
          disabled={disabled}
          onChange={(event) => onChange(blankToUndefined(event.currentTarget.value))}
          onBlur={onBlur}
          {...aria}
        >
          {/* Kept for a required field too: it is how the form says nothing is chosen yet. */}
          <option value="">{t("widgets.field.choose")}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>,
      );
    case "radio":
      return grouped(
        <div className="cc-field-options">
          {options.map((option, index) => (
            <label key={option.value} className="cc-field-check">
              <input
                id={index === 0 ? controlId : undefined}
                type="radio"
                name={controlId}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                onBlur={onBlur}
                {...aria}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>,
      );
    case "multiselect":
      return grouped(
        <div className="cc-field-options">
          {options.map((option, index) => (
            <label key={option.value} className="cc-field-check">
              <input
                id={index === 0 ? controlId : undefined}
                type="checkbox"
                value={option.value}
                checked={chosen.has(option.value)}
                onChange={() => toggleChosen(option.value)}
                onBlur={onBlur}
                {...aria}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>,
      );
    case "chips":
      return grouped(
        <div className="cc-field-chips">
          {options.map((option, index) => (
            <button
              key={option.value}
              id={index === 0 ? controlId : undefined}
              type="button"
              className="cc-field-chip"
              aria-pressed={chosen.has(option.value)}
              data-chip={option.value}
              onClick={() => toggleChosen(option.value)}
              onBlur={onBlur}
              {...aria}
            >
              {option.label}
            </button>
          ))}
        </div>,
      );
    case "checkbox":
      return (
        <div className="cc-field" data-field={field.name} data-field-kind={field.kind}>
          <label className="cc-field-check">
            <input
              id={controlId}
              type="checkbox"
              checked={value === true}
              disabled={disabled}
              onChange={(event) => onChange(event.currentTarget.checked)}
              onBlur={onBlur}
              {...aria}
            />
            <span>{label}</span>
          </label>
          {footer}
        </div>
      );
    case "toggle": {
      const on = value === true;
      return (
        <div className="cc-field" data-field={field.name} data-field-kind={field.kind}>
          <span className="cc-field-label" id={labelId}>
            {label}
          </span>
          <button
            id={controlId}
            type="button"
            role="switch"
            className="cc-switch"
            aria-checked={on}
            aria-labelledby={labelId}
            data-on={on ? "true" : "false"}
            disabled={disabled}
            onClick={() => onChange(!on)}
            onBlur={onBlur}
            {...aria}
          >
            <span className="cc-switch-track" aria-hidden="true">
              <span className="cc-switch-thumb" />
            </span>
            <span aria-hidden="true">{on ? t("widgets.field.on") : t("widgets.field.off")}</span>
          </button>
          {footer}
        </div>
      );
    }
  }
}

/**
 * A single choice or input on its own.
 *
 * It holds its value on the page, reports it as view state and emits its change event. On a composed surface that event
 * matters only when the surface's graph wires it into state, which is why a model is offered one on its own only with
 * an `on` rule. It is the same control a form draws for one field, shown by itself in the widget library.
 */
function StandaloneField({
  props,
  state,
  onAction,
  onStateChange,
  event,
  role,
}: RendererProps & { event: "choice.change" | "input.change"; role: "choice" | "input" }): ReactElement {
  const t = useT();
  const controlId = useId();
  const field = useMemo(() => {
    const described = fieldFromProps(props);
    return described !== undefined && checkField(described).length === 0 ? described : undefined;
  }, [props]);
  const [value, setValue] = useState<unknown>(() =>
    state !== undefined && "value" in state ? state.value : (props.value ?? (field === undefined ? undefined : emptyValueOf(field))),
  );
  const [touched, setTouched] = useState(false);
  if (field === undefined) {
    return (
      <Frame title={String(props.label ?? "")} dataset={undefined} role={role}>
        <Unavailable reason={t("widgets.field.unreadable")} />
      </Frame>
    );
  }
  const problem = checkFieldValue(field, value);
  return (
    <div className="cc-card" data-widget-role={role}>
      <div className="cc-card-body">
        <FieldControl
          field={field}
          value={value}
          controlId={controlId}
          disabled={false}
          error={touched && problem !== undefined ? fieldProblemText(t, problem) : undefined}
          onBlur={() => setTouched(true)}
          onChange={(next) => {
            setValue(next);
            onStateChange?.({ value: next });
            // Only a value that fits is reported; one that does not is shown with its problem instead.
            if (checkFieldValue(field, next) === undefined) onAction?.(event, { value: next });
          }}
        />
      </div>
    </div>
  );
}

function ChoiceControl(props: RendererProps): ReactElement {
  return <StandaloneField {...props} event="choice.change" role="choice" />;
}

function InputControl(props: RendererProps): ReactElement {
  return <StandaloneField {...props} event="input.change" role="input" />;
}

/** How long typing has to pause before a search settles. */
export const SEARCH_SETTLE_MS = 250;

/**
 * A search box whose query is the view's current query.
 *
 * The query stays on the page: it settles a moment after typing pauses (at once on Enter, and Escape clears it) and is
 * reported as view state, which a composed surface applies to its tables. Nothing is sent to the node or to Clark.
 */
function SearchBox({ props, state, onAction, onStateChange }: RendererProps): ReactElement {
  const t = useT();
  const inputId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const label = String(props.label ?? t("widgets.search.label"));
  const placeholder = typeof props.placeholder === "string" && props.placeholder !== "" ? props.placeholder : t("widgets.table.searchPlaceholder");
  const [text, setText] = useState(() => (typeof state?.query === "string" ? state.query : textOf(props.query)));
  const sent = useRef(text);
  // The latest callbacks, read when the query settles: a parent redrawing mid-pause must not restart the wait.
  const report = useRef({ onAction, onStateChange });
  report.current = { onAction, onStateChange };
  const settle = useCallback((query: string): void => {
    if (sent.current === query) return;
    sent.current = query;
    report.current.onStateChange?.({ query });
    report.current.onAction?.("query.change", { query });
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => settle(text), SEARCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settle, text]);

  return (
    <div className="cc-card" data-widget-role="search">
      <div className="cc-card-body" role="search">
        <label className="cc-field-label" htmlFor={inputId}>
          {label}
        </label>
        <div className="cc-search-row">
          <input
            id={inputId}
            ref={input}
            type="search"
            className="cc-field-input"
            data-search-input="true"
            value={text}
            maxLength={200}
            placeholder={placeholder}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                settle(text);
              } else if (event.key === "Escape" && text !== "") {
                event.preventDefault();
                setText("");
                settle("");
              }
            }}
          />
          {text !== "" && (
            <button
              type="button"
              className="cc-action"
              data-search-clear="true"
              onClick={() => {
                setText("");
                settle("");
                input.current?.focus();
              }}
            >
              {t("widgets.search.clear")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** What a host said about the one action a form or a list item sends to: running, its answer, or why it cannot run. */
function actionStatus(state: Record<string, unknown> | undefined): {
  pending: boolean;
  message: string | undefined;
  tone: "done" | "waiting" | "refused";
  unavailableReason: string | undefined;
} {
  return {
    pending: state?.pending === true,
    message: typeof state?.message === "string" && state.message !== "" ? state.message : undefined,
    tone: state?.tone === "refused" || state?.tone === "waiting" ? state.tone : "done",
    unavailableReason: typeof state?.unavailableReason === "string" ? state.unavailableReason : undefined,
  };
}

/**
 * A form: fields a person fills in and sends to the one action the host bound to it.
 *
 * The draft is view state, kept by the host for the session and never sent until the person submits. Each field is
 * checked as it is left and all of them on send, with the same rules the node applies again; a send with problems goes
 * nowhere and moves focus to the first one. A refusal from the node leaves the draft exactly as it was. The form knows
 * nothing about the action: it emits `submit` with its values, and the host decides, runs and answers.
 */
function FormView({ props, state, onAction, onStateChange }: RendererProps): ReactElement {
  const t = useT();
  const baseId = useId();
  const fields = useMemo(() => {
    const parsed = parseFields(props.fields);
    return parsed !== undefined && checkFields(parsed).length === 0 ? parsed : undefined;
  }, [props.fields]);
  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    const kept = recordOf(state?.draft);
    return Object.fromEntries((fields ?? []).map((field) => [field.name, field.name in kept ? kept[field.name] : emptyValueOf(field)]));
  });
  const [left, setLeft] = useState<ReadonlySet<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const title = typeof props.title === "string" && props.title !== "" ? props.title : t("widgets.form.title");
  if (fields === undefined) {
    return (
      <Frame title={title} dataset={undefined} role="form">
        <Unavailable reason={t("widgets.form.unreadable")} />
      </Frame>
    );
  }

  const submitLabel = String(props.submitLabel ?? "");
  const description = typeof props.description === "string" && props.description !== "" ? props.description : undefined;
  const { pending, message, tone, unavailableReason } = actionStatus(state);
  const actionable = onAction !== undefined && unavailableReason === undefined;
  const viewOnly = !actionable ? (unavailableReason ?? t("widgets.form.viewOnlyNotice")) : undefined;
  const problems = new Map<string, string>();
  for (const field of fields) {
    const problem = checkFieldValue(field, draft[field.name]);
    if (problem !== undefined) problems.set(field.name, problem);
  }
  const controlId = (name: string): string => `${baseId}-${name}`;
  const said =
    pending
      ? t("widgets.action.pending")
      : (notice ?? (message === undefined ? "" : tone === "refused" ? `${message} ${t("widgets.form.draftKept")}` : message));

  return (
    <Frame title={title} dataset={undefined} role="form">
      <form
        className="cc-form"
        noValidate
        aria-label={title}
        data-form-actionable={actionable ? "true" : "false"}
        onSubmit={(event) => {
          event.preventDefault();
          if (!actionable || pending) return;
          setAttempted(true);
          const first = fields.find((field) => problems.has(field.name));
          if (first !== undefined) {
            setNotice(t("widgets.form.fixFields").replace("{count}", String(problems.size)));
            document.getElementById(controlId(first.name))?.focus();
            return;
          }
          setNotice(undefined);
          // An empty optional field is left out rather than sent as nothing.
          const values = Object.fromEntries(
            fields.flatMap((field) => (isEmptyValue(draft[field.name]) ? [] : [[field.name, draft[field.name]]])),
          );
          onAction("submit", { values });
        }}
      >
        {description !== undefined && <p className="cc-freshness">{description}</p>}
        {viewOnly !== undefined && (
          <p className="cc-freshness" data-form-unavailable="true">
            {viewOnly}
          </p>
        )}
        {fields.map((field) => {
          const problem = problems.get(field.name);
          const shown = problem !== undefined && (attempted || left.has(field.name));
          return (
            <FieldControl
              key={field.name}
              field={field}
              value={draft[field.name]}
              controlId={controlId(field.name)}
              disabled={!actionable}
              error={shown ? fieldProblemText(t, problem) : undefined}
              onBlur={() => setLeft((current) => (current.has(field.name) ? current : new Set([...current, field.name])))}
              onChange={(value) => {
                const next = { ...draft, [field.name]: value };
                setDraft(next);
                setNotice(undefined);
                onStateChange?.({ draft: next });
              }}
            />
          );
        })}
        <div className="cc-form-foot">
          {/* Polite, so what happened to a send is read out without taking focus from where the person is. */}
          <p
            className="cc-freshness"
            role="status"
            aria-live="polite"
            data-form-result={pending ? "pending" : notice !== undefined ? "invalid" : message === undefined ? undefined : tone}
          >
            {said}
          </p>
          <button
            type="submit"
            className="cc-action"
            data-emphasis="primary"
            data-form-submit="true"
            disabled={!actionable}
            // aria-disabled while pending keeps focus on the button that was pressed; `disabled` would drop it.
            aria-disabled={pending ? "true" : undefined}
            aria-busy={pending ? "true" : undefined}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Code, diff and file viewers
 * ------------------------------------------------------------------ */

/*
 * What these show is what the model wrote into their props, and every piece of it reaches the page as text React escapes.
 * Highlighted code goes through the same tokenizer and element builder as a fenced block in a reply, so no markup in the
 * code becomes an element. None reads a dataset, so none carries a freshness badge, and none links anywhere.
 */

type CopyState = "idle" | "copied" | "failed";

/**
 * Copying text that is already on the page, and saying in words what happened.
 *
 * A refused clipboard (no permission, an insecure page, an unfocused window) is said, with what to do instead, rather
 * than left as a button that seemed to work. Each attempt is counted: the status is reset when a copy starts and its
 * words are drawn afresh for every result, so a screen reader hears the second "Code copied." as well as the first.
 */
function useCopy(text: string): { state: CopyState; attempt: number; copy: () => void } {
  const [status, setStatus] = useState<{ state: CopyState; attempt: number }>({ state: "idle", attempt: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(() => {
    clearTimeout(timer.current);
    setStatus((previous) => ({ state: "idle", attempt: previous.attempt }));
    const settle = (next: CopyState): void => {
      clearTimeout(timer.current);
      setStatus((previous) => ({ state: next, attempt: previous.attempt + 1 }));
      if (next === "copied") timer.current = setTimeout(() => setStatus((previous) => ({ ...previous, state: "idle" })), 4000);
    };
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      settle("failed");
      return;
    }
    clipboard.writeText(text).then(
      () => settle("copied"),
      () => settle("failed"),
    );
  }, [text]);
  return { ...status, copy };
}

function nonEmptyText(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function ViewerUnreadable({ title, role, message }: { title: string; role: string; message: string }): ReactElement {
  return (
    <Frame title={title} dataset={undefined} role={role}>
      <p className="cc-freshness" data-viewer-state="error" style={{ margin: 0 }}>
        {message}
      </p>
    </Frame>
  );
}

const HIDDEN_TITLE: Record<HiddenCharacterKind, MessageKey> = {
  bidi: "widgets.hiddenChar.bidi",
  invisible: "widgets.hiddenChar.invisible",
  tag: "widgets.hiddenChar.tag",
  filler: "widgets.hiddenChar.filler",
  control: "widgets.hiddenChar.control",
  "line-break": "widgets.hiddenChar.control",
};

/**
 * Text with each hidden character drawn as its code point in brackets, never applied.
 *
 * A bidi control applied would reorder the code on screen while the bytes run in another order; an invisible one would
 * hide inside a word. The marker shows exactly what is there, and its title says what kind of character it is.
 */
export function withHiddenMarkers(text: string, describe: (hidden: HiddenCharacter) => string): ReactNode {
  const segments = hiddenCharacterSegments(text);
  const [only] = segments;
  if (segments.length <= 1 && (only === undefined || "text" in only)) return text;
  return segments.map((segment) =>
    "text" in segment ? (
      segment.text
    ) : (
      <span key={segment.hidden.index} className="cc-hidden-char" data-hidden-char={segment.hidden.codePoint} title={describe(segment.hidden)}>
        {hiddenCharacterMarker(segment.hidden.codePoint)}
      </span>
    ),
  );
}

/** The same, through a tree of highlighted tokens: only the text inside them changes, never the tokens themselves. */
export function markHiddenInTree(node: ReactNode, describe: (hidden: HiddenCharacter) => string): ReactNode {
  if (typeof node === "string") return withHiddenMarkers(node, describe);
  if (Array.isArray(node)) return node.map((child: ReactNode) => markHiddenInTree(child, describe));
  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children !== undefined) {
    return cloneElement(node, undefined, markHiddenInTree(node.props.children, describe));
  }
  return node;
}

/** One warning line when the body holds hidden characters, drawn as markers; nothing when it holds none. */
function HiddenWarning({ count, messageKey }: { count: number; messageKey: MessageKey }): ReactElement | null {
  const t = useT();
  if (count === 0) return null;
  return (
    <p className="cc-freshness cc-viewer-hidden" data-viewer-hidden={count} style={{ margin: 0 }}>
      {t(messageKey).replace("{count}", String(count))}
    </p>
  );
}

/** A block of code with its line numbers, in a scroll that is bounded, focusable and named, with a copy button. */
function CodeViewerView({ props }: RendererProps): ReactElement {
  const t = useT();
  const content = useMemo(() => readArtifactViewer("code", props), [props]);
  const card = content?.kind === "code" ? content.card : undefined;
  const highlighted = useMemo(() => (card === undefined ? undefined : highlightedCode(card.code, codeLanguage(card))), [card]);
  const describe = useCallback(
    (hidden: HiddenCharacter) => t(HIDDEN_TITLE[hidden.kind]).replace("{codePoint}", hidden.codePoint),
    [t],
  );
  const body = useMemo(
    () => (card === undefined || highlighted === undefined ? undefined : markHiddenInTree(highlighted.nodes ?? card.code, describe)),
    [card, highlighted, describe],
  );
  const { state: copyState, attempt, copy } = useCopy(card?.code ?? "");
  const title = nonEmptyText(card?.title) ?? t("widgets.code.title");
  if (card === undefined || highlighted === undefined || content === undefined) {
    return <ViewerUnreadable title={title} role="code" message={t("widgets.code.unreadable")} />;
  }

  const { first, last, count } = codeLineRange(card);
  const name = card.path ?? highlighted.language;
  const lines = t("widgets.code.lines").replace("{first}", String(first)).replace("{last}", String(last));
  return (
    <Frame title={title} dataset={undefined} role="code">
      <HiddenWarning count={hiddenCharacterCount(content)} messageKey="widgets.code.hidden" />
      <div className="cc-code cc-viewer-code" data-code-lang={highlighted.language} data-viewer-state="ready">
        <div className="cc-code-head cc-viewer-head">
          <span className="cc-viewer-name">{name}</span>
          <span className="cc-viewer-meta">
            {card.path === undefined ? lines : `${highlighted.language} · ${lines}`}
          </span>
          <button
            type="button"
            className="cc-action cc-viewer-copy"
            onClick={copy}
            aria-label={t("widgets.code.copyName").replace("{name}", name)}
            data-viewer-copy={copyState}
          >
            {t("widgets.code.copy")}
          </button>
        </div>
        <div
          className="cc-viewer-scroll"
          // Reachable without a pointer: a long block that only a mouse can scroll hides its end from a keyboard.
          tabIndex={0}
          role="region"
          aria-label={t("widgets.code.region").replace("{name}", name)}
          data-viewer-scroll="code"
        >
          <pre className="cc-viewer-gutter" aria-hidden="true">
            {Array.from({ length: count }, (_, index) => String(first + index)).join("\n")}
          </pre>
          <pre className="cc-code-body">
            <code>{body}</code>
          </pre>
        </div>
      </div>
      {card.truncated === true && (
        <p className="cc-freshness" data-viewer-truncated="true" style={{ margin: 0 }}>
          {t("widgets.code.truncated")}
        </p>
      )}
      {/* Always in the page, so a screen reader is already listening when the first result is written into it. */}
      <p className="cc-freshness cc-viewer-copy-status" role="status" data-copy-state={copyState}>
        <span key={attempt}>
          {copyState === "copied" ? t("widgets.code.copied") : copyState === "failed" ? t("widgets.code.copyFailed") : ""}
        </span>
      </p>
    </Frame>
  );
}

const DIFF_SIGN: Record<DiffLineKind, string> = { add: "+", remove: "−", context: " " };

/**
 * A unified diff: each file's hunks, each line with its old and new numbers and a sign as well as a colour.
 *
 * The header of each hunk and every count are worked out from the lines, so a diff cannot claim more or fewer changes
 * than it shows. A screen reader hears each line's kind and number before its text; the signs and numbers it would
 * otherwise read one character at a time are hidden from it.
 */
function DiffViewerView({ props }: RendererProps): ReactElement {
  const t = useT();
  const content = useMemo(() => readArtifactViewer("diff", props), [props]);
  const describe = useCallback(
    (hidden: HiddenCharacter) => t(HIDDEN_TITLE[hidden.kind]).replace("{codePoint}", hidden.codePoint),
    [t],
  );
  const title = nonEmptyText(content?.card.title) ?? t("widgets.diff.title");
  if (content?.kind !== "diff") return <ViewerUnreadable title={title} role="diff" message={t("widgets.diff.unreadable")} />;

  const card = content.card;
  const counts = diffCounts(card);
  return (
    <Frame title={title} dataset={undefined} role="diff">
      <p
        className="cc-freshness"
        data-viewer-state="ready"
        data-diff-summary={`${String(counts.files)}:${String(counts.additions)}:${String(counts.deletions)}`}
        style={{ margin: 0 }}
      >
        {t("widgets.diff.summary")
          .replace("{files}", String(counts.files))
          .replace("{additions}", String(counts.additions))
          .replace("{deletions}", String(counts.deletions))}
      </p>
      <HiddenWarning count={hiddenCharacterCount(content)} messageKey="widgets.diff.hidden" />
      {card.files.map((file) => {
        const fileCounts = diffFileCounts(file);
        return (
          <div key={file.path} className="cc-viewer-diff-file" data-diff-path={file.path}>
            <div className="cc-diff-file-head">
              <code>{file.path}</code>
              <span className="cc-freshness cc-viewer-diff-counts">
                <span aria-hidden="true">
                  <span data-diff-additions={fileCounts.additions}>+{fileCounts.additions}</span>{" "}
                  <span data-diff-deletions={fileCounts.deletions}>−{fileCounts.deletions}</span>
                </span>
                <span className="cc-sr-only">
                  {t("widgets.diff.fileCounts")
                    .replace("{additions}", String(fileCounts.additions))
                    .replace("{deletions}", String(fileCounts.deletions))}
                </span>
              </span>
            </div>
            {file.oldPath !== undefined && (
              <p className="cc-freshness" data-diff-renamed-from={file.oldPath} style={{ margin: 0 }}>
                {t("widgets.diff.renamed").replace("{path}", file.oldPath)}
              </p>
            )}
            <div
              className="cc-viewer-scroll cc-viewer-diff-scroll"
              tabIndex={0}
              role="region"
              aria-label={t("widgets.diff.region").replace("{name}", file.path)}
              data-viewer-scroll="diff"
            >
              {file.hunks.map((hunk, hunkIndex) => (
                <div key={hunkIndex} className="cc-viewer-hunk">
                  <div className="cc-diff-header">{hunkHeader(hunk)}</div>
                  {numberedHunkLines(hunk).map((line, lineIndex) => {
                    const number = line.kind === "remove" ? line.oldLine : line.newLine;
                    return (
                      <div key={lineIndex} className="cc-diff-line cc-viewer-diff-line" data-line-kind={line.kind}>
                        <span className="cc-viewer-num" aria-hidden="true">
                          {line.oldLine ?? ""}
                        </span>
                        <span className="cc-viewer-num" aria-hidden="true">
                          {line.newLine ?? ""}
                        </span>
                        <span className="cc-diff-gutter" aria-hidden="true">
                          {DIFF_SIGN[line.kind]}
                        </span>
                        <span className="cc-sr-only">
                          {t(`widgets.diff.line.${line.kind}` as MessageKey).replace("{line}", String(number ?? ""))}{" "}
                        </span>
                        <code>{withHiddenMarkers(line.text, describe)}</code>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {card.truncated === true && (
        <p className="cc-freshness" data-viewer-truncated="true" style={{ margin: 0 }}>
          {t("widgets.diff.truncated")}
        </p>
      )}
    </Frame>
  );
}

/** The short mark a file card draws beside the name: its extension, or a dot when it has none. */
function fileMark(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 5).toUpperCase() : "•";
}

/** A file named and described. It has no link, no open and no download: it says so rather than drawing a dead button. */
function FileViewerView({ props }: RendererProps): ReactElement {
  const t = useT();
  const content = useMemo(() => readArtifactViewer("file", props), [props]);
  const title = nonEmptyText(content?.card.title) ?? t("widgets.file.title");
  if (content?.kind !== "file") return <ViewerUnreadable title={title} role="file" message={t("widgets.file.unreadable")} />;

  const card = content.card;
  const facts: { key: MessageKey; value: string; exact?: string }[] = [
    ...(card.mediaType === undefined ? [] : [{ key: "widgets.file.type" as MessageKey, value: card.mediaType }]),
    ...(card.sizeBytes === undefined
      ? []
      : [{ key: "widgets.file.size" as MessageKey, value: formatFileSize(card.sizeBytes), exact: `${String(card.sizeBytes)} B` }]),
    ...(nonEmptyText(card.source) === undefined ? [] : [{ key: "widgets.file.source" as MessageKey, value: String(card.source) }]),
    ...(card.path === undefined ? [] : [{ key: "widgets.file.path" as MessageKey, value: card.path }]),
  ];
  return (
    <Frame title={title} dataset={undefined} role="file">
      <div className="cc-viewer-file" data-viewer-state="ready">
        <span className="cc-viewer-file-mark" aria-hidden="true">
          {fileMark(card.name)}
        </span>
        <div className="cc-viewer-file-text">
          <p className="cc-viewer-file-name">{card.name}</p>
          {nonEmptyText(card.summary) !== undefined && <p className="cc-viewer-file-summary">{card.summary}</p>}
          {facts.length > 0 && (
            <dl className="cc-viewer-facts">
              {facts.map((fact) => (
                <div key={fact.key} className="cc-viewer-fact" data-file-fact={fact.key.slice("widgets.file.".length)}>
                  <dt>{t(fact.key)}</dt>
                  <dd title={fact.exact}>{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
      <p className="cc-freshness" data-file-named-only="true" style={{ margin: 0 }}>
        {t("widgets.file.namedOnly")}
      </p>
    </Frame>
  );
}

/**
 * A list of items with stable ids.
 *
 * Selection and the page are view state; an item is named by its id in every event, so a redraw never moves a selection
 * to a different item. With `itemActionLabel`, each item carries a button for the one action the host bound to the list;
 * the button is live only when the host says the binding can run (`state.itemActionReady`), and otherwise the list says
 * it is view-only rather than drawing buttons that do nothing.
 */
function ListView({ props, state, onAction, onStateChange }: RendererProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const groupName = useId();
  const title = typeof props.title === "string" && props.title !== "" ? props.title : t("widgets.list.title");
  const items = useMemo(() => {
    const parsed = parseListItems(props.items);
    return parsed !== undefined && checkListItems(parsed).length === 0 ? parsed : undefined;
  }, [props.items]);
  const selection = props.selection === "single" || props.selection === "multi" ? props.selection : "none";
  const pageSize = typeof props.pageSize === "number" ? props.pageSize : LIST_PAGE_SIZES.default;
  const [page, setPage] = useState(() => (typeof state?.page === "number" ? state.page : 1));
  const [selected, setSelected] = useState<string[]>(() =>
    Array.isArray(state?.selected) ? state.selected.filter((id): id is string => typeof id === "string") : [],
  );
  const [pressed, setPressed] = useState<string | undefined>(undefined);

  if (items === undefined) {
    return (
      <Frame title={title} dataset={undefined} role="list">
        <p className="cc-freshness" data-list-state="error" style={{ margin: 0 }}>
          {t("widgets.list.unreadable")}
        </p>
      </Frame>
    );
  }

  const loading = state?.loading === true;
  const { pending, message, tone, unavailableReason } = actionStatus(state);
  const actionLabel = typeof props.itemActionLabel === "string" && props.itemActionLabel !== "" ? props.itemActionLabel : undefined;
  const itemActionLive = actionLabel !== undefined && onAction !== undefined && state?.itemActionReady === true && unavailableReason === undefined;
  const viewOnly =
    actionLabel !== undefined && !itemActionLive ? (unavailableReason ?? t("widgets.list.viewOnlyNotice")) : undefined;
  const ids = new Set(items.map((item) => item.id));
  const current = selected.filter((id) => ids.has(id));
  /*
   * What a surface's state narrows the list to: a query over the text a person reads, and exact matches on a field. The
   * items stay whole; only which of them are on screen changes, so clearing the value shows them all again.
   */
  const query = typeof state?.query === "string" ? state.query.trim().toLocaleLowerCase(locale) : "";
  const exact = Object.entries(recordOf(state?.filters));
  const visible =
    query === "" && exact.length === 0
      ? items
      : items.filter(
          (item) =>
            (query === "" || [item.title, item.subtitle, item.meta].some((text) => typeof text === "string" && text.toLocaleLowerCase(locale).includes(query))) &&
            exact.every(([field, value]) => String((item as Record<string, unknown>)[field] ?? "") === String(value)),
        );
  const shown = listPage(visible, page, pageSize);
  const count = (value: number): string => new Intl.NumberFormat(locale).format(value);
  const pressedTitle = items.find((item) => item.id === pressed)?.title;

  const select = (next: string[]): void => {
    setSelected(next);
    onStateChange?.({ selected: next });
    onAction?.("selection.change", { selected: next });
  };
  const goTo = (next: number): void => {
    setPage(next);
    onStateChange?.({ page: next });
  };

  return (
    <Frame title={title} dataset={undefined} role="list">
      <>
        {viewOnly !== undefined && (
          <p className="cc-freshness" data-list-unavailable="true">
            {viewOnly}
          </p>
        )}
        {selection !== "none" && (
          <div className="cc-table-toolbar">
            <span className="cc-table-selected" role="status" data-list-selected-count={current.length}>
              {current.length === 0 ? "" : t("widgets.list.selectedCount").replace("{count}", count(current.length))}
            </span>
            {current.length > 0 && (
              <button type="button" className="cc-action" data-list-clear-selection="true" onClick={() => select([])}>
                {t("widgets.table.clearSelection")}
              </button>
            )}
          </div>
        )}
        {loading ? (
          <p className="cc-freshness" data-list-state="loading" role="status" style={{ margin: 0 }}>
            {t("widgets.list.loading")}
          </p>
        ) : items.length === 0 ? (
          <p className="cc-freshness" data-list-state="empty" style={{ margin: 0 }}>
            {typeof props.emptyText === "string" && props.emptyText !== "" ? props.emptyText : t("widgets.list.empty")}
          </p>
        ) : visible.length === 0 ? (
          <p className="cc-freshness" data-list-state="no-match" style={{ margin: 0 }}>
            {t("widgets.list.noMatch")}
          </p>
        ) : (
          <ul className="cc-list" aria-label={title} data-list-state="ready">
            {shown.rows.map((item) => {
              const isSelected = current.includes(item.id);
              const body = (
                <span className="cc-list-text">
                  <span className="cc-list-title">{item.title}</span>
                  {item.subtitle !== undefined && item.subtitle !== "" && <span className="cc-list-subtitle">{item.subtitle}</span>}
                </span>
              );
              return (
                <li key={item.id} className="cc-list-item" data-list-item={item.id} data-selected={isSelected ? "true" : undefined}>
                  {selection === "none" ? (
                    <div className="cc-list-main">{body}</div>
                  ) : (
                    <label className="cc-list-main">
                      <input
                        type={selection === "multi" ? "checkbox" : "radio"}
                        name={selection === "single" ? groupName : undefined}
                        data-list-select={item.id}
                        checked={isSelected}
                        onChange={() =>
                          select(
                            selection === "single"
                              ? [item.id]
                              : isSelected
                                ? current.filter((id) => id !== item.id)
                                : [...current, item.id],
                          )
                        }
                      />
                      {body}
                    </label>
                  )}
                  {item.meta !== undefined && item.meta !== "" && <span className="cc-list-meta">{item.meta}</span>}
                  {itemActionLive && (
                    <button
                      type="button"
                      className="cc-action"
                      data-list-item-action={item.id}
                      aria-label={`${actionLabel}: ${item.title}`}
                      aria-disabled={pending ? "true" : undefined}
                      aria-busy={pending && pressed === item.id ? "true" : undefined}
                      onClick={() => {
                        if (pending) return;
                        setPressed(item.id);
                        onAction("item.activate", { itemId: item.id });
                      }}
                    >
                      {actionLabel}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {itemActionLive && (
          <p className="cc-freshness" role="status" aria-live="polite" data-list-result={pending ? "pending" : message === undefined ? undefined : tone}>
            {pending
              ? t("widgets.action.pending")
              : message === undefined
                ? ""
                : pressedTitle === undefined
                  ? message
                  : `${pressedTitle}: ${message}`}
          </p>
        )}
        {shown.pageCount > 1 && !loading && (
          <nav className="cc-table-pager" aria-label={t("widgets.list.pagination")}>
            <button
              type="button"
              className="cc-action"
              data-list-page="previous"
              aria-disabled={shown.page <= 1}
              onClick={() => {
                if (shown.page > 1) goTo(shown.page - 1);
              }}
            >
              {t("widgets.table.previousPage")}
            </button>
            <span className="cc-table-page-status" data-list-page-status="true" aria-live="polite">
              {t("widgets.list.pageStatus")
                .replace("{page}", count(shown.page))
                .replace("{pageCount}", count(shown.pageCount))
                .replace("{total}", count(shown.total))}
            </span>
            <button
              type="button"
              className="cc-action"
              data-list-page="next"
              aria-disabled={shown.page >= shown.pageCount}
              onClick={() => {
                if (shown.page < shown.pageCount) goTo(shown.page + 1);
              }}
            >
              {t("widgets.table.nextPage")}
            </button>
          </nav>
        )}
      </>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Status, progress and details cards
 * ------------------------------------------------------------------ */

/*
 * What these cards show is what the model wrote when it placed them. None reads a dataset, so none carries a freshness
 * badge: a badge would say "live" or "sample" about something that is neither. When the model said when its facts were
 * true, the card says "as of" that time in words. Nothing on them acts, so nothing on them takes focus.
 */

/** A symbol per tone, so a tone is never carried by colour alone. */
const TONE_MARK: Record<StatusTone, string> = { neutral: "•", info: "i", success: "✓", warning: "!", danger: "✕" };
/** The badge tone the shared chrome already styles, per status tone. */
const TONE_BADGE: Record<StatusTone, string | undefined> = {
  neutral: undefined,
  info: "info",
  success: "ok",
  warning: "warn",
  danger: "danger",
};
const STEP_MARK: Record<StepStatus, string> = { done: "✓", current: "›", pending: "○", failed: "✕", skipped: "–" };

/** The capture time, in the reader's locale and timezone: the time alone when it is today, the day and time otherwise. */
function statedTime(locale: string, at: Date): string {
  const today = new Date().toDateString() === at.toDateString();
  return new Intl.DateTimeFormat(locale, today ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" }).format(at);
}

/**
 * Where the card's words come from, in one small line.
 *
 * "As of" a day or an instant when the model said when its facts were true. A day is formatted in UTC so it stays the
 * day the model named; an instant carries its offset and is shown in the reader's own timezone, which is the moment it
 * names. "As Clark stated at 09:30" when `stated` is asked for: the time the message was kept, so a card that looks
 * like a reading says it is what Clark wrote then. A progress card always says it; a status card says it when it has no
 * "as of". A fixture in the library says "Sample" there instead: nobody stated it.
 */
function Provenance({
  asOf,
  stated,
  statedAt,
  sample,
}: {
  asOf: string | undefined;
  stated: boolean;
  statedAt: string | undefined;
  sample: boolean | undefined;
}): ReactElement | null {
  const t = useT();
  const locale = useLocale();
  if (asOf === undefined && !stated) return null;
  const at = statedAt === undefined ? undefined : new Date(statedAt);
  const statedText = at === undefined || Number.isNaN(at.getTime()) ? undefined : statedTime(locale, at);
  let asOfText: string | undefined;
  if (asOf !== undefined) {
    const dayOnly = asOf.length === 10;
    const formatted = new Intl.DateTimeFormat(
      locale,
      dayOnly ? { dateStyle: "medium", timeZone: "UTC" } : { dateStyle: "medium", timeStyle: "short" },
    ).format(new Date(dayOnly ? `${asOf}T00:00:00Z` : asOf));
    asOfText = t("widgets.status.asOf").replace("{time}", () => formatted);
  }
  return (
    <p className="cc-freshness cc-status-card-asof" {...(asOf === undefined ? {} : { "data-status-as-of": asOf })}>
      {asOfText !== undefined && <time dateTime={asOf}>{asOfText}</time>}
      {asOfText !== undefined && stated && " · "}
      {stated &&
        (sample === true ? (
          <span data-status-sample="">{t("widgets.status.sample")}</span>
        ) : statedText !== undefined ? (
          <time dateTime={statedAt} data-status-stated-at={statedAt}>
            {t("widgets.status.statedAt").replace("{time}", () => statedText)}
          </time>
        ) : (
          <span data-status-stated-at="">{t("widgets.status.stated")}</span>
        ))}
    </p>
  );
}

function StatusCardView({ props, statedAt, sample }: RendererProps): ReactElement {
  const t = useT();
  const content = useMemo(() => readStatusCard("status", props), [props]);
  const title = typeof props.title === "string" && props.title !== "" ? props.title : t("widgets.status.title");
  if (content?.kind !== "status") {
    return (
      <Frame title={title} dataset={undefined} role="status">
        <p className="cc-freshness" data-status-state="error" style={{ margin: 0 }}>
          {t("widgets.status.unreadable")}
        </p>
      </Frame>
    );
  }
  const { label: statusLabel, tone, detail, asOf } = content.card;
  const toneWord = t(`widgets.status.tone.${tone}` as MessageKey);
  return (
    <Frame title={title} dataset={undefined} role="status">
      <div className="cc-status-card" data-status-tone={tone} data-status-state="ready">
        <span className="cc-status-card-mark" aria-hidden="true">
          {TONE_MARK[tone]}
        </span>
        <div className="cc-status-card-text">
          <p className="cc-status-card-label">
            <span className="cc-badge" data-tone={TONE_BADGE[tone]} data-status-tone-word={tone}>
              {toneWord}
            </span>
            <span className="cc-status-card-value">{statusLabel}</span>
          </p>
          {detail !== undefined && detail !== "" && <p className="cc-status-card-detail">{detail}</p>}
        </div>
      </div>
      <Provenance asOf={asOf} stated={asOf === undefined} statedAt={statedAt} sample={sample} />
    </Frame>
  );
}

function ProgressCardView({ props, statedAt, sample }: RendererProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const content = useMemo(() => readStatusCard("progress", props), [props]);
  const title = typeof props.title === "string" && props.title !== "" ? props.title : t("widgets.progress.title");
  if (content?.kind !== "progress") {
    return (
      <Frame title={title} dataset={undefined} role="progress">
        <p className="cc-freshness" data-progress-state="error" style={{ margin: 0 }}>
          {t("widgets.progress.unreadable")}
        </p>
      </Frame>
    );
  }
  const card = content.card;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const subject = card.label !== undefined && card.label !== "" ? card.label : undefined;
  const percent = progressPercent(card);

  if (card.steps === undefined) {
    const value = card.value ?? 0;
    const max = card.max ?? 1;
    const shown = percent ?? 0;
    // Function replacers: a unit is the model's text, and a string replacement would read "$&" in it as a pattern.
    const unit = card.unit === undefined || card.unit === "" ? "" : ` ${card.unit}`;
    const figure = t("widgets.progress.value")
      .replace("{value}", () => number.format(value))
      .replace("{max}", () => number.format(max))
      .replace("{unit}", () => unit)
      .replace("{percent}", () => number.format(shown));
    return (
      <Frame title={title} dataset={undefined} role="progress">
        {subject !== undefined && <p className="cc-progress-subject">{subject}</p>}
        <div className="cc-progress-row" data-progress-state="ready" data-progress-kind="value">
          <div
            className="cc-progress-track"
            role="progressbar"
            aria-label={subject ?? title}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-valuetext={figure}
          >
            <span className="cc-progress-fill" style={{ inlineSize: `${String(shown)}%` }} />
          </div>
          <span className="cc-progress-figure" data-progress-percent={shown}>
            {figure}
          </span>
        </div>
        <Provenance asOf={card.asOf} stated statedAt={statedAt} sample={sample} />
      </Frame>
    );
  }

  const counts = stepCounts(card.steps);
  return (
    <Frame title={title} dataset={undefined} role="progress">
      {subject !== undefined && <p className="cc-progress-subject">{subject}</p>}
      <p className="cc-freshness" data-progress-steps-summary={`${String(counts.finished)}/${String(counts.total)}`} style={{ margin: 0 }}>
        {t("widgets.progress.stepsSummary")
          .replace("{finished}", number.format(counts.finished))
          .replace("{total}", number.format(counts.total))}
      </p>
      <ol className="cc-progress-steps" aria-label={t("widgets.progress.stepsLabel")} data-progress-state="ready" data-progress-kind="steps">
        {card.steps.map((step, index) => (
          <li
            // Labels may repeat; the position is what identifies a step in a list nobody reorders.
            key={index}
            className="cc-progress-step"
            data-step-status={step.status}
            aria-current={step.status === "current" ? "step" : undefined}
          >
            <span className="cc-progress-step-mark" aria-hidden="true">
              {STEP_MARK[step.status]}
            </span>
            <span className="cc-progress-step-text">
              <span className="cc-progress-step-label">{step.label}</span>
              {step.detail !== undefined && step.detail !== "" && <span className="cc-progress-step-detail">{step.detail}</span>}
            </span>
            <span className="cc-progress-step-status">{t(`widgets.progress.step.${step.status}` as MessageKey)}</span>
          </li>
        ))}
      </ol>
      <Provenance asOf={card.asOf} stated statedAt={statedAt} sample={sample} />
    </Frame>
  );
}

function DetailsCardView({ props, statedAt, sample }: RendererProps): ReactElement {
  const t = useT();
  const content = useMemo(() => readStatusCard("details", props), [props]);
  const title = typeof props.title === "string" && props.title !== "" ? props.title : t("widgets.details.title");
  if (content?.kind !== "details") {
    return (
      <Frame title={title} dataset={undefined} role="details">
        <p className="cc-freshness" data-details-state="error" style={{ margin: 0 }}>
          {t("widgets.details.unreadable")}
        </p>
      </Frame>
    );
  }
  return (
    <Frame title={title} dataset={undefined} role="details">
      <div className="cc-details-box">
        <dl className="cc-details" data-details-state="ready">
          {content.card.items.map((item) => (
            <div key={item.label} className="cc-details-row" data-details-item={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <Provenance asOf={content.card.asOf} stated={false} statedAt={statedAt} sample={sample} />
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

/**
 * Catalog keyed by definition id.
 *
 * The client resolves a renderer from the definition id carried in the timeline. An id
 * with no entry falls back to the snapshot's text alternative, which is why the registry
 * returning `undefined` is a normal outcome rather than a failure.
 */
export const CATALOG: Record<string, CatalogRenderer> = {
  "canvas.line@1": LineChart,
  "canvas.bar@1": BarChart,
  "canvas.donut@1": Donut,
  "canvas.area@1": XyChartRenderer,
  "canvas.scatter@1": XyChartRenderer,
  "canvas.table@1": DataTable,
  "canvas.note@1": Note,
  "canvas.metrics@1": Metrics,
  "canvas.filter@1": PeriodFilter,
  "canvas.calendar@1": Calendar,
  "canvas.image@1": LocalImage,
  "canvas.carousel@1": Carousel,
  "canvas.gallery@1": Gallery,
  "canvas.youtube@1": YouTubeEmbed,
  "canvas.video@1": LocalVideo,
  "canvas.cta@1": CallToAction,
  "canvas.code@1": CodeViewerView,
  "canvas.diff@1": DiffViewerView,
  "canvas.file@1": FileViewerView,
  "canvas.action@1": ActionButton,
  "canvas.choice@1": ChoiceControl,
  "canvas.input@1": InputControl,
  "canvas.search@1": SearchBox,
  "canvas.form@1": FormView,
  "canvas.list@1": ListView,
  "canvas.status@1": StatusCardView,
  "canvas.progress@1": ProgressCardView,
  "canvas.details@1": DetailsCardView,
};

export function resolveRenderer(definitionId: string): CatalogRenderer | undefined {
  return CATALOG[definitionId];
}

export const RENDERER_IDS = Object.keys(CATALOG);
