import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  cloneElement,
  isValidElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CALENDAR_VIEWS,
  CALENDAR_VIEW_OPERATION,
  type CalendarEvent,
  type CalendarViewKind,
  type CalendarViewState,
  calendarFocusDate,
  calendarGridDates,
  checkField,
  checkFieldValue,
  checkFields,
  checkListItems,
  codeLanguage,
  codeLineRange,
  diffCounts,
  dateInZone,
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
  type ArtifactRef,
  emptyValueOf,
  eventDayCount,
  eventsOnDay,
  fieldFromProps,
  type FormField,
  isEmptyValue,
  isKnownTimeZone,
  isOnDay,
  LIST_PAGE_SIZES,
  listPage,
  MAX_CALENDAR_EVENTS,
  monthDates,
  normalizeTableSelectedIds,
  normalizeTableSelection,
  parseFields,
  parseListItems,
  progressPercent,
  readCalendarEvents,
  readCalendarState,
  readStatusCard,
  type StatusTone,
  type StepStatus,
  stepCounts,
  tableView,
  timeInZone,
  timedDuration,
  type TableTotalFn,
  TIMELINE_SELECT_OPERATION,
  type TimelineEntry,
  readTimeline,
  readTimelineSelection,
  timelineHiddenCount,
  timelinePage,
  timelinePageCount,
  timelinePageOf,
  timelineRange,
  TREE_ID,
  TREE_SELECT_OPERATION,
  TREE_TOGGLE_OPERATION,
  BOARD_ID,
  BOARD_ACKNOWLEDGE_OPERATION,
  BOARD_MOVE_OPERATION,
  MEDIA_VIEW_OPERATION,
  MAP_ID,
  MAP_SELECT_OPERATION,
  MAP_VIEW_OPERATION,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_VIEWPORT,
  type MapCamera,
  type MapFeature,
  type MapPosition,
  type MapTilePolicyView,
  type MapView,
  mapCamera,
  mapFeatureAnchor,
  readMap,
  readMapState,
  readMediaPlayback,
  readMediaSelection,
  type MediaPlaybackState,
  readAudio,
  readDocument,
  readDocumentPage,
  boardMoveProblems,
  moveBoardCard,
  readBoard,
  readBoardState,
  type BoardMove,
  type TreeNode,
  readTree,
  readTreeState,
  DIAGRAM_ID,
  DIAGRAM_SELECT_OPERATION,
  type DiagramNode,
  type PlacedDiagramNode,
  DIAGRAM_LINE_HEIGHT,
  diagramEdgeLabelWidth,
  diagramNeighbours,
  diagramTextLine,
  layoutDiagram,
  readDiagram,
  readDiagramState,
  XY_CHART_KIND,
  XY_CHART_VIEW_OPERATION,
  type XyChart,
  type XyChartData,
  type XyChartView as XyChartViewState,
  type XyDataIssue,
  readXyChart,
  readXyChartView,
  xyChartData,
  ownField,
  xyAxisTitles,
  xyChartDataIssues,
  xyFieldLabel,
} from "@clarkcant/contracts";

import type { ResolvedDataset } from "./api.ts";
import { boardColumnForBoardState, boardPickupDrop, boardPickupPreview, type BoardPickup, rebaseBoardPickup, rebaseBoardPointerDrag } from "./board-pickup.ts";
import { artifactReason } from "./artifact-messages.ts";
import { formatFileSize } from "./attachments.ts";
import { calendarWeek, eventSegment, moveDay, moveInList, nowIndex } from "./calendar-layout.ts";
import { treeFocusTarget, treeTypeaheadTarget, visibleTreeNodes, type VisibleTreeNode } from "./tree-layout.ts";
import { diagramKeyTarget } from "./diagram-navigation.ts";
import {
  MAP_PAN_STEP,
  type MapTilePlacement,
  basemapPath,
  cameraShift,
  featureShape,
  graticulePath,
  panCamera,
  sameCamera,
  stepFeature,
  toScreen,
  visibleTiles,
  zoomCamera,
} from "./map-layout.ts";
import type { SaveOutcome } from "./download.ts";
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
  TICK_GAP,
  stackBands,
  valueLabelShown,
} from "./chart-layout.ts";
import { highlightedCode } from "./markdown.tsx";
import {
  clampTimelinePage,
  foldedTimelineDescription,
  moveTimelineFocus,
  timelineDescriptionFolds,
  timelineTabStop,
  timelineToggle,
} from "./timeline-layout.ts";
import { vendorEmbedUrl } from "./media-embed.ts";
import { createPlaybackCoalescer, flushPlaybackOnLeave, type PlaybackCoalescer, type PlaybackWriteReason } from "./playback-coalescer.ts";
import { useNearViewport } from "./near-viewport.ts";
import { playbackOwner, pressStillCurrent } from "./playback-owner.ts";
import type { ObjectUrls } from "./use-object-urls.ts";
import { fillMessage } from "./i18n/fill-message.ts";
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
  /**
   * `leaving` marks a write sent as the page goes away: the host sends it at once, with `keepalive`. `stateOnly` marks a
   * player's playback state, which the host sends as the state-only write: nothing is re-rendered for it.
   */
  onAction?: ((action: string, payload: Record<string, unknown>, options?: { leaving?: boolean; stateOnly?: boolean }) => void) | undefined;
  onStateChange?: ((patch: Record<string, unknown>) => void) | undefined;
  /**
   * Resolves an imported image to a fetchable URL, or `undefined` while it is not available.
   *
   * Injected rather than built here, because the bytes are behind the gateway's bearer token and a
   * component must not know how a node is addressed.
   */
  imageUrl?: ((imageRef: string) => string | undefined) | undefined;
  /**
   * A player's source, read on request: its state, and a way to ask for the bytes.
   *
   * A host that lists player sources here reads none of them until the player comes near the screen or the person
   * presses play. Without it, a player resolves its source through `imageUrl` like a picture.
   */
  mediaUrls?: ObjectUrls | undefined;
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
  /**
   * Open and Save As for a file card that points at an artifact the node holds.
   *
   * Injected by a host that can reach the node as the person; absent in a preview or a detached window, where a card
   * with an artifact says it cannot open the file here rather than drawing buttons that fail.
   */
  artifactFiles?: ArtifactFileHost | undefined;
  /**
   * A map's tiles, read through the node's own tile route as the person.
   *
   * Injected only for a map in a live conversation. Absent in a preview, a pin or a detached window, where a map draws its
   * offline basemap alone and says so.
   */
  mapTiles?: MapTileHost | undefined;
}

/**
 * What a host lends a map for tiles: whether the node shows any and whose, and one tile by its address. A map never names
 * a host; the node's tile policy decides where tiles come from.
 */
export interface MapTileHost {
  policy(): Promise<MapTilePolicyView>;
  /** Rejects with an error whose `status` is 404 when the provider has no tile there; anything else may be tried again. */
  tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Blob>;
}

/** What a host lends a file card for an artifact: the bytes to preview, and a save the person drives. */
export interface ArtifactFileHost {
  open(ref: ArtifactRef): Promise<Blob>;
  saveAs(ref: ArtifactRef, suggestedName: string): Promise<SaveOutcome>;
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
  return (
    <g aria-hidden="true">
      {geometry.ticks.map((tick, index) => (
        <g key={tick}>
          <line className="grid" x1={geometry.left} x2={geometry.width - CHART_PAD.right} y1={geometry.scaleY(tick)} y2={geometry.scaleY(tick)} />
          <text className="label" x={geometry.left - TICK_GAP} y={geometry.scaleY(tick)} textAnchor="end" dominantBaseline="middle">
            {geometry.labels[index]}
          </text>
        </g>
      ))}
      <line className="axis" x1={geometry.left} y1={geometry.zero} x2={geometry.width - CHART_PAD.right} y2={geometry.zero} />
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
        ? fillMessage(t("widgets.chart.seriesMissing"), { series: named })
        : fillMessage(t("widgets.chart.showingSeries"), { series: named })}
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
  const x = (index: number): number => geometry.left + (values.length > 1 ? inset + index * step : geometry.plotWidth / 2);
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
              const center = geometry.left + index * slot + slot / 2;
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
          {status === "idle" &&
            (revision === 0 ? t("widgets.note.neverSaved") : t("widgets.note.currentRevision").replace("{revision}", String(revision)))}
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
        <Unavailable reason={fillMessage(t("widgets.donut.cannotDraw"), { reason: result.reason })} />
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
            aria-label={fillMessage(t("widgets.donut.ariaSlices"), { title, count: result.slices.length })}
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


/** A row problem in the person's language, from the row, field and value the contract found, never the node's English. */
function xyIssueText(t: (key: MessageKey) => string, issue: XyDataIssue): string {
  const { code, ...values } = issue;
  return fillMessage(t(`widgets.xyChart.issue.${code}`), Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string | number] => typeof entry[1] !== "object")));
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
  // A cell is the dataset's own text: a hidden character in it is drawn as a marker that says what it is, never applied.
  const describe = (hidden: HiddenCharacter): string => fillMessage(t(HIDDEN_TITLE[hidden.kind]), { codePoint: hidden.codePoint });
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
                  <td key={column}>{withHiddenMarkers(String(ownField(row, column) ?? ""), describe)}</td>
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
        <Unavailable reason={t("widgets.xyChart.propsInvalid")} />
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
  const issues = xyChartDataIssues(chart, rows);
  if (issues.length > 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={fillMessage(t("widgets.xyChart.cannotDraw"), { reason: issues.map((issue) => xyIssueText(t, issue)).join("; ") })} />
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
  const left = geometry.left;
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
  // A scatter's tick numbers do not say what they measure; its axes are titled with the field and unit they plot.
  const axes = chart.kind === "scatter" ? xyAxisTitles(chart) : undefined;

  return (
    <Frame title={title} dataset={dataset} role="chart">
      <>
        <ul className="cc-xy-legend" aria-label={fillMessage(t("widgets.xyChart.legend"), { title })} data-xy-legend="true">
          {data.series.map((series, index) => {
            const hidden = view.hiddenSeries.includes(series.field);
            return (
              <li key={series.field}>
                <button
                  type="button"
                  aria-pressed={!hidden}
                  title={fillMessage(t("widgets.xyChart.toggleSeries"), { series: series.label })}
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
        {axes !== undefined && (
          <p className="cc-xy-axis cc-xy-axis-y" data-xy-axis="y">
            {fillMessage(t("widgets.xyChart.yAxis"), { title: axes.y })}
          </p>
        )}
        <div ref={measure} className="cc-chart-box">
          <svg
            className="cc-chart"
            viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
            role="group"
            aria-label={fillMessage(t("widgets.xyChart.points"), {
              title: stacked ? `${title} (${t("widgets.xyChart.stacked")})` : title,
              count: data.shown,
            })}
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
                  aria-label={fillMessage(t("widgets.xyChart.seriesPoints"), { series: series.label })}
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
        {axes !== undefined && (
          <p className="cc-xy-axis cc-xy-axis-x" data-xy-axis="x">
            {fillMessage(t("widgets.xyChart.xAxis"), { title: axes.x })}
          </p>
        )}
        <span id={hintId} className="cc-sr-only">
          {t("widgets.xyChart.keyboardHint")}
        </span>
        <div className="cc-xy-selected" aria-live="polite" data-selected-point={view.selected === undefined ? "" : `${view.selected.series}#${String(view.selected.index)}`}>
          {selectedText !== undefined && (
            <>
              <span>{fillMessage(t("widgets.xyChart.selected"), { point: selectedText })}</span>
              <button type="button" className="cc-xy-clear" onClick={() => commit({ hiddenSeries: view.hiddenSeries })}>
                {t("widgets.xyChart.clearSelection")}
              </button>
            </>
          )}
        </div>
        {data.total > data.shown && (
          <p className="cc-freshness" data-xy-truncated="true" style={{ margin: 0 }}>
            {fillMessage(t("widgets.xyChart.truncated"), { shown: data.shown, total: data.total })}
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

/** Now, from this device's clock, moved on each minute so a calendar left open does not keep an old "now". */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const CALENDAR_WEEKDAYS: readonly MessageKey[] = [
  "widgets.calendar.day.mon",
  "widgets.calendar.day.tue",
  "widgets.calendar.day.wed",
  "widgets.calendar.day.thu",
  "widgets.calendar.day.fri",
  "widgets.calendar.day.sat",
  "widgets.calendar.day.sun",
];

const CALENDAR_VIEW_LABEL: Record<CalendarViewKind, MessageKey> = {
  month: "widgets.calendar.view.month",
  week: "widgets.calendar.view.week",
  agenda: "widgets.calendar.view.agenda",
};

/** When an event is, in the person's language and in `timeZone`. */
function calendarWhen(t: Translate, event: CalendarEvent, timeZone: string): string {
  if (event.allDay) {
    return event.startDate === event.lastDate
      ? fillMessage(t("widgets.calendar.when.allDay"), { date: event.startDate })
      : fillMessage(t("widgets.calendar.when.allDayRange"), { start: event.startDate, end: event.lastDate });
  }
  if (event.startsAt === undefined || event.endsAt === undefined) return event.startDate;
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const startDate = dateInZone(start, timeZone);
  const endDate = dateInZone(end, timeZone);
  return startDate === endDate
    ? `${startDate} ${timeInZone(start, timeZone)}–${timeInZone(end, timeZone)}`
    : `${startDate} ${timeInZone(start, timeZone)} → ${endDate} ${timeInZone(end, timeZone)}`;
}

/** How long a timed event runs, in the person's language: "4 giờ", "1 hour 30 minutes", "2 days 2 hours". */
function calendarDuration(t: Translate, duration: { days: number; hours: number; minutes: number }): string {
  const parts: string[] = [];
  const unit = (count: number, one: MessageKey, many: MessageKey): void => {
    if (count > 0) parts.push(fillMessage(t(count === 1 ? one : many), { count: String(count) }));
  };
  unit(duration.days, "widgets.calendar.duration.day", "widgets.calendar.duration.days");
  unit(duration.hours, "widgets.calendar.duration.hour", "widgets.calendar.duration.hours");
  unit(duration.minutes, "widgets.calendar.duration.minute", "widgets.calendar.duration.minutes");
  return parts.length === 0 ? fillMessage(t("widgets.calendar.duration.minutes"), { count: "0" }) : parts.join(" ");
}

/** What an event shows on one of its days: its hours that day, or that it is all day or runs through the day. */
function calendarDayTime(t: Translate, event: CalendarEvent, date: string, timeZone: string): string {
  if (event.allDay) return t("widgets.calendar.allDay");
  if (event.startsAt === undefined || event.endsAt === undefined) return t("widgets.calendar.noTime");
  const start = timeInZone(new Date(event.startsAt), timeZone);
  const end = timeInZone(new Date(event.endsAt), timeZone);
  const first = date === event.startDate;
  const last = date === event.lastDate;
  if (first && last) return `${start}–${end}`;
  if (first) return fillMessage(t("widgets.calendar.from"), { time: start });
  if (last) return fillMessage(t("widgets.calendar.until"), { time: end });
  return t("widgets.calendar.continues");
}

/** The view as the node is asked to hold it: only the keys that are set. */
function calendarViewPayload(view: CalendarViewState): Record<string, unknown> {
  return {
    view: view.view,
    ...(view.selectedDate === undefined ? {} : { selectedDate: view.selectedDate }),
    ...(view.selectedEventId === undefined ? {} : { selectedEventId: view.selectedEventId }),
  };
}

/** Moves focus to another button of the same kind inside `root`, by Up, Down, Home or End. */
function focusSibling(root: HTMLElement | null, selector: string, key: string): boolean {
  if (root === null) return false;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(selector));
  const index = buttons.findIndex((button) => button === document.activeElement);
  if (index < 0) return false;
  const next = moveInList(key, index, buttons.length);
  if (next === undefined) return false;
  buttons[next]?.focus();
  return true;
}

/**
 * Local and provider events in a month, week or agenda view.
 *
 * The view, the selected day and the selected event are the calendar's state: a change is drawn at once and sent as
 * the one bound view operation, and the view the node then holds is adopted. Every event is placed on each day it
 * covers in the calendar's own timezone, and an all-day event on its own dates, so a Tuesday offsite is on Tuesday
 * wherever the page is opened. Nothing here adds, moves or removes an event: that belongs to whatever owns the events.
 *
 * Days and events are buttons, so a keyboard reaches them and the selected one is announced; the selected event opens
 * a preview under the view rather than a modal, so the transcript stays readable and a snapshot can reproduce it.
 */
function Calendar({ props, dataset, state, onAction, onStateChange }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.calendar.title"));
  const month = String(props.month ?? "");
  const namedZone = typeof props.timezone === "string" && props.timezone !== "" ? props.timezone : "UTC";
  const zoneKnown = isKnownTimeZone(namedZone);
  const timezone = zoneKnown ? namedZone : "UTC";
  const rows = dataset?.rows ?? NO_ROWS;
  const read = useMemo(() => readCalendarEvents(rows, timezone), [rows, timezone]);
  const grid = useMemo(() => calendarGridDates(month), [month]);
  const ownDays = useMemo(() => monthDates(month), [month]);
  const now = useMinuteClock();
  const today = dateInZone(now, timezone);
  const hintId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // The view the node holds, adopted whenever it changes; between those, what the person just did is drawn at once.
  const stored = readCalendarState(state, month, props.view, read.events);
  // A refusal counts up `viewReset`, so a change the node refused is undrawn even when the view it holds did not move.
  const storedKey = `${JSON.stringify(stored)}#${String(state?.viewReset ?? 0)}`;
  const [view, setView] = useState(stored);
  const [syncedKey, setSyncedKey] = useState(storedKey);
  if (syncedKey !== storedKey) {
    setSyncedKey(storedKey);
    setView(stored);
  }
  const [focusDay, setFocusDay] = useState<string | undefined>(undefined);

  if (grid.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="calendar">
        <Unavailable reason={t("widgets.calendar.notReadable")} />
      </Frame>
    );
  }

  const commit = (next: CalendarViewState): void => {
    setView(next);
    onStateChange?.({
      view: next.view,
      ...(next.selectedDate !== view.selectedDate ? { selectedDate: next.selectedDate } : {}),
      selectedEventId: next.selectedEventId,
    });
    onAction?.(CALENDAR_VIEW_OPERATION, calendarViewPayload(next));
  };
  const selectDay = (date: string): void => {
    const keep = view.selectedEventId !== undefined && read.events.some((event) => event.id === view.selectedEventId && isOnDay(event, date));
    commit({ view: view.view, selectedDate: date, ...(keep && view.selectedEventId !== undefined ? { selectedEventId: view.selectedEventId } : {}) });
    onAction?.("date.select", { date });
  };
  const selectEvent = (event: CalendarEvent, date: string): void => {
    const same = view.selectedEventId === event.id && view.selectedDate === date;
    commit({ view: view.view, selectedDate: date, ...(same ? {} : { selectedEventId: event.id }) });
  };
  const clearEvent = (): void => {
    if (view.selectedEventId === undefined) return;
    commit({ view: view.view, ...(view.selectedDate === undefined ? {} : { selectedDate: view.selectedDate }) });
  };

  const anchor = calendarFocusDate(month, view.selectedDate, today);
  const rovingDay = focusDay !== undefined && grid.includes(focusDay) ? focusDay : anchor;
  const selectedEvent = view.selectedEventId === undefined ? undefined : read.events.find((event) => event.id === view.selectedEventId);
  const showsLocal = read.events.some((event) => event.source === "local");
  const nowText = timeInZone(now, timezone);
  const shownNotes: string[] = [];
  if (!zoneKnown) shownNotes.push(fillMessage(t("widgets.calendar.timeZoneUnknown"), { timezone: namedZone }));
  if (read.total > MAX_CALENDAR_EVENTS) {
    shownNotes.push(fillMessage(t("widgets.calendar.truncated"), { shown: String(MAX_CALENDAR_EVENTS), total: String(read.total) }));
  }
  if (read.unreadable > 0) shownNotes.push(fillMessage(t("widgets.calendar.unreadable"), { count: String(read.unreadable) }));

  const moveFocusToDay = (container: HTMLElement | null, key: string, from: string, days: readonly string[]): boolean => {
    const next = moveDay(key, from, days);
    if (next === undefined) return false;
    setFocusDay(next);
    container?.querySelector<HTMLButtonElement>(`[data-calendar-day="${next}"]`)?.focus();
    return true;
  };

  const eventButton = (event: CalendarEvent, date: string): ReactElement => {
    const segment = eventSegment(event, date);
    const time = calendarDayTime(t, event, date, timezone);
    const selected = view.selectedEventId === event.id && view.selectedDate === date;
    return (
      <button
        type="button"
        className="cc-calendar-event"
        data-calendar-event={event.id}
        data-all-day={event.allDay ? "true" : "false"}
        data-segment={segment.position}
        aria-pressed={selected}
        aria-label={fillMessage(t("widgets.calendar.eventAria"), {
          title: event.title,
          when: segment.days > 1 ? `${time}, ${fillMessage(t("widgets.calendar.dayN"), { day: segment.day, days: segment.days })}` : time,
        })}
        onClick={() => selectEvent(event, date)}
      >
        <span className="cc-calendar-event-time">{time}</span>
        <span className="cc-calendar-event-title">{event.title}</span>
        {segment.days > 1 && (
          <span className="cc-calendar-event-span">
            {fillMessage(t("widgets.calendar.dayN"), { day: String(segment.day), days: String(segment.days) })}
          </span>
        )}
      </button>
    );
  };

  // In a week's narrow day column the line carries the time alone, so it stays on one line; "now" is still read out.
  const nowMarker = (key: string, compact = false): ReactElement => (
    <li
      key={key}
      className="cc-calendar-now"
      data-calendar-now="true"
      // A week's narrow day shows only the time beside the line; a pointer can still read the whole label.
      title={compact ? fillMessage(t("widgets.calendar.now"), { time: nowText }) : undefined}
    >
      {compact ? (
        <>
          <span className="cc-sr-only">{fillMessage(t("widgets.calendar.now"), { time: nowText })}</span>
          <span aria-hidden="true">{nowText}</span>
        </>
      ) : (
        <span>{fillMessage(t("widgets.calendar.now"), { time: nowText })}</span>
      )}
    </li>
  );

  /** A day's events as a list, with the "now" line among them when the day is today. */
  const dayList = (date: string, emptyText?: string, compactNow = false): ReactElement => {
    const events = eventsOnDay(read.events, date);
    const at = date === today ? nowIndex(events, date, now) : -1;
    const items: ReactElement[] = [];
    events.forEach((event, index) => {
      if (index === at) items.push(nowMarker("now", compactNow));
      items.push(
        <li key={event.id} data-event-day={date}>
          {eventButton(event, date)}
        </li>,
      );
    });
    if (at === events.length) items.push(nowMarker("now", compactNow));
    if (events.length === 0 && emptyText !== undefined) {
      items.push(
        <li key="empty" className="cc-calendar-empty">
          {emptyText}
        </li>,
      );
    }
    return <ul className="cc-calendar-events">{items}</ul>;
  };

  const monthView = (): ReactElement => (
    <table
      className="cc-calendar"
      data-calendar-month={month}
      aria-describedby={hintId}
      onKeyDown={(keyEvent) => {
        const target = keyEvent.target as HTMLElement;
        const from = target.getAttribute("data-calendar-day");
        if (from === null) return;
        if (moveFocusToDay(keyEvent.currentTarget, keyEvent.key, from, grid)) keyEvent.preventDefault();
      }}
    >
      <caption className="cc-sr-only">{fillMessage(t("widgets.calendar.caption"), { month, timezone })}</caption>
      <thead>
        <tr>
          {CALENDAR_WEEKDAYS.map((dayKey) => (
            <th key={dayKey} scope="col">
              {t(dayKey)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: 6 }, (_unused, week) => (
          <tr key={week}>
            {grid.slice(week * 7, week * 7 + 7).map((date) => {
              const count = eventsOnDay(read.events, date).length;
              const isToday = date === today;
              return (
                <td key={date} data-date={date} data-in-month={ownDays.includes(date)} data-today={isToday ? "true" : undefined}>
                  <button
                    type="button"
                    className="cc-calendar-day"
                    data-calendar-day={date}
                    tabIndex={date === rovingDay ? 0 : -1}
                    aria-pressed={view.selectedDate === date}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={`${fillMessage(t("widgets.calendar.dayAriaEvents"), { date, count: String(count) })}${isToday ? `, ${t("widgets.calendar.today")}` : ""}`}
                    onFocus={() => setFocusDay(date)}
                    onClick={() => selectDay(date)}
                  >
                    <span>{Number(date.slice(8))}</span>
                    {count > 0 && <span className="cc-calendar-count">{count}</span>}
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );

  const weekView = (): ReactElement => {
    const week = calendarWeek(grid, anchor);
    const first = week.days[0] ?? anchor;
    const last = week.days[6] ?? anchor;
    return (
      <div className="cc-calendar-week-wrap">
        <div className="cc-calendar-week-nav">
          <button
            type="button"
            data-calendar-week="previous"
            disabled={week.previous === undefined}
            onClick={() => {
              if (week.previous !== undefined) selectDay(week.previous);
            }}
          >
            {t("widgets.calendar.previousWeek")}
          </button>
          <span className="cc-calendar-week-label">{`${first} – ${last}`}</span>
          <button
            type="button"
            data-calendar-week="next"
            disabled={week.next === undefined}
            onClick={() => {
              if (week.next !== undefined) selectDay(week.next);
            }}
          >
            {t("widgets.calendar.nextWeek")}
          </button>
        </div>
        <ol
          className="cc-calendar-week"
          data-calendar-week-of={first}
          aria-label={fillMessage(t("widgets.calendar.weekCaption"), { start: first, end: last, timezone })}
          aria-describedby={hintId}
          onKeyDown={(keyEvent) => {
            const target = keyEvent.target as HTMLElement;
            const from = target.getAttribute("data-calendar-day");
            if (from !== null && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(keyEvent.key)) {
              if (moveFocusToDay(keyEvent.currentTarget, keyEvent.key, from, week.days)) keyEvent.preventDefault();
            }
          }}
        >
          {week.days.map((date, index) => {
            const isToday = date === today;
            const dayKey = CALENDAR_WEEKDAYS[index] ?? "widgets.calendar.day.mon";
            return (
              <li key={date} className="cc-calendar-week-day" data-date={date} data-today={isToday ? "true" : undefined}>
                <button
                  type="button"
                  className="cc-calendar-week-head"
                  data-calendar-day={date}
                  tabIndex={date === (focusDay !== undefined && week.days.includes(focusDay) ? focusDay : anchor) ? 0 : -1}
                  aria-pressed={view.selectedDate === date}
                  aria-current={isToday ? "date" : undefined}
                  onFocus={() => setFocusDay(date)}
                  onClick={() => selectDay(date)}
                >
                  <span className="cc-calendar-week-name">{t(dayKey)}</span>
                  <span className="cc-calendar-week-date">{date}</span>
                  {isToday && <span className="cc-calendar-today-tag">{t("widgets.calendar.today")}</span>}
                </button>
                {dayList(date, t("widgets.calendar.noEvents"), true)}
              </li>
            );
          })}
        </ol>
      </div>
    );
  };

  const agendaView = (): ReactElement => {
    const days = ownDays.filter((date) => eventsOnDay(read.events, date).length > 0);
    const todayInMonth = ownDays.includes(today);
    const groups: ReactElement[] = [];
    let nowPlaced = !todayInMonth || days.includes(today);
    for (const date of days) {
      if (!nowPlaced && date > today) {
        groups.push(nowMarker("now"));
        nowPlaced = true;
      }
      groups.push(
        <li key={date} className="cc-calendar-agenda-day" data-date={date} data-today={date === today ? "true" : undefined}>
          <p className="cc-calendar-agenda-date">
            {date}
            {date === today && <span className="cc-calendar-today-tag">{t("widgets.calendar.today")}</span>}
          </p>
          {dayList(date)}
        </li>,
      );
    }
    if (!nowPlaced) groups.push(nowMarker("now"));
    return days.length === 0 ? (
      <p className="cc-freshness" data-calendar-agenda-empty="true" style={{ margin: 0 }}>
        {fillMessage(t("widgets.calendar.agendaEmpty"), { month })}
      </p>
    ) : (
      <ol
        className="cc-calendar-agenda"
        data-calendar-agenda={month}
        aria-label={fillMessage(t("widgets.calendar.agendaCaption"), { month, timezone })}
        aria-describedby={hintId}
      >
        {groups}
      </ol>
    );
  };

  const eventDetail = (event: CalendarEvent): ReactElement => {
    const days = eventDayCount(event);
    // A timed event says how long it runs; only an all-day event is counted in the days it covers.
    const duration = timedDuration(event);
    const lasts =
      duration !== undefined
        ? days > 1
          ? fillMessage(t("widgets.calendar.detail.duration"), { duration: calendarDuration(t, duration) })
          : undefined
        : event.allDay && days > 1
          ? fillMessage(t("widgets.calendar.detail.span"), { days: String(days) })
          : undefined;
    const ownZone = event.timezone !== undefined && event.timezone !== timezone && isKnownTimeZone(event.timezone) ? event.timezone : undefined;
    return (
      <div className="cc-calendar-event-detail" data-calendar-selected-event={event.id} role="group" aria-label={t("widgets.calendar.selectedEvent")}>
        <strong>{event.title}</strong>
        <span>{calendarWhen(t, event, timezone)}</span>
        {!event.allDay && event.startsAt !== undefined && (
          <span className="cc-freshness">{fillMessage(t("widgets.calendar.detail.shownIn"), { timezone })}</span>
        )}
        {lasts !== undefined && (
          <span className="cc-freshness" data-calendar-lasts="true">
            {lasts}
          </span>
        )}
        {ownZone !== undefined && (
          <span className="cc-freshness" data-calendar-source-zone={ownZone}>
            {fillMessage(t("widgets.calendar.detail.sourceZone"), { timezone: ownZone, when: calendarWhen(t, event, ownZone) })}
          </span>
        )}
        <button type="button" className="cc-calendar-clear" data-calendar-clear="true" onClick={clearEvent}>
          {t("widgets.calendar.clearEvent")}
        </button>
      </div>
    );
  };

  const todayShown =
    view.view === "month" ? grid.includes(today) : view.view === "week" ? calendarWeek(grid, anchor).days.includes(today) : ownDays.includes(today);

  return (
    <Frame title={title} dataset={dataset} role="calendar">
      <div
        ref={rootRef}
        className="cc-calendar-root"
        data-calendar-view={view.view}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Escape" && view.selectedEventId !== undefined) {
            keyEvent.preventDefault();
            clearEvent();
            return;
          }
          const target = keyEvent.target as HTMLElement;
          if (target.getAttribute("data-calendar-event") !== null && focusSibling(rootRef.current, "[data-calendar-event]", keyEvent.key)) {
            keyEvent.preventDefault();
          }
        }}
      >
        <div className="cc-calendar-views" role="group" aria-label={t("widgets.calendar.views")}>
          {CALENDAR_VIEWS.map((kind) => (
            <button
              key={kind}
              type="button"
              data-calendar-view-button={kind}
              aria-pressed={view.view === kind}
              onClick={() => {
                if (view.view !== kind) commit({ ...view, view: kind });
              }}
            >
              {t(CALENDAR_VIEW_LABEL[kind])}
            </button>
          ))}
        </div>
        {typeof state?.message === "string" && state.message !== "" && (
          <p className="cc-freshness" role="status" data-calendar-message="true" style={{ margin: 0 }}>
            {state.message}
          </p>
        )}
        {todayShown && (
          <p className="cc-freshness cc-calendar-now-text" data-calendar-now-text="true" style={{ margin: 0 }}>
            {fillMessage(t("widgets.calendar.nowLine"), { date: today, time: nowText, timezone })}
          </p>
        )}
        {view.view === "month" ? monthView() : view.view === "week" ? weekView() : agendaView()}
        <p id={hintId} className="cc-sr-only">
          {t("widgets.calendar.keyboardHint")}
        </p>
        <div className="cc-calendar-detail" data-selected-date={view.selectedDate ?? ""} aria-live="polite">
          {view.view === "month" &&
            (view.selectedDate === undefined
              ? t("widgets.calendar.selectADay")
              : eventsOnDay(read.events, view.selectedDate).length === 0
                ? t("widgets.calendar.noEventsThatDay")
                : dayList(view.selectedDate))}
          {selectedEvent !== undefined
            ? eventDetail(selectedEvent)
            : view.view !== "month" && <span className="cc-freshness">{t("widgets.calendar.selectAnEvent")}</span>}
        </div>
        {shownNotes.map((note) => (
          <p key={note} className="cc-freshness" data-calendar-note="true" style={{ margin: 0 }}>
            {note}
          </p>
        ))}
        {showsLocal && <span className="cc-freshness">{t("widgets.calendar.localOnlyNotice")}</span>}
      </div>
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
function Carousel({ props, imageUrl, state, onAction, onStateChange }: RendererProps): ReactElement {
  const t = useT();
  const refs = pictureRefs(props.imageRefs);
  const alts = pictureAlts(props.alts, refs.length);
  const [index, setIndex] = useStoredSelection(state, refs.length);
  const current = refs.length === 0 ? 0 : Math.min(index, refs.length - 1);
  const select = (next: number) => {
    setIndex(next);
    onStateChange?.({ selectedIndex: next });
    onAction?.("media.select", { selectedIndex: next });
  };
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
              onClick={() => select(current <= 0 ? refs.length - 1 : current - 1)}
            >
              ‹
            </button>
            <span className="cc-freshness" aria-live="polite">
              {current + 1}/{refs.length}
            </span>
            <button type="button" aria-label={t("widgets.carousel.next")} onClick={() => select((current + 1) % refs.length)}>
              ›
            </button>
          </div>
          )}
        </div>
      )}
      <ViewMessage state={state} name="carousel" />
    </Frame>
  );
}

/**
 * The picture a carousel or gallery shows, as the node holds it, adopted whenever that changes; between those, what the
 * person just chose is drawn at once. A refusal counts up `viewReset`, so a choice the node refused is undrawn even when
 * the picture it holds did not move.
 */
function useStoredSelection(state: Record<string, unknown> | undefined, count: number): [number, (next: number) => void] {
  const stored = readMediaSelection(state, count).selectedIndex;
  const storedKey = `${String(stored)}#${String(state?.viewReset ?? 0)}`;
  const [selected, setSelected] = useState(stored);
  const [syncedKey, setSyncedKey] = useState(storedKey);
  if (syncedKey !== storedKey) {
    setSyncedKey(storedKey);
    setSelected(stored);
  }
  return [selected, setSelected];
}

/** Why the node refused this widget's last change, said beside it; the widget already draws what the node holds. */
function ViewMessage({ state, name }: { state: Record<string, unknown> | undefined; name: string }): ReactElement | null {
  if (typeof state?.message !== "string" || state.message === "") return null;
  return (
    <p className="cc-freshness" role="status" data-media-message={name} style={{ margin: 0 }}>
      {state.message}
    </p>
  );
}

/** The same pictures as a grid, for when seeing them together is the point. */
function Gallery({ props, imageUrl, state, onAction, onStateChange }: RendererProps): ReactElement {
  const t = useT();
  const refs = pictureRefs(props.imageRefs);
  const alts = pictureAlts(props.alts, refs.length);
  const [selectedIndex, setSelectedIndex] = useStoredSelection(state, refs.length);
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
          {shown.map((picture) => {
            const index = refs.indexOf(picture.ref);
            const selected = index === selectedIndex;
            return (
            <li key={picture.ref}>
              <figure className="cc-image">
                {/* The button holds only the picture: a figure and its caption are not phrasing content. */}
                <button
                  type="button"
                  className="cc-gallery-select"
                  aria-label={picture.alt || fillMessage(t("widgets.gallery.pictureOf"), { number: String(index + 1), count: String(refs.length) })}
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedIndex(index);
                    onStateChange?.({ selectedIndex: index });
                    onAction?.("media.select", { selectedIndex: index });
                  }}
                >
                  <img src={picture.url} alt={picture.alt} loading="lazy" decoding="async" data-image-ref={picture.ref} />
                </button>
                {picture.alt !== "" && <figcaption className="cc-freshness">{picture.alt}</figcaption>}
              </figure>
            </li>
            );
          })}
        </ul>
      )}
      <ViewMessage state={state} name="gallery" />
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
/**
 * The playback state a host-held player keeps on its node, shared by the video and the audio player.
 *
 * What it writes goes through the shared coalescer: pause, seek and end at once, a playing clock at most every
 * interval, and the last position when the page goes away. The stored position is applied once, when the player first
 * knows its duration; the seek that causes is the host's own state coming back, so it is not written again. A restore
 * never starts playback: `play()` is called only for a press of the host's own Play button that arrived before the
 * bytes did (see `usePlayerSource`), and only while that press is still current (`pressStillCurrent`). Starting a
 * player pauses any other host player that was playing: there is one active playback owner.
 */
function useMediaPlayback<E extends HTMLMediaElement>(
  state: Record<string, unknown> | undefined,
  onAction: RendererProps["onAction"],
  /**
   * When the person pressed play before the bytes were read, how many players had started by then
   * (`playbackOwner.starts()`); `undefined` when nobody pressed.
   */
  pressedPlay: { current: number | undefined },
): {
  mediaRef: { current: E | null };
  handlers: {
    onLoadedMetadata: (event: { currentTarget: E }) => void;
    onPlay: (event: { currentTarget: E }) => void;
    onPlaying: (event: { currentTarget: E }) => void;
    onTimeUpdate: (event: { currentTarget: E }) => void;
    onPause: (event: { currentTarget: E }) => void;
    onSeeked: (event: { currentTarget: E }) => void;
    onEnded: (event: { currentTarget: E }) => void;
  };
} {
  const callbackRef = useRef(onAction);
  callbackRef.current = onAction;
  const restored = useRef(false);
  const restoringSeek = useRef(false);
  const playback = readMediaPlayback(state);
  // Made once for the player's life: it remembers what was last written, so a new one each render would forget it.
  const [coalescer] = useState<PlaybackCoalescer>(() => createPlaybackCoalescer({
    // Where the player is changes nothing else on the page, so it goes as the state-only write.
    write: (next, { leaving }) => callbackRef.current?.(MEDIA_VIEW_OPERATION, { ...next }, leaving ? { leaving: true, stateOnly: true } : { stateOnly: true }),
  }));
  // Where the player last said it was, kept for when it goes away: by then the element itself may be gone.
  const lastKnown = useRef<MediaPlaybackState | undefined>(undefined);
  const mediaRef = useRef<E>(null);
  const playbackFrom = (media: E, status: MediaPlaybackState["status"]): MediaPlaybackState => ({
    status,
    position: Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0,
    duration: Number.isFinite(media.duration) ? Math.max(0, media.duration) : 0,
  });
  const clockStatus = (media: E): MediaPlaybackState["status"] => (media.ended ? "ended" : media.paused ? "paused" : "playing");
  const report = (next: MediaPlaybackState, reason: PlaybackWriteReason): void => {
    lastKnown.current = next;
    coalescer.report(next, reason);
  };
  useEffect(
    () =>
      flushPlaybackOnLeave({
        page: window,
        document,
        read: () => {
          const media = mediaRef.current;
          return media === null || lastKnown.current === undefined ? lastKnown.current : playbackFrom(media, clockStatus(media));
        },
        report: coalescer.report,
      }),
    // The player, its coalescer and the page are fixed for this widget's life.
    [coalescer],
  );
  // A refused write leaves the node holding something other than what this page sent, so the next report is written
  // even when it says the same. The player is not moved to the node's position: what it shows is where it really is.
  const viewReset = typeof state?.viewReset === "number" ? state.viewReset : 0;
  useEffect(() => coalescer.forget(), [coalescer, viewReset]);
  const restorePosition = (media: E): void => {
    if (restored.current || media.readyState < HTMLMediaElement.HAVE_METADATA) return;
    restored.current = true;
    if (playback.position > 0 && Number.isFinite(media.duration)) {
      restoringSeek.current = true;
      media.currentTime = Math.min(playback.position, media.duration);
    }
  };
  return {
    mediaRef,
    handlers: {
      onLoadedMetadata: (event) => {
        const media = event.currentTarget;
        restorePosition(media);
        const pressedAt = pressedPlay.current;
        if (pressedAt === undefined) return;
        pressedPlay.current = undefined;
        // The person pressed play while the bytes were on their way: this is their press arriving, not autoplay, and it
        // starts from the restored position. Not if they have since started another player or moved on: then the
        // player stays paused. A browser that still refuses leaves it paused where it is.
        const current = pressStillCurrent({
          pressedAt,
          startsNow: playbackOwner.starts(),
          active: document.activeElement,
          body: document.body,
          media,
        });
        if (current) void media.play().catch(() => undefined);
      },
      onPlay: (event) => playbackOwner.claim(event.currentTarget),
      onPlaying: (event) => report(playbackFrom(event.currentTarget, "playing"), "playing"),
      onTimeUpdate: (event) => {
        // The restore seek reports the clock before it settles; that is the node's own position coming back.
        if (!restoringSeek.current) report(playbackFrom(event.currentTarget, clockStatus(event.currentTarget)), "timeupdate");
      },
      onPause: (event) => {
        if (!event.currentTarget.ended) report(playbackFrom(event.currentTarget, "paused"), "pause");
      },
      onSeeked: (event) => {
        if (restoringSeek.current) {
          restoringSeek.current = false;
          return;
        }
        report(playbackFrom(event.currentTarget, clockStatus(event.currentTarget)), "seek");
      },
      onEnded: (event) => report(playbackFrom(event.currentTarget, "ended"), "ended"),
    },
  };
}

/**
 * Where a player's source is: drawable, not read yet (or still being read), named but refused when read, or not
 * available at all.
 */
type PlayerSource = { kind: "ready"; url: string } | { kind: "waiting" } | { kind: "failed" } | { kind: "unavailable" };

/**
 * A player's source, read only when it is needed, shared by the video and the audio player.
 *
 * With a host that reads player bytes on request (`mediaUrls`), nothing is fetched until the player comes near the
 * screen or the person presses the host's Play button that stands in for the player meanwhile. Pressing it says so
 * honestly - "loading", with no invented progress - and once the bytes arrive the real player takes its place, takes the
 * keyboard focus the button had, restores the stored position and then plays, because the person asked it to. A host
 * without `mediaUrls` (a library preview) resolves through `imageUrl` as before.
 */
function usePlayerSource(
  ref: string,
  imageUrl: RendererProps["imageUrl"],
  mediaUrls: RendererProps["mediaUrls"],
): {
  source: PlayerSource;
  started: boolean;
  start: () => void;
  observe: (element: Element | null) => void;
  pressedPlay: { current: number | undefined };
} {
  const [element, observe] = useState<Element | null>(null);
  const [started, setStarted] = useState(false);
  const pressedPlay = useRef<number | undefined>(undefined);
  const status = ref === "" ? "unlisted" : mediaUrls?.status(ref);
  const waiting = status === "idle" || status === "loading";
  const near = useNearViewport(element, mediaUrls !== undefined && waiting && !started);
  useEffect(() => {
    if (mediaUrls !== undefined && status === "idle" && (near || started)) mediaUrls.request(ref);
  }, [mediaUrls, near, ref, started, status]);
  const start = useCallback(() => {
    pressedPlay.current = playbackOwner.starts();
    setStarted(true);
  }, []);

  let source: PlayerSource;
  if (mediaUrls === undefined) {
    const url = ref === "" ? undefined : imageUrl?.(ref);
    source = url === undefined ? { kind: "unavailable" } : { kind: "ready", url };
  } else if (status === "ready") {
    const url = mediaUrls.get(ref);
    source = url === undefined ? { kind: "unavailable" } : { kind: "ready", url };
  } else if (waiting) {
    source = { kind: "waiting" };
  } else if (status === "failed") {
    source = { kind: "failed" };
  } else {
    source = { kind: "unavailable" };
  }
  return { source, started, start, observe, pressedPlay };
}

/**
 * Hands the keyboard to what replaces the Play button the person pressed: the real player, or the message that says it
 * could not be read.
 *
 * Only when focus was left with nobody (the button it was on is gone): a person who moved on while the bytes were on
 * their way keeps the focus where they put it.
 */
function useFocusWhenShown(target: { current: HTMLElement | null }, shown: boolean, started: boolean): void {
  useEffect(() => {
    if (!shown || !started) return;
    const active = document.activeElement;
    if (active === null || active === document.body) target.current?.focus();
  }, [target, shown, started]);
}

/**
 * Said in place of a player whose bytes the node did not give: what failed, that nothing else changed, and how to try
 * again. A polite status, and the keyboard moves to it when it replaces the Play button the person pressed, so the
 * failure is heard either way rather than focus falling to the page.
 */
function PlayerFailed({ message, started }: { message: string; started: boolean }): ReactElement {
  const ref = useRef<HTMLParagraphElement>(null);
  useFocusWhenShown(ref, true, started);
  return (
    <p ref={ref} className="cc-freshness" role="status" tabIndex={-1} data-media-failed="" style={{ margin: 0 }}>
      {message}
    </p>
  );
}

/**
 * What stands in for a player whose bytes are not read yet: its poster when it has one, the host's own Play button, and
 * a polite status that says the bytes are loading once the person pressed it.
 *
 * The button stays focusable while loading (`aria-disabled`, not `disabled`), so the focus that pressed it is not
 * dropped; a second press does nothing.
 */
function PlayerWaiting(props: {
  name: "video" | "audio";
  /** The host reference the player will read, said on the element like the player's own `data-*-ref`. */
  reference: string;
  title: string;
  started: boolean;
  onStart: () => void;
  observe: (element: Element | null) => void;
  poster?: string | undefined;
  caption: ReactNode;
}): ReactElement {
  const t = useT();
  const play = props.name === "video" ? t("widgets.video.play") : t("widgets.audio.play");
  const loading = props.name === "video" ? t("widgets.video.loading") : t("widgets.audio.loading");
  const button = (
    <button
      type="button"
      className="cc-action"
      data-media-play={props.name}
      aria-label={`${play}: ${props.title}`}
      aria-disabled={props.started}
      onClick={() => {
        if (!props.started) props.onStart();
      }}
    >
      {play}
    </button>
  );
  return (
    <figure
      ref={props.observe}
      className={`cc-${props.name} cc-media-wait`}
      data-media-state={props.started ? "loading" : "waiting"}
      data-media-ref={props.reference}
      {...(props.name === "audio" ? { "data-audio-state": props.started ? "loading" : "waiting" } : {})}
    >
      {props.name === "video" ? (
        // The box the video will fill, so its arrival moves nothing below it.
        <div className="cc-media-stage">
          {props.poster !== undefined && <img src={props.poster} alt="" data-media-poster="" />}
          {button}
        </div>
      ) : (
        button
      )}
      <p className="cc-freshness" role="status" aria-live="polite" data-media-loading={props.name}>
        {props.started ? loading : ""}
      </p>
      {props.caption}
    </figure>
  );
}

function LocalVideo({ props, imageUrl, mediaUrls, state, onAction }: RendererProps): ReactElement {
  const t = useT();
  const ref = String(props.videoRef ?? "");
  const alt = String(props.alt ?? "");
  const title = String(props.title ?? t("widgets.video.title"));
  const posterRef = typeof props.posterRef === "string" ? props.posterRef : "";
  const { source, started, start, observe, pressedPlay } = usePlayerSource(ref, imageUrl, mediaUrls);
  const poster = posterRef === "" ? undefined : imageUrl?.(posterRef);
  const { mediaRef, handlers } = useMediaPlayback<HTMLVideoElement>(state, onAction, pressedPlay);
  useFocusWhenShown(mediaRef, source.kind === "ready", started);

  return (
    <Frame title={title} dataset={undefined} role="media">
      {source.kind === "unavailable" ? (
        <Unavailable reason={t("widgets.video.notPlayable").replace("{alt}", alt)} />
      ) : source.kind === "failed" ? (
        <PlayerFailed message={t("widgets.video.readFailed").replace("{alt}", alt)} started={started} />
      ) : source.kind === "waiting" ? (
        <PlayerWaiting
          name="video"
          reference={ref}
          title={alt === "" ? title : alt}
          started={started}
          onStart={start}
          observe={observe}
          poster={poster}
          caption={<figcaption className="cc-freshness">{alt}</figcaption>}
        />
      ) : (
        <figure className="cc-video" data-media-state="ready">
          <video
            controls
            preload="metadata"
            ref={mediaRef}
            {...handlers}
            src={source.url}
            {...(poster === undefined ? {} : { poster })}
            aria-label={alt}
            data-video-ref={ref}
          />
          <figcaption className="cc-freshness">{alt}</figcaption>
        </figure>
      )}
      <ViewMessage state={state} name="video" />
    </Frame>
  );
}

/** Minutes and seconds, as a player shows them. */
function clockText(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${rest}` : `${String(minutes)}:${rest}`;
}

/**
 * An audio file the node holds, played by the browser's own controls.
 *
 * The source is a host reference resolved through the node like a picture, but only once it is needed (see
 * `usePlayerSource`); the page never fetches anything else. The transcript is text, drawn with any hidden character
 * marked. It never plays by itself, on first draw or on restore.
 */
function LocalAudio({ props, imageUrl, mediaUrls, state, onAction }: RendererProps): ReactElement {
  const t = useT();
  const audio = readAudio(props);
  const { source, started, start, observe, pressedPlay } = usePlayerSource(audio?.audioRef ?? "", imageUrl, mediaUrls);
  const { mediaRef, handlers } = useMediaPlayback<HTMLAudioElement>(state, onAction, pressedPlay);
  useFocusWhenShown(mediaRef, source.kind === "ready", started);
  const describe = useCallback(
    (hidden: HiddenCharacter) => t(HIDDEN_TITLE[hidden.kind]).replace("{codePoint}", hidden.codePoint),
    [t],
  );
  const title = audio?.title ?? t("widgets.audio.title");
  const facts = audio === undefined
    ? []
    : [
        ...(audio.durationSeconds === undefined ? [] : [clockText(audio.durationSeconds)]),
        ...(audio.sizeBytes === undefined ? [] : [formatFileSize(audio.sizeBytes)]),
        ...(audio.sourceOrigin === undefined ? [] : [t("widgets.audio.from").replace("{origin}", audio.sourceOrigin)]),
      ];

  return (
    <Frame title={title} dataset={undefined} role="audio">
      {audio === undefined ? (
        <Unavailable reason={t("widgets.audio.unreadable")} />
      ) : source.kind === "unavailable" ? (
        <Unavailable reason={t("widgets.audio.notPlayable").replace("{title}", audio.title)} />
      ) : source.kind === "failed" ? (
        <PlayerFailed message={t("widgets.audio.readFailed").replace("{title}", audio.title)} started={started} />
      ) : source.kind === "waiting" ? (
        <PlayerWaiting
          name="audio"
          reference={audio.audioRef}
          title={audio.title}
          started={started}
          onStart={start}
          observe={observe}
          caption={facts.length > 0 && <figcaption className="cc-freshness">{facts.join(" · ")}</figcaption>}
        />
      ) : (
        <figure className="cc-audio" data-audio-state="ready" data-media-state="ready">
          <audio controls preload="metadata" ref={mediaRef} {...handlers} src={source.url} aria-label={audio.title} data-audio-ref={audio.audioRef} />
          {facts.length > 0 && <figcaption className="cc-freshness">{facts.join(" · ")}</figcaption>}
        </figure>
      )}
      {audio?.transcript !== undefined && (
        <details className="cc-audio-transcript">
          <summary>{t("widgets.audio.transcript")}</summary>
          {/* A region a keyboard can reach and scroll, named for what it holds. */}
          <p className="cc-audio-transcript-text" data-audio-transcript="" tabIndex={0} role="region" aria-label={t("widgets.audio.transcript")}>
            {withHiddenMarkers(audio.transcript, describe)}
          </p>
        </details>
      )}
      <ViewMessage state={state} name="audio" />
    </Frame>
  );
}

/**
 * A text preview of a PDF or text file, in the pages the node cut it into.
 *
 * The text is drawn as text, with any hidden character marked; nothing from the file is ever parsed as markup or run.
 * The page shown is the one the node holds, adopted whenever that changes; a page the person turns to is drawn at once
 * and written through the media view, and a refused write puts back the page the node holds.
 */
function DocumentPreview({ props, state, onAction, onStateChange }: RendererProps): ReactElement {
  const t = useT();
  const preview = readDocument(props);
  const pageCount = preview?.pages.length ?? 0;
  const stored = readDocumentPage(state, pageCount);
  const storedKey = `${String(stored)}#${String(state?.viewReset ?? 0)}`;
  const [page, setPage] = useState(stored);
  const [syncedKey, setSyncedKey] = useState(storedKey);
  if (syncedKey !== storedKey) {
    setSyncedKey(storedKey);
    setPage(stored);
  }
  const describe = useCallback(
    (hidden: HiddenCharacter) => t(HIDDEN_TITLE[hidden.kind]).replace("{codePoint}", hidden.codePoint),
    [t],
  );
  const current = Math.min(page, Math.max(0, pageCount - 1));
  const text = preview?.pages[current] ?? "";
  const body = useMemo(() => withHiddenMarkers(text, describe), [text, describe]);
  const hidden = useMemo(() => hiddenCharacterSegments(text).filter((segment) => !("text" in segment)).length, [text]);
  const pageRef = useRef<HTMLDivElement | null>(null);
  // A new page starts at its top, not where the last one was scrolled to.
  useEffect(() => {
    if (pageRef.current !== null) pageRef.current.scrollTop = 0;
  }, [current]);
  if (preview === undefined) {
    return <ViewerUnreadable title={t("widgets.document.title")} role="document" message={t("widgets.document.unreadable")} />;
  }
  const turn = (next: number): void => {
    setPage(next);
    onStateChange?.({ page: next });
    onAction?.(MEDIA_VIEW_OPERATION, { page: next });
  };
  const position = t("widgets.document.position").replace("{page}", String(current + 1)).replace("{count}", String(pageCount));
  const meta = [
    ...(preview.sourcePages === undefined ? [] : [t("widgets.document.sourcePages").replace("{count}", String(preview.sourcePages))]),
    t("widgets.document.chars").replace("{count}", String(preview.totalChars)),
  ].join(" · ");
  return (
    <Frame title={preview.title ?? preview.name} dataset={undefined} role="document">
      <div className="cc-viewer-head cc-document-head">
        <span className="cc-viewer-name">{preview.name}</span>
        <span className="cc-viewer-meta">{meta}</span>
      </div>
      {hidden > 0 && (
        <p className="cc-freshness cc-viewer-hidden" data-viewer-hidden={hidden} style={{ margin: 0 }}>
          {t("widgets.document.hidden").replace("{count}", String(hidden))}
        </p>
      )}
      <div
        ref={pageRef}
        className="cc-viewer-scroll cc-document-page"
        // Reachable without a pointer: a long page that only a mouse can scroll hides its end from a keyboard.
        tabIndex={0}
        role="region"
        aria-label={t("widgets.document.region").replace("{name}", preview.name).replace("{position}", position)}
        data-document-page={current}
      >
        <p className="cc-document-text">{body}</p>
      </div>
      {preview.truncated && (
        <p className="cc-freshness" data-document-truncated="">
          {t("widgets.document.truncated").replace("{shown}", String(preview.pages.reduce((sum, entry) => sum + Array.from(entry).length, 0))).replace("{total}", String(preview.totalChars))}
        </p>
      )}
      {pageCount > 1 && (
        <nav className="cc-document-nav" aria-label={t("widgets.document.paging")}>
          {/* aria-disabled rather than disabled: a button that becomes disabled under the keyboard would drop focus to the page. */}
          <button type="button" className="cc-action" aria-disabled={current === 0} onClick={() => { if (current > 0) turn(current - 1); }} data-document-turn="previous">
            {t("widgets.document.previous")}
          </button>
          <span className="cc-freshness" aria-live="polite" data-document-position="">
            {position}
          </span>
          <button type="button" className="cc-action" aria-disabled={current >= pageCount - 1} onClick={() => { if (current < pageCount - 1) turn(current + 1); }} data-document-turn="next">
            {t("widgets.document.next")}
          </button>
        </nav>
      )}
      <ViewMessage state={state} name="document" />
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
            className="cc-icon"
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

/** How much of a text file the card shows. The rest is one Save As away, and the card says so. */
const FILE_PREVIEW_TEXT_BYTES = 64 * 1024;

type FilePreview =
  | { state: "closed" }
  | { state: "opening" }
  | { state: "text"; text: string; cut: boolean }
  | { state: "image"; url: string }
  | { state: "none" }
  | { state: "failed"; reason: string };

/**
 * A file named and described.
 *
 * Without an artifact it has no link, no open and no download, and says so rather than drawing a dead button. With one,
 * the host lends it Open — a preview drawn by the page from bytes the node sends as the person, never a link the card
 * follows — and Save As, which the person drives.
 */
function FileViewerView({ props, artifactFiles }: RendererProps): ReactElement {
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
      {card.artifactRef === undefined ? (
        <p className="cc-freshness" data-file-named-only="true" style={{ margin: 0 }}>
          {t("widgets.file.namedOnly")}
        </p>
      ) : artifactFiles === undefined ? (
        <p className="cc-freshness" data-file-no-host="true" style={{ margin: 0 }}>
          {t("widgets.file.noHost")}
        </p>
      ) : (
        <FileArtifactControls artifactRef={card.artifactRef} name={card.name} host={artifactFiles} />
      )}
    </Frame>
  );
}

/** Open and Save As for one artifact, and what either one did. */
function FileArtifactControls({ artifactRef, name, host }: { artifactRef: ArtifactRef; name: string; host: ArtifactFileHost }): ReactElement {
  const t = useT();
  const previewId = useId();
  const [preview, setPreview] = useState<FilePreview>({ state: "closed" });
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ tone: "ok" | "failed"; text: string } | undefined>(undefined);
  const imageUrl = preview.state === "image" ? preview.url : undefined;
  useEffect(() => (imageUrl === undefined ? undefined : () => URL.revokeObjectURL(imageUrl)), [imageUrl]);

  // Worded by the refusal's code in the person's language, never an error's own text: that may name a path on disk.
  const reasonOf = (cause: unknown): string => artifactReason(cause, t);

  const open = async (): Promise<void> => {
    setPreview({ state: "opening" });
    try {
      const blob = await host.open(artifactRef);
      // The type is the node's, from the artifact's record, not the card's words or the blob's own guess.
      const type = artifactRef.mimeType;
      if (type.startsWith("image/")) {
        setPreview({ state: "image", url: URL.createObjectURL(blob) });
      } else if (type.startsWith("text/") || type === "application/json") {
        const text = await blob.slice(0, FILE_PREVIEW_TEXT_BYTES).text();
        setPreview({ state: "text", text, cut: blob.size > FILE_PREVIEW_TEXT_BYTES });
      } else {
        setPreview({ state: "none" });
      }
    } catch (cause) {
      setPreview({ state: "failed", reason: reasonOf(cause) });
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveNote(undefined);
    try {
      const outcome = await host.saveAs(artifactRef, artifactRef.name);
      // A browser download has only started, so it is said as that rather than as saved.
      if (outcome.outcome !== "cancelled") {
        const said = outcome.outcome === "downloaded" ? "widgets.file.downloaded" : "widgets.file.saved";
        setSaveNote({ tone: "ok", text: t(said).replace("{name}", outcome.name) });
      }
    } catch (cause) {
      setSaveNote({ tone: "failed", text: t("widgets.file.saveFailed").replace("{reason}", reasonOf(cause)) });
    } finally {
      setSaving(false);
    }
  };

  const expanded = preview.state !== "closed";
  return (
    <div className="cc-viewer-file-artifact" data-file-artifact={artifactRef.artifactId}>
      <div className="cc-viewer-file-actions">
        <button
          type="button"
          className="cc-viewer-file-button"
          data-file-open="true"
          aria-expanded={expanded}
          aria-controls={previewId}
          disabled={preview.state === "opening"}
          onClick={() => (expanded ? setPreview({ state: "closed" }) : void open())}
        >
          {preview.state === "opening" ? t("widgets.file.opening") : expanded ? t("widgets.file.closePreview") : t("widgets.file.open")}
        </button>
        <button type="button" className="cc-viewer-file-button" data-file-save="true" disabled={saving} onClick={() => void save()}>
          {saving ? t("widgets.file.saving") : t("widgets.file.saveAs")}
        </button>
      </div>
      {saveNote !== undefined && (
        <p
          className="cc-freshness"
          data-file-save-state={saveNote.tone}
          role={saveNote.tone === "failed" ? "alert" : "status"}
          style={{ margin: 0 }}
        >
          {saveNote.text}
        </p>
      )}
      <div id={previewId} data-file-preview={preview.state} hidden={!expanded || preview.state === "opening"}>
        {preview.state === "text" && (
          <>
            <pre className="cc-viewer-file-preview" tabIndex={0} aria-label={t("widgets.file.previewLabel").replace("{name}", name)}>
              {preview.text}
            </pre>
            {preview.cut && (
              <p className="cc-freshness" style={{ margin: 0 }}>
                {t("widgets.file.previewCut")}
              </p>
            )}
          </>
        )}
        {preview.state === "image" && (
          <img className="cc-viewer-file-image" src={preview.url} alt={t("widgets.file.previewLabel").replace("{name}", name)} />
        )}
        {preview.state === "none" && (
          <p className="cc-freshness" style={{ margin: 0 }}>
            {t("widgets.file.noPreview")}
          </p>
        )}
        {preview.state === "failed" && (
          <p className="cc-freshness" data-file-open-failed="true" role="alert" style={{ margin: 0 }}>
            {t("widgets.file.openFailed").replace("{reason}", preview.reason)}
          </p>
        )}
      </div>
    </div>
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

const TREE_ICON_GLYPHS: Record<string, string> = {
  branch: "◇",
  document: "▤",
  folder: "▱",
  group: "◫",
  person: "◉",
  project: "⌘",
  task: "□",
};

function TreeWidgetView({ props, state, onAction, onStateChange }: RendererProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const tree = useMemo(() => readTree(props), [props]);
  const stored = useMemo(() => (tree === undefined ? undefined : readTreeState(state, tree)), [state, tree]);
  const [treeState, setTreeState] = useState(stored);
  const [focusedId, setFocusedId] = useState(() => tree?.nodes[0]?.id ?? "");
  const rows = useRef(new Map<string, HTMLDivElement>());
  const typeahead = useRef("");
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => setTreeState(stored), [stored]);
  useEffect(() => {
    if (tree !== undefined && !visibleTreeNodes(tree.nodes, new Set(stored?.expandedIds ?? [])).some((row) => row.node.id === focusedId)) {
      setFocusedId(visibleTreeNodes(tree.nodes, new Set(stored?.expandedIds ?? []))[0]?.node.id ?? "");
    }
  }, [focusedId, stored, tree]);
  useEffect(() => () => clearTimeout(typeaheadTimer.current), []);

  const title = typeof props.title === "string" && props.title !== "" ? props.title : t("widgets.tree.title");
  if (tree === undefined || treeState === undefined) {
    return (
      <Frame title={title} dataset={undefined} role="group">
        <p className="cc-freshness" data-tree-state="error" role="status" style={{ margin: 0 }}>{t("widgets.tree.unreadable")}</p>
      </Frame>
    );
  }
  const expanded = new Set(treeState.expandedIds);
  const visible = visibleTreeNodes(tree.nodes, expanded);
  const helpId = useId();
  const focusRow = (id: string): void => {
    setFocusedId(id);
    rows.current.get(id)?.focus();
  };
  const updateState = (next: typeof treeState): void => {
    setTreeState(next);
    onStateChange?.({ ...next });
  };
  const selectNode = (id: string): void => {
    updateState({ ...treeState, selectedId: id });
    onAction?.(TREE_SELECT_OPERATION, { selectedId: id });
  };
  const setExpanded = (id: string, open: boolean): void => {
    const nextIds = open ? [...new Set([...treeState.expandedIds, id])] : treeState.expandedIds.filter((entry) => entry !== id);
    updateState({ ...treeState, expandedIds: nextIds });
    onAction?.(TREE_TOGGLE_OPERATION, { nodeId: id, expanded: open });
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>, row: VisibleTreeNode): void => {
    const child = row.node.children?.[0];
    let target = treeFocusTarget(event.key, visible, row.node.id);
    switch (event.key) {
      case "ArrowRight":
        if ((row.node.children?.length ?? 0) > 0 && !row.expanded) setExpanded(row.node.id, true);
        else if (row.expanded) target = child?.id;
        break;
      case "ArrowLeft":
        if (row.expanded) setExpanded(row.node.id, false);
        else target = row.parentId;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        selectNode(row.node.id);
        return;
      default:
        if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          typeahead.current += event.key.toLocaleLowerCase(locale);
          if ([...typeahead.current].every((character) => character === typeahead.current[0])) typeahead.current = event.key.toLocaleLowerCase(locale);
          clearTimeout(typeaheadTimer.current);
          typeaheadTimer.current = setTimeout(() => { typeahead.current = ""; }, 700);
          target = treeTypeaheadTarget(visible, row.node.id, typeahead.current, locale);
        }
        break;
    }
    if (target !== undefined) {
      event.preventDefault();
      focusRow(target);
    }
  };
  const renderNodes = (nodes: readonly TreeNode[], level: number, parentId?: string): ReactNode => (
    <ul className={level === 1 ? "cc-tree-root" : "cc-tree-group"} role={level === 1 ? "tree" : "group"} aria-label={level === 1 ? title : undefined}>
      {nodes.map((node, index) => {
        const hasChildren = (node.children?.length ?? 0) > 0;
        const isExpanded = expanded.has(node.id);
        const isSelected = treeState.selectedId === node.id;
        const current: VisibleTreeNode = { node, level, position: index + 1, setSize: nodes.length, ...(parentId === undefined ? {} : { parentId }), expanded: isExpanded };
        const tabStop = focusedId === node.id || (focusedId === "" && visible[0]?.node.id === node.id);
        return (
          <li key={node.id} className="cc-tree-item" role="none" data-tree-item={node.id}>
            <div
              ref={(element) => { if (element === null) rows.current.delete(node.id); else rows.current.set(node.id, element); }}
              className="cc-tree-row"
              role="treeitem"
              tabIndex={tabStop ? 0 : -1}
              aria-level={level}
              aria-posinset={index + 1}
              aria-setsize={nodes.length}
              aria-expanded={hasChildren ? isExpanded : undefined}
              aria-selected={isSelected}
              aria-describedby={helpId}
              data-tree-row={node.id}
              data-selected={isSelected ? "true" : undefined}
              onFocus={() => setFocusedId(node.id)}
              onClick={(event) => { if ((event.target as HTMLElement).closest("[data-tree-disclosure]") !== null) return; selectNode(node.id); }}
              onKeyDown={(event) => keyDown(event, current)}
            >
              {hasChildren ? (
                <span
                  className="cc-tree-disclosure"
                  aria-hidden="true"
                  data-tree-disclosure="true"
                  onClick={(event) => { event.stopPropagation(); setExpanded(node.id, !isExpanded); }}
                >
                  {isExpanded ? "▾" : "▸"}
                </span>
              ) : <span className="cc-tree-disclosure-spacer" aria-hidden="true" />}
              {node.icon !== undefined && <span className="cc-tree-icon" aria-hidden="true">{TREE_ICON_GLYPHS[node.icon] ?? "◇"}</span>}
              <span className="cc-tree-label">{node.label}</span>
              {node.secondary !== undefined && node.secondary !== "" && <span className="cc-tree-secondary">{node.secondary}</span>}
            </div>
            {hasChildren && isExpanded && renderNodes(node.children ?? [], level + 1, node.id)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <Frame title={title} dataset={undefined} role="group">
      {tree.nodes.length === 0 ? (
        <p className="cc-freshness" data-tree-state="empty" role="status" style={{ margin: 0 }}>{t("widgets.tree.empty")}</p>
      ) : (
        <>
          <span id={helpId} className="cc-sr-only">{t("widgets.tree.keyboardHelp")}</span>
          {renderNodes(tree.nodes, 1)}
        </>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Map
 * ------------------------------------------------------------------ */

/** Whether motion is reduced here: the person's own setting on the page or a Lab subtree, or the system's. */
function motionReduced(element: Element | null): boolean {
  if (element?.closest('[data-cc-reduced-motion="true"]') != null) return true;
  if (typeof document !== "undefined" && document.body?.dataset.ccReducedMotion === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** How long a moved map waits before the view it settled on is written, so a run of key presses is one write. */
const MAP_VIEW_WRITE_DELAY_MS = 400;
/** Point labels are drawn on the map up to this many points; past it the table names them and the map would be noise. */
const MAP_POINT_LABELS = 12;
/** Tile pictures one map keeps; past this the least recently drawn that are not on screen are let go. */
const MAP_TILE_PICTURES = 96;
/** How long the view must stay still before its tiles are asked for, so a run of zooms asks only for where it stops. */
const MAP_TILE_SETTLE_MS = 150;
/** How long a tile the node could not give (busy, or the provider failed) waits before it is asked for again. */
const MAP_TILE_RETRY_MS = 4_000;

/** A value that follows another once it has stayed the same for a while. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
function MapWidgetView(rendererProps: RendererProps): ReactElement {
  const t = useT();
  const map = useMemo(() => readMap(rendererProps.props), [rendererProps.props]);
  const title = typeof rendererProps.props.title === "string" && rendererProps.props.title !== "" ? rendererProps.props.title : t("widgets.map.title");
  if (map === undefined) {
    return (
      <Frame title={title} dataset={undefined} role="group">
        <p className="cc-freshness" data-map-state="error" role="status" style={{ margin: 0 }}>{t("widgets.map.unreadable")}</p>
      </Frame>
    );
  }
  return <MapCanvas {...rendererProps} map={map} title={title} />;
}

function tileAddress(placement: MapTilePlacement): string {
  return `${String(placement.z)}/${String(placement.x)}/${String(placement.y)}`;
}

/** A tile the provider does not have: asking again will not help. Anything else (busy, failed) is asked again later. */
function tileMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "status" in cause && cause.status === 404;
}

/**
 * The tiles the node's policy allows for this view, as picture URLs, and whether any could not be loaded.
 *
 * Tiles already held are drawn at once; new ones are asked for only once the view has settled, a request for a tile the
 * view has left is stopped, and a tile that failed for a passing reason is asked for again after a pause.
 */
function useMapTiles(host: MapTileHost | undefined, camera: MapCamera): {
  provider: MapTilePolicyView["provider"];
  offline: MapTilePolicyView["offline"];
  tiles: { placement: MapTilePlacement; url: string }[];
  failed: boolean;
} {
  const [provider, setProvider] = useState<MapTilePolicyView["provider"]>(null);
  const [offline, setOffline] = useState<MapTilePolicyView["offline"]>(undefined);
  // Held pictures, least recently drawn first.
  const [pictures, setPictures] = useState<ReadonlyMap<string, string>>(new Map());
  // When a failed tile may be asked for again; never, for a tile the provider does not have.
  const [failures, setFailures] = useState<ReadonlyMap<string, number>>(new Map());
  const [retryTick, setRetryTick] = useState(0);
  const loading = useRef(new Map<string, AbortController>());
  const owned = useRef(new Map<string, string>());
  const visible = useRef(new Set<string>());
  const settled = useSettled(camera, MAP_TILE_SETTLE_MS);

  useEffect(() => {
    if (host === undefined) return undefined;
    let live = true;
    // A policy that cannot be read is no policy: the map stays on its offline basemap rather than guessing.
    host.policy().then((view) => {
      if (!live) return;
      setProvider(view.provider);
      setOffline(view.provider === null ? view.offline : undefined);
    }, () => { if (live) setProvider(null); });
    return () => { live = false; };
  }, [host]);

  useEffect(() => {
    const requests = loading.current;
    const urls = owned.current;
    return () => {
      for (const request of requests.values()) request.abort();
      requests.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const placements = useMemo(() => (provider === null ? [] : visibleTiles(camera, provider.maxZoom)), [camera, provider]);
  const wanted = useMemo(() => (provider === null ? [] : visibleTiles(settled, provider.maxZoom)), [settled, provider]);
  visible.current = new Set([...placements, ...wanted].map(tileAddress));

  // What is on screen moves to the recent end, so the pictures let go first are ones the view left longest ago.
  useEffect(() => {
    setPictures((previous) => {
      const shown = wanted.map(tileAddress).filter((address) => previous.has(address));
      if (shown.length === 0) return previous;
      const next = new Map(previous);
      for (const address of shown) {
        const url = next.get(address);
        if (url === undefined) continue;
        next.delete(address);
        next.set(address, url);
      }
      return next;
    });
  }, [wanted]);

  useEffect(() => {
    if (host === undefined || provider === null) return undefined;
    const addresses = new Set(wanted.map(tileAddress));
    for (const [address, request] of loading.current) {
      if (addresses.has(address)) continue;
      request.abort();
      loading.current.delete(address);
    }
    const now = Date.now();
    let nextRetry = Infinity;
    for (const placement of wanted) {
      const address = tileAddress(placement);
      if (pictures.has(address) || loading.current.has(address)) continue;
      const retryAt = failures.get(address);
      if (retryAt !== undefined && retryAt > now) {
        nextRetry = Math.min(nextRetry, retryAt);
        continue;
      }
      const request = new AbortController();
      loading.current.set(address, request);
      host.tile(placement.z, placement.x, placement.y, request.signal).then(
        (blob) => {
          // Stopped, because the view left this tile: nothing to draw.
          if (loading.current.get(address) !== request) return;
          loading.current.delete(address);
          const url = URL.createObjectURL(blob);
          owned.current.set(address, url);
          setFailures((previous) => {
            if (!previous.has(address)) return previous;
            const next = new Map(previous);
            next.delete(address);
            return next;
          });
          setPictures((previous) => {
            const next = new Map(previous);
            next.set(address, url);
            for (const [held, heldUrl] of next) {
              if (next.size <= MAP_TILE_PICTURES) break;
              if (visible.current.has(held)) continue;
              next.delete(held);
              URL.revokeObjectURL(heldUrl);
              owned.current.delete(held);
            }
            return next;
          });
        },
        (cause: unknown) => {
          if (loading.current.get(address) !== request) return;
          loading.current.delete(address);
          setFailures((previous) => new Map(previous).set(address, tileMissing(cause) ? Infinity : Date.now() + MAP_TILE_RETRY_MS));
        },
      );
    }
    if (nextRetry === Infinity) return undefined;
    const timer = setTimeout(() => setRetryTick((tick) => tick + 1), Math.max(0, nextRetry - now));
    return () => clearTimeout(timer);
  }, [failures, host, pictures, provider, retryTick, wanted]);

  const tiles = placements.flatMap((placement) => {
    const url = pictures.get(tileAddress(placement));
    return url === undefined ? [] : [{ placement, url }];
  });
  const failed = placements.some((placement) => !pictures.has(tileAddress(placement)) && failures.has(tileAddress(placement)));
  return { provider, offline, tiles, failed };
}
function MapCanvas({ map, title, state, onAction, onStateChange, mapTiles }: RendererProps & { map: MapView; title: string }): ReactElement {
  const t = useT();
  const helpId = useId();
  const stored = useMemo(() => readMapState(state, map), [map, state]);
  const storedCamera = useMemo(() => mapCamera(map, stored), [map, stored]);
  const initialCamera = useMemo(() => mapCamera(map, {}), [map]);
  // What the node holds, adopted whenever it changes or a refusal counts up `viewReset`; between those, what the person
  // just did is drawn at once.
  const resets = String(state?.viewReset ?? 0);
  const storedKey = `${JSON.stringify(stored)}#${resets}`;
  const [syncedKey, setSyncedKey] = useState(storedKey);
  const [camera, setCamera] = useState<MapCamera>(storedCamera);
  const [selectedId, setSelectedId] = useState<string | undefined>(stored.selectedId);
  const pendingView = useRef<MapCamera | undefined>(undefined);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (syncedKey !== storedKey) {
    setSyncedKey(storedKey);
    // A view the person moved to and has not written yet stays drawn. A refusal always puts the node's view back, and
    // drops a move still waiting to be written, which the page no longer shows.
    const refused = !syncedKey.endsWith(`#${resets}`);
    if (refused) {
      clearTimeout(viewTimer.current);
      pendingView.current = undefined;
    }
    if (refused || pendingView.current === undefined) setCamera(storedCamera);
    setSelectedId(stored.selectedId);
  }

  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<SVGGElement>(null);
  const drawnCamera = useRef(camera);
  const [reduced, setReduced] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; y: number; camera: MapCamera; moved: boolean } | undefined>(undefined);
  const dragged = useRef(false);
  const { provider, offline, tiles, failed } = useMapTiles(mapTiles, camera);
  // What the live region says follows the view once it settles, not every frame of a drag or every repeated key.
  const announced = useSettled(camera, MAP_VIEW_WRITE_DELAY_MS);

  // Slide the drawing from where it was to where it is now. Not under reduced motion: the view moves at once.
  useLayoutEffect(() => {
    const from = drawnCamera.current;
    drawnCamera.current = camera;
    const group = content.current;
    const isReduced = motionReduced(viewport.current);
    if (isReduced !== reduced) setReduced(isReduced);
    if (group === null) return undefined;
    // Whatever slide was under way ends where it is going, so no run that does not slide leaves the drawing shifted.
    group.style.transition = "";
    group.style.transform = "";
    if (isReduced) return undefined;
    const shift = cameraShift(from, camera);
    if (shift === undefined || (shift[0] === 0 && shift[1] === 0) || Math.abs(shift[0]) > MAP_VIEWPORT.width || Math.abs(shift[1]) > MAP_VIEWPORT.height) {
      return undefined;
    }
    group.style.transition = "none";
    group.style.transform = `translate(${String(shift[0])}px, ${String(shift[1])}px)`;
    group.getBoundingClientRect();
    const frame = requestAnimationFrame(() => {
      group.style.transition = "transform 160ms ease-out";
      group.style.transform = "";
    });
    return () => {
      cancelAnimationFrame(frame);
      group.style.transition = "";
      group.style.transform = "";
    };
  }, [camera, reduced]);

  // The system setting can change while the map is open; what the map says about its motion follows it.
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = (): void => setReduced(motionReduced(viewport.current));
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);

  // The host hands a new callback on every render; the latest is the one a delayed write uses.
  const sendAction = useRef(onAction);
  sendAction.current = onAction;
  const writeView = useCallback((leaving: boolean): void => {
    clearTimeout(viewTimer.current);
    const next = pendingView.current;
    pendingView.current = undefined;
    if (next === undefined) return;
    sendAction.current?.(MAP_VIEW_OPERATION, { center: [next.center[0], next.center[1]], zoom: next.zoom }, leaving ? { leaving: true } : undefined);
  }, []);
  // A view still waiting when the map goes away is sent as it goes.
  useEffect(() => () => writeView(true), [writeView]);

  const moveTo = (next: MapCamera): void => {
    if (sameCamera(next, camera)) return;
    setCamera(next);
    onStateChange?.({ center: [next.center[0], next.center[1]], zoom: next.zoom });
    pendingView.current = next;
    clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => writeView(false), MAP_VIEW_WRITE_DELAY_MS);
  };

  const select = (id: string | undefined, reveal: boolean): void => {
    setSelectedId(id);
    onStateChange?.({ selectedId: id ?? "" });
    onAction?.(MAP_SELECT_OPERATION, { selectedId: id ?? "" });
    const feature = map.features.find((entry) => entry.id === id);
    if (!reveal || feature === undefined) return;
    // A place chosen from the table or the keyboard is brought into view when it is off the map's edge.
    const anchor = mapFeatureAnchor(feature);
    const [x, y] = toScreen(anchor, camera);
    const margin = MAP_VIEWPORT.padding;
    if (x < margin || x > MAP_VIEWPORT.width - margin || y < margin || y > MAP_VIEWPORT.height - margin) {
      moveTo({ center: [anchor[0], anchor[1]], zoom: camera.zoom });
    }
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? MAP_PAN_STEP * 3 : MAP_PAN_STEP;
    let handled = true;
    switch (event.key) {
      case "ArrowLeft": moveTo(panCamera(camera, -step, 0)); break;
      case "ArrowRight": moveTo(panCamera(camera, step, 0)); break;
      case "ArrowUp": moveTo(panCamera(camera, 0, -step)); break;
      case "ArrowDown": moveTo(panCamera(camera, 0, step)); break;
      case "+": case "=": moveTo(zoomCamera(camera, 1)); break;
      case "-": case "_": moveTo(zoomCamera(camera, -1)); break;
      case "0": moveTo(initialCamera); break;
      case "n": case "N": select(stepFeature(map.features, selectedId, 1), true); break;
      case "p": case "P": select(stepFeature(map.features, selectedId, -1), true); break;
      case "Escape":
        if (selectedId === undefined) handled = false;
        else select(undefined, false);
        break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  };

  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    dragged.current = false;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera, moved: false };
  };
  const pointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const current = drag.current;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = rect.width > 0 ? MAP_VIEWPORT.width / rect.width : 1;
    const dx = (event.clientX - current.x) * scale;
    const dy = (event.clientY - current.y) * scale;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    if (!current.moved) {
      current.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    // A drag follows the pointer exactly, so it never slides.
    drawnCamera.current = panCamera(current.camera, -dx, -dy);
    moveTo(drawnCamera.current);
  };
  const pointerUp = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    dragged.current = drag.current.moved;
    drag.current = undefined;
  };
  const pickFeature = (id: string) => (): void => {
    // The end of a drag is not a click on whatever is under the pointer.
    if (dragged.current) return;
    select(selectedId === id ? undefined : id, false);
  };

  const land = useMemo(() => basemapPath(camera), [camera]);
  const graticule = useMemo(() => graticulePath(camera), [camera]);
  const shapes = useMemo(() => map.features.map((feature) => ({ feature, shape: featureShape(feature, camera) })), [camera, map.features]);
  const labelPoints = map.counts.points <= MAP_POINT_LABELS;
  const selected = map.features.find((feature) => feature.id === selectedId);

  const position = (at: MapPosition): string => fillMessage(t("widgets.map.position"), { lat: at[1].toFixed(4), lon: at[0].toFixed(4) });
  const where = (feature: MapFeature): string => {
    const geometry = feature.geometry;
    if (geometry.type === "Point") return position(geometry.coordinates);
    if (geometry.type === "LineString") {
      return fillMessage(t("widgets.map.whereLine"), {
        count: geometry.coordinates.length,
        from: position(geometry.coordinates[0] ?? [0, 0]),
        to: position(geometry.coordinates.at(-1) ?? [0, 0]),
      });
    }
    return fillMessage(t("widgets.map.whereArea"), { at: position(mapFeatureAnchor(feature)) });
  };
  const kind = (feature: MapFeature): string =>
    t(feature.geometry.type === "Point" ? "widgets.map.kindPoint" : feature.geometry.type === "LineString" ? "widgets.map.kindLine" : "widgets.map.kindArea");

  return (
    <Frame title={title} dataset={undefined} role="group">
      <div className="cc-map">
        <div
          ref={viewport}
          className="cc-map-viewport"
          role="region"
          aria-roledescription={t("widgets.map.title")}
          aria-label={fillMessage(t("widgets.map.region"), { title })}
          aria-describedby={helpId}
          tabIndex={0}
          data-map-viewport="true"
          data-map-zoom={camera.zoom}
          data-map-center={`${camera.center[0].toFixed(4)},${camera.center[1].toFixed(4)}`}
          onKeyDown={keyDown}
        >
          <span id={helpId} className="cc-sr-only">{t("widgets.map.keyboardHelp")}</span>
          <svg
            className="cc-map-svg"
            viewBox={`0 0 ${String(MAP_VIEWPORT.width)} ${String(MAP_VIEWPORT.height)}`}
            aria-hidden="true"
            focusable="false"
            data-map-svg="true"
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
          >
            <rect className="cc-map-ocean" x={0} y={0} width={MAP_VIEWPORT.width} height={MAP_VIEWPORT.height} />
            <g ref={content} className="cc-map-content" data-map-content="true" data-map-motion={reduced ? "reduced" : "animated"}>
              <path className="cc-map-land" d={land} data-map-basemap="natural-earth" />
              <path className="cc-map-graticule" d={graticule} />
              {tiles.map(({ placement, url }) => (
                <image
                  key={placement.key}
                  href={url}
                  x={placement.left}
                  y={placement.top}
                  width={placement.size}
                  height={placement.size}
                  preserveAspectRatio="none"
                  data-map-tile={`${String(placement.z)}/${String(placement.x)}/${String(placement.y)}`}
                />
              ))}
              {shapes.map(({ feature, shape }) => {
                const isSelected = feature.id === selectedId;
                const common = {
                  "data-map-shape": feature.id,
                  "data-selected": isSelected ? "true" : undefined,
                  onClick: pickFeature(feature.id),
                };
                if (shape.kind === "point") {
                  return (
                    <g key={feature.id} className="cc-map-point" {...common}>
                      <circle cx={shape.x} cy={shape.y} r={isSelected ? 9 : 6} />
                      {(labelPoints || isSelected) && (
                        <text className="cc-map-label" x={shape.x + 11} y={shape.y + 4}>{feature.label}</text>
                      )}
                    </g>
                  );
                }
                return <path key={feature.id} className={shape.kind === "line" ? "cc-map-line" : "cc-map-area"} d={shape.d} {...common} />;
              })}
            </g>
          </svg>
          <div className="cc-map-controls">
            <button type="button" className="cc-map-control" aria-label={t("widgets.map.zoomIn")} title={t("widgets.map.zoomIn")} disabled={camera.zoom >= MAP_MAX_ZOOM} data-map-zoom-in="true" onClick={() => moveTo(zoomCamera(camera, 1))}>+</button>
            <button type="button" className="cc-map-control" aria-label={t("widgets.map.zoomOut")} title={t("widgets.map.zoomOut")} disabled={camera.zoom <= MAP_MIN_ZOOM} data-map-zoom-out="true" onClick={() => moveTo(zoomCamera(camera, -1))}>−</button>
            <button type="button" className="cc-map-control" aria-label={t("widgets.map.reset")} title={t("widgets.map.reset")} data-map-reset="true" onClick={() => moveTo(initialCamera)}>⌂</button>
          </div>
        </div>
        <p className="cc-sr-only" role="status" aria-live="polite" data-map-status="true">
          {fillMessage(t("widgets.map.status"), { center: position(announced.center), zoom: announced.zoom })}{" "}
          {selected === undefined ? t("widgets.map.noneSelected") : fillMessage(t("widgets.map.selected"), { label: selected.label, where: where(selected) })}
        </p>
        <ViewMessage state={state} name="map" />
        <div className="cc-map-attribution" data-map-attribution="true">
          <span data-map-basemap-credit="true">{t("widgets.map.basemap")}</span>
          {provider === null ? (
            <span data-map-tiles="off" data-map-tiles-offline={offline}>
              {t(
                offline === "key-origin-mismatch"
                  ? "widgets.map.tilesOffKeyOrigin"
                  : offline === "key-unavailable"
                    ? "widgets.map.tilesOffKey"
                    : offline === "no-provider"
                      ? "widgets.map.tilesOffNoProvider"
                      : "widgets.map.tilesOff",
              )}
            </span>
          ) : (
            <span data-map-tiles="provider" data-map-tile-origin={provider.origin}>{fillMessage(t("widgets.map.tiles"), { origin: provider.origin, attribution: provider.attribution })}</span>
          )}
          {provider !== null && failed && <span data-map-tiles-failed="true">{fillMessage(t("widgets.map.tilesFailed"), { origin: provider.origin })}</span>}
        </div>
        {map.features.length === 0 ? (
          <p className="cc-freshness" data-map-state="empty" role="status" style={{ margin: 0 }}>{t("widgets.map.empty")}</p>
        ) : (
          <table className="cc-map-table" data-map-table="true">
            <caption className="cc-sr-only">{t("widgets.map.features")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("widgets.map.columnName")}</th>
                <th scope="col">{t("widgets.map.columnWhere")}</th>
                <th scope="col"><span className="cc-sr-only">{t("widgets.map.select")}</span></th>
              </tr>
            </thead>
            <tbody>
              {map.features.map((feature) => {
                const isSelected = feature.id === selectedId;
                return (
                  <tr key={feature.id} data-map-feature={feature.id} data-selected={isSelected ? "true" : undefined}>
                    <th scope="row">
                      <span className="cc-map-feature-name">{feature.label}</span>
                      <span className="cc-map-feature-kind">{kind(feature)}</span>
                      {feature.description !== undefined && feature.description !== "" && <span className="cc-map-feature-kind">{feature.description}</span>}
                    </th>
                    <td>{where(feature)}</td>
                    <td>
                      <button
                        type="button"
                        className="cc-action"
                        aria-pressed={isSelected}
                        aria-label={fillMessage(t("widgets.map.selectNamed"), { label: feature.label })}
                        data-map-select={feature.id}
                        onClick={() => select(isSelected ? undefined : feature.id, !isSelected)}
                      >
                        {t("widgets.map.select")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Frame>
  );
}

function BoardWidgetView({ props, state, onAction }: RendererProps): ReactElement {
  const t = useT();
  const board = useMemo(() => readBoard(props), [props]);
  const stored = useMemo(() => board === undefined ? undefined : readBoardState(state, board), [board, state]);
  const [boardState, setBoardState] = useState(stored);
  const [pickup, setPickup] = useState<BoardPickup>();
  const cardNodes = useRef(new Map<string, HTMLDivElement>());
  const pointer = useRef<{ cardId: string; fromColumnId: string; fromPosition: number; targetColumnId: string; position: number } | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  const [focusFirst, setFocusFirst] = useState(false);
  // The node's view is adopted whenever it arrives. A card the person is moving with the keyboard stays picked up and
  // stays where they moved it, on top of that view: the answer to an earlier move can arrive in the middle of this one.
  // A card the newer view no longer has ends the move, said so, with focus on the board's first card.
  const [adopted, setAdopted] = useState(stored);
  if (adopted !== stored) {
    setAdopted(stored);
    const rebased = board === undefined || stored === undefined || pickup === undefined ? undefined : rebaseBoardPickup(board, pickup, stored);
    if (board !== undefined && rebased !== undefined) {
      setPickup(rebased);
      setBoardState(boardPickupPreview(board, rebased));
    } else {
      setBoardState(stored);
      if (pickup !== undefined) {
        setPickup(undefined);
        setAnnouncement(t("widgets.board.pickupGone"));
        setFocusFirst(true);
      }
    }
  }
  // A pointer drag follows the newer view the same way; it lives in a ref, so it is moved after the render.
  useEffect(() => {
    const drag = pointer.current;
    if (drag === undefined || board === undefined || stored === undefined) return;
    pointer.current = rebaseBoardPointerDrag(board, drag, stored);
    if (pointer.current === undefined) setAnnouncement(t("widgets.board.pickupGone"));
  }, [board, stored, t]);
  useEffect(() => {
    if (pickup !== undefined) cardNodes.current.get(pickup.cardId)?.focus();
  }, [boardState, pickup]);
  useEffect(() => {
    if (!focusFirst) return;
    setFocusFirst(false);
    const first = board?.columns.flatMap((column) => boardState?.order[column.id] ?? [])[0];
    if (first !== undefined) cardNodes.current.get(first)?.focus();
  }, [board, boardState, focusFirst]);

  if (board === undefined || boardState === undefined) {
    return <Frame title={t("widgets.board.title")} dataset={undefined} role="group"><p role="status">{t("widgets.board.unreadable")}</p></Frame>;
  }
  const title = board.title || t("widgets.board.title");
  const pending = boardState.pendingMove;
  const externalBound = state?.externalBound === true;
  const order = (columnId: string): string[] => boardState.order[columnId] ?? [];
  const firstCardId = board.columns.flatMap((column) => order(column.id))[0];
  const commitMove = (move: BoardMove): void => {
    if (boardMoveProblems(board, pickup?.origin ?? boardState, move).length > 0) {
      // Not saved, and said so: the card goes back to where the node's view has it.
      setBoardState(pickup?.origin ?? stored ?? boardState);
      setPickup(undefined);
      setAnnouncement(t("widgets.board.cancelled"));
      return;
    }
    const next = moveBoardCard(board, pickup?.origin ?? boardState, { ...move, external: externalBound });
    setBoardState(next);
    setPickup(undefined);
    setAnnouncement(`${t("widgets.board.moved")} ${board.cards.find((card) => card.id === move.cardId)?.title ?? ""} — ${board.columns.find((column) => column.id === move.toColumnId)?.title ?? ""}, ${String(move.position + 1)}`);
    onAction?.(BOARD_MOVE_OPERATION, { cardId: move.cardId, fromColumnId: move.fromColumnId, toColumnId: move.toColumnId, position: move.position });
  };
  const movePreview = (columnId: string, position: number): void => {
    if (pickup === undefined || boardMoveProblems(board, pickup.origin, { cardId: pickup.cardId, fromColumnId: boardColumnForBoardState(pickup.origin, pickup.cardId), toColumnId: columnId, position }).length > 0) return;
    const moved = { ...pickup, target: { columnId, position } };
    setPickup(moved);
    setBoardState(boardPickupPreview(board, moved));
    setAnnouncement(`${t("widgets.board.moving")} ${board.cards.find((card) => card.id === pickup.cardId)?.title ?? ""} — ${board.columns.find((column) => column.id === columnId)?.title ?? ""}, ${String(position + 1)}`);
  };
  const cancelPickup = (): void => {
    if (pickup !== undefined) setBoardState(pickup.origin);
    setPickup(undefined);
    pointer.current = undefined;
    setAnnouncement(t("widgets.board.cancelled"));
  };
  const finishPointer = (): void => {
    const drag = pointer.current;
    pointer.current = undefined;
    if (drag === undefined) return;
    if (drag.fromColumnId === drag.targetColumnId && drag.fromPosition === drag.position) return;
    commitMove({ cardId: drag.cardId, fromColumnId: drag.fromColumnId, toColumnId: drag.targetColumnId, position: drag.position });
  };

  return (
    <Frame title={title} dataset={undefined} role="group">
      <div data-board-root="true" style={{ overflowX: "auto", overscrollBehaviorX: "contain" }}
        onPointerMove={(event) => {
          if (pointer.current === undefined) return;
          const target = document.elementFromPoint(event.clientX, event.clientY);
          const column = target?.closest<HTMLElement>("[data-board-column]");
          if (column === null || column === undefined) return;
          const columnId = column.dataset.boardColumn;
          if (columnId === undefined) return;
          const cardElement = target?.closest<HTMLElement>("[data-board-card]");
          const cardIndex = cardElement?.parentElement?.getAttribute("data-board-position");
          const sourceColumnId = pointer.current.fromColumnId;
          const sourceIndex = pointer.current.fromPosition;
          const hoveredIndex = cardIndex === null || cardIndex === undefined ? order(columnId).length : Number(cardIndex);
          const position = sourceColumnId === columnId
            ? cardIndex === null || cardIndex === undefined
              ? Math.max(0, hoveredIndex - 1)
              : Math.max(0, hoveredIndex - Number(sourceIndex < hoveredIndex))
            : hoveredIndex;
          if (pointer.current.targetColumnId !== columnId || pointer.current.position !== position) {
            const card = board.cards.find((entry) => entry.id === pointer.current?.cardId);
            setAnnouncement(`${t("widgets.board.moving")} ${card?.title ?? ""} — ${board.columns.find((entry) => entry.id === columnId)?.title ?? ""}, ${String(position + 1)}`);
          }
          pointer.current = { ...pointer.current, targetColumnId: columnId, position };
        }}
        onPointerUp={finishPointer} onPointerCancel={cancelPickup}>
        {!externalBound && pending === undefined && <p role="note" data-board-mode="local">{t("widgets.board.localMode")}</p>}
        {pending?.outcome === "uncertain" ? <p role="status" data-board-status="uncertain">{t("widgets.board.uncertain")} <button type="button" className="cc-action" onClick={() => onAction?.(BOARD_ACKNOWLEDGE_OPERATION, {})}>{t("widgets.board.acknowledge")}</button></p>
          : pending?.approvalId !== undefined ? <p role="status" data-board-status="approval">{t("widgets.board.awaitingApproval")}</p>
            : pending !== undefined ? <p role="status" data-board-status="pending">{t("widgets.board.pending")}</p>
              : typeof state?.actionMessage === "string" ? <p role="status" data-board-status={String(state.actionTone ?? "")}>{state.actionMessage}</p> : null}
        <div role="list" aria-label={title} style={{ display: "grid", gridAutoColumns: "minmax(220px, 1fr)", gridAutoFlow: "column", gap: "var(--cc-space-sm)", minWidth: 0, paddingBlock: "var(--cc-space-xs)" }}>
          {board.columns.map((column) => (
            <section key={column.id} data-board-column={column.id} aria-label={`${column.title}, ${String(order(column.id).length)} ${t("widgets.board.cards")}`} style={{ minWidth: 0, border: "1px solid var(--cc-border-subtle)", borderRadius: "var(--cc-radius-md)", padding: "var(--cc-space-sm)", background: "var(--cc-surface-raised)" }}>
              <h3 style={{ margin: "0 0 var(--cc-space-sm)", fontSize: "var(--cc-font-size-sm)" }}>{column.title}<span aria-hidden="true"> · {String(order(column.id).length)}{column.limit === undefined ? "" : ` / ${String(column.limit)}`}</span></h3>
              <div style={{ display: "grid", gap: "var(--cc-space-xs)" }}>
                {order(column.id).map((cardId, index) => {
                  const card = board.cards.find((entry) => entry.id === cardId);
                  if (card === undefined) return null;
                  const selected = boardState.selectedCardId === card.id;
                  return <article key={card.id} data-board-position={index} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "var(--cc-space-xs)", border: "1px solid var(--cc-border-subtle)", borderRadius: "var(--cc-radius-sm)", padding: "var(--cc-space-xs)", background: "var(--cc-surface)", outline: selected ? "2px solid var(--cc-focus)" : undefined }}>
                    <div ref={(element) => { if (element === null) cardNodes.current.delete(card.id); else cardNodes.current.set(card.id, element); }} role="group" data-board-card={card.id} tabIndex={selected || boardState.selectedCardId === undefined && firstCardId === card.id ? 0 : -1} aria-label={`${card.title}, ${column.title}`} onFocus={() => setBoardState({ ...boardState, selectedCardId: card.id })}
                      onKeyDown={(event) => {
                        // Escape always puts a picked-up card back, even while the node holds a move that is not settled yet.
                        if (event.key === "Escape" && pickup !== undefined) { event.preventDefault(); cancelPickup(); return; }
                        if (pending !== undefined) return;
                        if ((event.key === " " || event.key === "Enter") && pickup === undefined) { event.preventDefault(); setPickup({ cardId: card.id, origin: boardState }); setBoardState({ ...boardState, selectedCardId: card.id }); setAnnouncement(`${t("widgets.board.pickedUp")} ${card.title}`); return; }
                        if ((event.key === " " || event.key === "Enter") && pickup?.cardId === card.id) { event.preventDefault(); const drop = boardPickupDrop(board, pickup); if (drop === undefined) cancelPickup(); else commitMove(drop); return; }
                        if (pickup?.cardId === card.id && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                          event.preventDefault();
                          const fromColumnId = boardColumnForBoardState(boardState, card.id);
                          const sourceIndex = order(fromColumnId).indexOf(card.id);
                          const columnIndex = board.columns.findIndex((entry) => entry.id === fromColumnId);
                          const targetColumn = event.key === "ArrowLeft" ? board.columns[Math.max(0, columnIndex - 1)] : event.key === "ArrowRight" ? board.columns[Math.min(board.columns.length - 1, columnIndex + 1)] : board.columns[columnIndex];
                          const targetOrder = order(targetColumn?.id ?? fromColumnId);
                          const position = event.key === "ArrowUp" ? Math.max(0, sourceIndex - 1) : event.key === "ArrowDown" ? Math.min(Math.max(0, targetOrder.length - 1), sourceIndex + 1) : Math.min(sourceIndex, targetOrder.length);
                          movePreview(targetColumn?.id ?? fromColumnId, position);
                        }
                      }}>
                      <strong>{card.title}</strong>
                      {card.description !== undefined && <p style={{ margin: "var(--cc-space-xs) 0 0" }}>{card.description}</p>}
                      {card.assignee !== undefined && <p style={{ margin: "var(--cc-space-xs) 0 0" }}>{t("widgets.board.assignee")}: {card.assignee}</p>}
                      {card.labels.length > 0 && <ul aria-label={t("widgets.board.labels")} style={{ display: "flex", flexWrap: "wrap", gap: "var(--cc-space-xs)", listStyle: "none", padding: 0, margin: "var(--cc-space-xs) 0 0" }}>{card.labels.map((label, labelIndex) => <li key={`${label.text}-${String(labelIndex)}`} data-tone={label.tone ?? "neutral"} style={{ border: "1px solid var(--cc-border-subtle)", borderRadius: "999px", paddingInline: "var(--cc-space-xs)" }}>{label.text}<span className="cc-sr-only"> — {t(`widgets.board.tone.${label.tone ?? "neutral"}` as MessageKey)}</span></li>)}</ul>}
                    </div>
                    <button type="button" className="cc-icon-btn" aria-label={`${t("widgets.board.dragHandle")}: ${card.title}`} data-board-drag-handle={card.id} style={{ minWidth: 44, minHeight: 44, touchAction: "none", cursor: "grab" }} disabled={pending !== undefined}
                      onPointerDown={(event) => {
                        if (pending !== undefined) return;
                        // Real pointer capture keeps a drag alive outside its original card; synthetic test events have
                        // no active browser pointer to capture.
                        if (event.isTrusted) event.currentTarget.setPointerCapture(event.pointerId);
                        const fromColumnId = boardColumnForBoardState(boardState, card.id);
                        const fromPosition = order(fromColumnId).indexOf(card.id);
                        pointer.current = { cardId: card.id, fromColumnId, fromPosition, targetColumnId: fromColumnId, position: fromPosition };
                        setBoardState({ ...boardState, selectedCardId: card.id });
                        setAnnouncement(`${t("widgets.board.pickedUp")} ${card.title}`);
                      }} onPointerUp={finishPointer} onKeyDown={(event) => { if (event.key === "Escape") cancelPickup(); }}>
                      <span aria-hidden="true">⠿</span>
                    </button>
                  </article>;
                })}
              </div>
            </section>
          ))}
        </div>
        <p className="cc-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
        {typeof state?.message === "string" && state.message !== "" && <p role="status" data-board-status="refused">{state.message}</p>}
      </div>
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
 * Activity timeline
 * ------------------------------------------------------------------ */

/** The day a timeline groups under, in words: the full date in the reader's language, read as that date wherever it is. */
function timelineDayLabel(locale: string, day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? day : new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(at);
}

/**
 * What happened, and when, as a list grouped by day.
 *
 * Everything shown is in the props: the model's entries, each on its day in the timeline's own timezone, so an entry at
 * 23:30 in Saigon is on the Saigon day wherever the page is opened. A tone is said by a symbol and a word beside its
 * colour, never by the colour alone. The entries of the page on screen are one list with one tab stop; the selected
 * entry is the timeline's state, drawn at once and sent as the one bound view operation, and the selection the node then
 * holds is adopted. A selection the node refused is undrawn and the reason is said beside it.
 *
 * Text that holds a hidden character is drawn with each one as a marker instead of applied: the node refuses them when
 * the timeline is placed, and a timeline stored before a rule tightened still reads the way it is stored.
 */
function ActivityTimeline({ props, state, onAction, onStateChange, statedAt, sample }: RendererProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const namedZone = typeof props.timezone === "string" && props.timezone !== "" ? props.timezone : undefined;
  const zoneKnown = namedZone === undefined || isKnownTimeZone(namedZone);
  const timeline = useMemo(() => readTimeline(props, { keepHidden: true }), [props]);
  const describe = useCallback(
    (hidden: HiddenCharacter) => fillMessage(t(HIDDEN_TITLE[hidden.kind]), { codePoint: hidden.codePoint }),
    [t],
  );
  const hintId = useId();
  const liveId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // The selection the node holds, adopted whenever it changes; between those, what the person just did is drawn at once.
  const stored = readTimelineSelection(state, timeline);
  // A refusal counts up `viewReset`, so a selection the node refused is undrawn even when the one it holds did not move.
  const storedKey = `${stored.selectedId ?? ""}#${String(state?.viewReset ?? 0)}`;
  const [selectedId, setSelectedId] = useState(stored.selectedId);
  const [page, setPage] = useState(() => (timeline === undefined ? 0 : timelinePageOf(timeline, stored.selectedId)));
  const [syncedKey, setSyncedKey] = useState(storedKey);
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  if (syncedKey !== storedKey) {
    setSyncedKey(storedKey);
    setSelectedId(stored.selectedId);
    if (timeline !== undefined && stored.selectedId !== undefined) setPage(timelinePageOf(timeline, stored.selectedId));
  }

  const title = timeline?.title ?? (typeof props.title === "string" && props.title.trim() !== "" ? props.title : t("widgets.timeline.title"));
  if (timeline === undefined) {
    return (
      <Frame title={title} dataset={undefined} role="timeline">
        <Unavailable reason={t("widgets.timeline.notReadable")} />
      </Frame>
    );
  }

  const mark = (text: string): ReactNode => withHiddenMarkers(text, describe);
  const pages = timelinePageCount(timeline);
  const shownPage = clampTimelinePage(page, pages);
  const days = timelinePage(timeline, shownPage);
  const pageIds = days.flatMap((day) => day.entries.map((entry) => entry.id));
  const tabStop = timelineTabStop(pageIds, focusedId, selectedId);
  const selected = selectedId === undefined ? undefined : timeline.entries.find((entry) => entry.id === selectedId);
  const hidden = timelineHiddenCount(timeline);
  const range = timelineRange(timeline);
  const whenOf = (entry: TimelineEntry): string =>
    entry.time === undefined
      ? fillMessage(t("widgets.timeline.whenAllDay"), { day: timelineDayLabel(locale, entry.day) })
      : fillMessage(t("widgets.timeline.whenAt"), { day: timelineDayLabel(locale, entry.day), time: entry.time });

  const commit = (next: string | undefined): void => {
    setSelectedId(next);
    const entry = next === undefined ? undefined : timeline.entries.find((candidate) => candidate.id === next);
    setAnnouncement(
      entry === undefined ? t("widgets.timeline.cleared") : fillMessage(t("widgets.timeline.selectedLive"), { title: entry.title, when: whenOf(entry) }),
    );
    onStateChange?.({ selectedId: next });
    onAction?.(TIMELINE_SELECT_OPERATION, { selectedId: next ?? "" });
  };
  const turnPage = (to: number): void => {
    const next = clampTimelinePage(to, pages);
    setPage(next);
    setFocusedId(undefined);
  };

  const summary = [
    fillMessage(t(timeline.entries.length === 1 ? "widgets.timeline.countOne" : "widgets.timeline.countMany"), {
      count: String(timeline.entries.length),
    }),
    ...(range === undefined ? [] : [range.from === range.to ? range.from : fillMessage(t("widgets.timeline.range"), { from: range.from, to: range.to })]),
    t(timeline.order === "newest" ? "widgets.timeline.order.newest" : "widgets.timeline.order.oldest"),
    fillMessage(t("widgets.timeline.shownIn"), { timezone: timeline.timeZone }),
  ].join(" · ");

  const entryRow = (entry: TimelineEntry): ReactElement => {
    const isSelected = entry.id === selectedId;
    const folds = timelineDescriptionFolds(entry.description);
    const open = !folds || unfolded.has(entry.id);
    const descriptionId = `${liveId}-d-${String(entry.index)}`;
    return (
      <li key={entry.id} className="cc-timeline-entry" data-timeline-entry-row={entry.id} data-tone={entry.tone}>
        <button
          type="button"
          className="cc-timeline-entry-button"
          data-timeline-entry={entry.id}
          data-all-day={entry.allDay ? "true" : "false"}
          aria-pressed={isSelected}
          tabIndex={entry.id === tabStop ? 0 : -1}
          onFocus={() => setFocusedId(entry.id)}
          onClick={() => commit(timelineToggle(selectedId, entry.id))}
        >
          <span className="cc-timeline-mark" data-tone={entry.tone} aria-hidden="true">
            {TONE_MARK[entry.tone]}
          </span>
          <span className="cc-timeline-time">{entry.time === undefined ? t("widgets.timeline.allDay") : <time dateTime={entry.at}>{entry.time}</time>}</span>
          <span className="cc-badge cc-timeline-tone" data-tone={TONE_BADGE[entry.tone]} data-timeline-tone-word={entry.tone}>
            {t(`widgets.status.tone.${entry.tone}` as MessageKey)}
          </span>
          <span className="cc-timeline-entry-title">{mark(entry.title)}</span>
          {entry.actor !== undefined && (
            <span className="cc-timeline-actor" data-timeline-actor="">
              {mark(fillMessage(t("widgets.timeline.by"), { actor: entry.actor }))}
            </span>
          )}
        </button>
        {entry.description !== undefined && (
          <div className="cc-timeline-description" data-timeline-description={entry.id}>
            <p id={descriptionId} data-folded={open ? "false" : "true"}>
              {mark(open ? entry.description : foldedTimelineDescription(entry.description))}
            </p>
            {folds && (
              <button
                type="button"
                className="cc-timeline-fold"
                data-timeline-fold={entry.id}
                aria-expanded={open}
                aria-controls={descriptionId}
                onClick={() =>
                  setUnfolded((current) => {
                    const next = new Set(current);
                    if (next.has(entry.id)) next.delete(entry.id);
                    else next.add(entry.id);
                    return next;
                  })
                }
              >
                {t(open ? "widgets.timeline.showLess" : "widgets.timeline.showMore")}
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <Frame title={title} dataset={undefined} role="timeline">
      <div
        ref={rootRef}
        className="cc-timeline-root"
        data-timeline-page={shownPage + 1}
        data-timeline-selected={selectedId ?? ""}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Escape" && selectedId !== undefined) {
            keyEvent.preventDefault();
            commit(undefined);
            return;
          }
          const target = keyEvent.target as HTMLElement;
          const id = target.getAttribute("data-timeline-entry");
          if (id === null) return;
          const next = moveTimelineFocus(keyEvent.key, pageIds.indexOf(id), pageIds.length);
          if (next === undefined) return;
          keyEvent.preventDefault();
          const nextId = pageIds[next];
          if (nextId === undefined) return;
          setFocusedId(nextId);
          rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-timeline-entry]")[next]?.focus();
        }}
      >
        <p className="cc-freshness cc-timeline-summary" data-timeline-summary="" style={{ margin: 0 }}>
          {summary}
        </p>
        {typeof state?.message === "string" && state.message !== "" && (
          <p className="cc-freshness" role="status" data-timeline-message="true" style={{ margin: 0 }}>
            {state.message}
          </p>
        )}
        {!zoneKnown && (
          <p className="cc-freshness" data-timeline-note="timezone" style={{ margin: 0 }}>
            {fillMessage(t("widgets.timeline.timeZoneUnknown"), { timezone: namedZone ?? "" })}
          </p>
        )}
        {timeline.entries.length === 0 ? (
          <p className="cc-freshness" data-timeline-empty="true" style={{ margin: 0 }}>
            {t("widgets.timeline.empty")}
          </p>
        ) : (
          <ol
            className="cc-timeline-days"
            aria-label={fillMessage(t("widgets.timeline.listLabel"), { timezone: timeline.timeZone })}
            aria-describedby={hintId}
          >
            {days.map((day) => {
              const dayId = `${liveId}-day-${day.day}`;
              return (
                <li key={day.day} className="cc-timeline-day" data-timeline-day={day.day}>
                  <p id={dayId} className="cc-timeline-day-head">
                    <time dateTime={day.day}>{timelineDayLabel(locale, day.day)}</time>
                  </p>
                  <ul className="cc-timeline-entries" aria-labelledby={dayId}>
                    {day.entries.map(entryRow)}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
        {pages > 1 && (
          <nav className="cc-timeline-pager" aria-label={t("widgets.timeline.pager")}>
            <button type="button" data-timeline-previous="" disabled={shownPage === 0} onClick={() => turnPage(shownPage - 1)}>
              {t("widgets.timeline.previousPage")}
            </button>
            <span className="cc-freshness" data-timeline-page-label="">
              {fillMessage(t("widgets.timeline.page"), { page: String(shownPage + 1), pages: String(pages) })}
            </span>
            <button type="button" data-timeline-next="" disabled={shownPage === pages - 1} onClick={() => turnPage(shownPage + 1)}>
              {t("widgets.timeline.nextPage")}
            </button>
          </nav>
        )}
        <p id={hintId} className="cc-sr-only">
          {t("widgets.timeline.keyboardHint")}
        </p>
        <p className="cc-sr-only" aria-live="polite" data-timeline-live="">
          {announcement}
        </p>
        {selected !== undefined && (
          <div className="cc-timeline-detail" data-timeline-selected-entry={selected.id} role="group" aria-label={t("widgets.timeline.selected")}>
            <strong>{mark(selected.title)}</strong>
            <span>{whenOf(selected)}</span>
            <span>
              <span className="cc-timeline-mark" data-tone={selected.tone} aria-hidden="true">
                {TONE_MARK[selected.tone]}
              </span>{" "}
              {t(`widgets.status.tone.${selected.tone}` as MessageKey)}
            </span>
            <button type="button" className="cc-timeline-clear" data-timeline-clear="" onClick={() => commit(undefined)}>
              {t("widgets.timeline.clear")}
            </button>
          </div>
        )}
        {timeline.truncated && (
          <p className="cc-freshness" data-timeline-note="truncated" style={{ margin: 0 }}>
            {t("widgets.timeline.truncated")}
          </p>
        )}
        {hidden > 0 && (
          <p className="cc-freshness cc-viewer-hidden" data-timeline-hidden={hidden} style={{ margin: 0 }}>
            {fillMessage(t("widgets.timeline.hidden"), { count: String(hidden) })}
          </p>
        )}
        {timeline.entries.length > 0 && (
          <details className="cc-timeline-text" data-timeline-text="">
            <summary>{t("widgets.timeline.asText")}</summary>
            <ul>
              {timeline.entries.map((entry) => (
                <li key={entry.id} data-timeline-text-entry={entry.id}>
                  {whenOf(entry)} · {t(`widgets.status.tone.${entry.tone}` as MessageKey)} · {mark(entry.title)}
                  {entry.actor === undefined ? null : <> · {mark(fillMessage(t("widgets.timeline.by"), { actor: entry.actor }))}</>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <Provenance asOf={undefined} stated statedAt={statedAt} sample={sample} />
    </Frame>
  );
}
/* ------------------------------------------------------------------ *
 * Diagram
 * ------------------------------------------------------------------ */

const DIAGRAM_SHAPE_WORD: Record<DiagramNode["shape"], MessageKey> = {
  box: "widgets.diagram.shape.box",
  round: "widgets.diagram.shape.round",
  diamond: "widgets.diagram.shape.diamond",
  circle: "widgets.diagram.shape.circle",
};

/** One shape, in the node's own box: every coordinate is a number the layout computed, never markup from the props. */
function DiagramShape({ node }: { node: PlacedDiagramNode }): ReactElement {
  const { width, height } = node;
  if (node.shape === "diamond") {
    return <polygon className="cc-diagram-shape" points={`${String(width / 2)},0 ${String(width)},${String(height / 2)} ${String(width / 2)},${String(height)} 0,${String(height / 2)}`} />;
  }
  if (node.shape === "circle") return <circle className="cc-diagram-shape" cx={width / 2} cy={height / 2} r={width / 2} />;
  return <rect className="cc-diagram-shape" width={width} height={height} rx={node.shape === "round" ? Math.min(height / 2, 24) : 4} />;
}

/**
 * A diagram drawn from its model as SVG elements and text nodes.
 *
 * Nothing from the props reaches the page as markup: labels are React text, shapes and paths are numbers from the shared
 * layout, and there is no link, image, `foreignObject` or handler a label could name. Each node is a button a person can
 * reach by keyboard along the edges; its accessible name says its shape, its group and the nodes it leads to and comes
 * from. The selected node is view state the node checks and keeps, and it lights its edges and neighbours.
 */
function DiagramView({ props, state, onAction, onStateChange, statedAt, sample }: RendererProps): ReactElement {
  const t = useT();
  const diagram = useMemo(() => readDiagram(props), [props]);
  const layout = useMemo(() => (diagram === undefined ? undefined : layoutDiagram(diagram)), [diagram]);
  const helpId = useId();
  // A marker is referenced by id from an attribute, so the id is kept to characters every url() reads.
  const markerBase = `cc-diagram-${useId().replace(/[^A-Za-z0-9_-]/gu, "")}`;
  const nodeRefs = useRef(new Map<string, SVGGElement>());

  // The selection the node holds, adopted whenever it changes; between those, what the person just did is drawn at once.
  const stored = diagram === undefined ? {} : readDiagramState(state, diagram);
  // A refusal counts up `viewReset`, so a selection the node refused is undrawn even when the one it holds did not move.
  const storedKey = `${stored.selectedId ?? ""}#${String(state?.viewReset ?? 0)}`;
  const [selectedId, setSelectedId] = useState(stored.selectedId);
  const [syncedKey, setSyncedKey] = useState(storedKey);
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  if (syncedKey !== storedKey) {
    setSyncedKey(storedKey);
    setSelectedId(stored.selectedId);
  }

  const title = diagram?.title ?? t("widgets.diagram.title");
  if (diagram === undefined || layout === undefined) {
    return (
      <Frame title={title} dataset={undefined} role="diagram">
        <Unavailable reason={t("widgets.diagram.unreadable")} />
      </Frame>
    );
  }

  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  const describe = (node: DiagramNode): string => {
    const near = diagramNeighbours(diagram, node.id).named;
    const parts = [node.label, t(DIAGRAM_SHAPE_WORD[node.shape])];
    if (node.group !== undefined) parts.push(fillMessage(t("widgets.diagram.inGroup"), { group: node.group }));
    if (near.next.length > 0) parts.push(fillMessage(t("widgets.diagram.leadsTo"), { nodes: near.next.join(", ") }));
    if (near.previous.length > 0) parts.push(fillMessage(t("widgets.diagram.comesFrom"), { nodes: near.previous.join(", ") }));
    if (near.linked.length > 0) parts.push(fillMessage(t("widgets.diagram.linkedWith"), { nodes: near.linked.join(", ") }));
    if (near.next.length + near.previous.length + near.linked.length === 0) parts.push(t("widgets.diagram.noEdges"));
    return parts.join(", ");
  };

  const selected = selectedId === undefined ? undefined : byId.get(selectedId);
  const neighbourhood = selected === undefined ? undefined : diagramNeighbours(diagram, selected.id);
  const nearIds = new Set([...(neighbourhood?.next ?? []), ...(neighbourhood?.previous ?? []), ...(neighbourhood?.linked ?? [])].map((node) => node.id));
  const litEdges = new Set(neighbourhood?.edges ?? []);
  const tabStop = focusedId !== undefined && byId.has(focusedId) ? focusedId : (selected?.id ?? diagram.nodes[0]?.id);

  const commit = (next: string | undefined): void => {
    setSelectedId(next);
    const node = next === undefined ? undefined : byId.get(next);
    setAnnouncement(node === undefined ? t("widgets.diagram.cleared") : fillMessage(t("widgets.diagram.selected"), { description: describe(node) }));
    onStateChange?.({ selectedId: next });
    onAction?.(DIAGRAM_SELECT_OPERATION, { selectedId: next ?? "" });
  };
  const focusNode = (id: string): void => {
    setFocusedId(id);
    nodeRefs.current.get(id)?.focus();
  };

  const placedEdges = layout.edges.map((edge) => {
    const source = diagram.edges[edge.index];
    const lit = litEdges.has(edge.index);
    const marker = `url(#${markerBase}-${lit ? "lit" : "plain"})`;
    const path = edge.points.map((point, index) => `${index === 0 ? "M" : "L"} ${String(point.x)} ${String(point.y)}`).join(" ");
    const labelWidth = source?.label === undefined ? 0 : diagramEdgeLabelWidth(source.label);
    return (
      <g key={edge.index} className="cc-diagram-edge" data-diagram-edge={`${edge.from}>${edge.to}`} data-lit={lit ? "true" : undefined}>
        <path
          d={path}
          fill="none"
          markerEnd={source?.direction === "none" ? undefined : marker}
          markerStart={source?.direction === "both" ? marker : undefined}
        />
        {source?.label !== undefined && edge.labelAt !== undefined && (
          <g className="cc-diagram-edge-label">
            <rect x={edge.labelAt.x - labelWidth / 2} y={edge.labelAt.y - 10} width={labelWidth} height={20} rx={4} />
            <text x={edge.labelAt.x} y={edge.labelAt.y} textAnchor="middle" dominantBaseline="central">
              {source.label}
            </text>
          </g>
        )}
      </g>
    );
  });

  const placedNodes = layout.nodes.map((placed) => {
    const node = byId.get(placed.id);
    if (node === undefined) return null;
    const isSelected = placed.id === selectedId;
    const lineCount = placed.lines.length + (placed.groupLine === undefined ? 0 : 1);
    const firstLine = placed.height / 2 - ((lineCount - 1) * DIAGRAM_LINE_HEIGHT) / 2;
    return (
      <g
        key={placed.id}
        ref={(element) => {
          if (element === null) nodeRefs.current.delete(placed.id);
          else nodeRefs.current.set(placed.id, element);
        }}
        className="cc-diagram-node"
        role="button"
        tabIndex={placed.id === tabStop ? 0 : -1}
        aria-pressed={isSelected}
        aria-label={describe(node)}
        data-diagram-node={placed.id}
        data-shape={placed.shape}
        data-selected={isSelected ? "true" : undefined}
        data-neighbour={nearIds.has(placed.id) ? "true" : undefined}
        transform={`translate(${String(placed.x)} ${String(placed.y)})`}
        onFocus={() => setFocusedId(placed.id)}
        onClick={() => commit(isSelected ? undefined : placed.id)}
      >
        <rect className="cc-diagram-focus-ring" x={-5} y={-5} width={placed.width + 10} height={placed.height + 10} rx={10} />
        <DiagramShape node={placed} />
        {placed.groupLine !== undefined && (
          <text className="cc-diagram-group" x={placed.width / 2} y={firstLine} textAnchor="middle" dominantBaseline="central">
            {placed.groupLine}
          </text>
        )}
        {placed.lines.map((line, index) => (
          <text
            key={index}
            className="cc-diagram-label"
            x={placed.width / 2}
            y={firstLine + (index + (placed.groupLine === undefined ? 0 : 1)) * DIAGRAM_LINE_HEIGHT}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {line}
          </text>
        ))}
      </g>
    );
  });

  return (
    <Frame title={title} dataset={undefined} role="diagram">
      <div
        className="cc-diagram-root"
        data-diagram-selected={selectedId ?? ""}
        data-diagram-direction={diagram.direction}
        data-diagram-layout={diagram.layout}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Escape" && selectedId !== undefined) {
            keyEvent.preventDefault();
            commit(undefined);
            return;
          }
          const id = (keyEvent.target as Element).closest("[data-diagram-node]")?.getAttribute("data-diagram-node");
          if (id === null || id === undefined) return;
          if (keyEvent.key === "Enter" || keyEvent.key === " ") {
            keyEvent.preventDefault();
            commit(id === selectedId ? undefined : id);
            return;
          }
          const target = diagramKeyTarget(keyEvent.key, diagram, layout, id);
          if (target === undefined) return;
          keyEvent.preventDefault();
          focusNode(target);
        }}
      >
        <p className="cc-freshness" data-diagram-summary="" style={{ margin: 0 }}>
          {fillMessage(t("widgets.diagram.summary"), { nodes: String(diagram.nodes.length), edges: String(diagram.edges.length) })}
        </p>
        {typeof state?.message === "string" && state.message !== "" && (
          <p className="cc-freshness" role="status" data-diagram-message="true" style={{ margin: 0 }}>
            {state.message}
          </p>
        )}
        {diagram.nodes.length === 0 ? (
          <p className="cc-freshness" data-diagram-empty="true" style={{ margin: 0 }}>
            {t("widgets.diagram.empty")}
          </p>
        ) : (
          <div className="cc-diagram-scroll" data-diagram-scroll="">
            <svg
              className="cc-diagram-svg"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
              role="group"
              aria-label={fillMessage(t("widgets.diagram.drawing"), { title })}
              aria-describedby={helpId}
            >
              <defs>
                {(["plain", "lit"] as const).map((kind) => (
                  <marker
                    key={kind}
                    id={`${markerBase}-${kind}`}
                    className={`cc-diagram-arrow cc-diagram-arrow-${kind}`}
                    viewBox="0 0 10 10"
                    refX={10}
                    refY={5}
                    markerWidth={8}
                    markerHeight={8}
                    markerUnits="userSpaceOnUse"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                ))}
              </defs>
              <g aria-hidden="true">{placedEdges}</g>
              {placedNodes}
            </svg>
          </div>
        )}
        <p id={helpId} className="cc-sr-only">
          {t(diagram.direction === "LR" ? "widgets.diagram.keyboardHelpLR" : "widgets.diagram.keyboardHelpTB")}
        </p>
        <p className="cc-sr-only" aria-live="polite" data-diagram-live="">
          {announcement}
        </p>
        {selected !== undefined && (
          <div className="cc-diagram-detail" data-diagram-selected-node={selected.id}>
            <span>{fillMessage(t("widgets.diagram.selected"), { description: describe(selected) })}</span>
            <button type="button" className="cc-diagram-clear" data-diagram-clear="" onClick={() => commit(undefined)}>
              {t("widgets.diagram.clear")}
            </button>
          </div>
        )}
        {diagram.nodes.length > 0 && (
          <details className="cc-diagram-text" data-diagram-text="">
            <summary>{t("widgets.diagram.asText")}</summary>
            <ul>
              {diagram.nodes.map((node) => (
                <li key={node.id} data-diagram-text-node={node.id}>
                  {diagramTextLine(diagram, node)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <Provenance asOf={undefined} stated statedAt={statedAt} sample={sample} />
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
  "canvas.timeline@1": ActivityTimeline,
  "canvas.image@1": LocalImage,
  "canvas.carousel@1": Carousel,
  "canvas.gallery@1": Gallery,
  "canvas.youtube@1": YouTubeEmbed,
  "canvas.video@1": LocalVideo,
  "canvas.audio@1": LocalAudio,
  "canvas.document@1": DocumentPreview,
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
  [TREE_ID]: TreeWidgetView,
  [DIAGRAM_ID]: DiagramView,
  [BOARD_ID]: BoardWidgetView,
  [MAP_ID]: MapWidgetView,
  "canvas.status@1": StatusCardView,
  "canvas.progress@1": ProgressCardView,
  "canvas.details@1": DetailsCardView,
};

export function resolveRenderer(definitionId: string): CatalogRenderer | undefined {
  return CATALOG[definitionId];
}

export const RENDERER_IDS = Object.keys(CATALOG);
