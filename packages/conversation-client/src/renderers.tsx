import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { donutSlices, monthGrid } from "@clarkcant/contracts";

import type { ResolvedDataset } from "./api.ts";
import {
  CHART_HEIGHT,
  CHART_PAD,
  type ChartGeometry,
  chartGeometry,
  type ChartPoint,
  chartPoints,
  formatTicks,
  labelStride,
  valueLabelShown,
} from "./chart-layout.ts";
import { vendorEmbedUrl } from "./media-embed.ts";
import { useT } from "./i18n/locale-context.tsx";
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

function LineChart({ props, dataset }: RendererProps): ReactElement {
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

  const seriesKey = typeof props.series === "object" && Array.isArray(props.series) && props.series.length > 0
    ? String((props.series as unknown[])[0])
    : typeof props.unit === "string" && props.unit.includes("lần")
      ? "runs"
      : Object.keys(dataset.rows[0] ?? {}).find((key) => typeof dataset.rows[0]?.[key] === "number") ?? "value";

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
        <div ref={measure} className="cc-chart-box">
          <svg className="cc-chart" viewBox={`0 0 ${width} ${CHART_HEIGHT}`} role="img" aria-label={`${title}: ${seriesKey}`}>
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

function BarChart({ props, dataset }: RendererProps): ReactElement {
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

  const seriesKey =
    Object.keys(dataset.rows[0] ?? {}).find((key) => typeof dataset.rows[0]?.[key] === "number") ?? "value";
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
        <div ref={measure} className="cc-chart-box">
          <svg className="cc-chart" viewBox={`0 0 ${width} ${CHART_HEIGHT}`} role="img" aria-label={`${title}: ${seriesKey}`}>
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

function DataTable({ props, dataset, onAction }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.table.title"));
  const [selected, setSelected] = useState<number | undefined>(undefined);

  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="table">
        <Unavailable reason={t("widgets.table.noData")} />
      </Frame>
    );
  }

  const columns = dataset.rows[0] === undefined ? [] : Object.keys(dataset.rows[0]);
  const rows = dataset.rows;
  // A column is numeric when it has a number and every present value is one; numbers align right so digits line up.
  const numericColumns = new Set(
    columns.filter(
      (column) =>
        rows.some((row) => typeof row[column] === "number") &&
        rows.every((row) => row[column] === undefined || row[column] === null || typeof row[column] === "number"),
    ),
  );

  return (
    <Frame title={title} dataset={dataset} role="table">
      {/*
       * Scrolls on its own, sideways for wide data and down for long data, with the header held in place, so a
       * table never pushes the conversation wider than the window. Focusable so the scroll is reachable by keyboard.
       */}
      <div className="cc-table-scroll" role="region" aria-label={title} tabIndex={0}>
      <table className="cc-table">
        <caption className="cc-sr-only">{title}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" data-numeric={numericColumns.has(column) ? "true" : undefined}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={index}
              data-selectable="true"
              aria-selected={selected === index}
              // Focusable and Enter/Space-activated so the same selection a pointer makes is reachable
              // from the keyboard; `role="button"` is not valid on `<tr>`, so the row keeps its table
              // semantics and gets its interactivity from tabIndex and the key handler alone.
              tabIndex={0}
              // Selection is a view action: it commits nothing and calls no model.
              onClick={() => {
                setSelected(index);
                onAction?.("row.select", { index, row });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setSelected(index);
                onAction?.("row.select", { index, row });
              }}
            >
              {columns.map((column) => (
                <td key={column} data-numeric={numericColumns.has(column) ? "true" : undefined}>
                  {String(row[column] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
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

function Donut({ props, dataset }: RendererProps): ReactElement {
  const t = useT();
  const title = String(props.title ?? t("widgets.donut.title"));
  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={t("widgets.donut.noData")} />
      </Frame>
    );
  }

  const valueKey = Object.keys(dataset.rows[0] ?? {}).find((key) => typeof dataset.rows[0]?.[key] === "number") ?? "value";
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
};

export function resolveRenderer(definitionId: string): CatalogRenderer | undefined {
  return CATALOG[definitionId];
}

export const RENDERER_IDS = Object.keys(CATALOG);
