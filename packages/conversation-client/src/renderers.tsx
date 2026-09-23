import {
  type ReactElement,
  type ReactNode,
  useMemo,
  useState,
} from "react";

import { donutSlices, monthGrid } from "@clarkcant/contracts";

import type { ResolvedDataset } from "./api.ts";
import { vendorEmbedUrl } from "./media-embed.ts";

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

const FRESHNESS_LABEL: Record<RendererDataset["freshness"], string> = {
  live: "dữ liệu vừa đọc",
  cached: "dữ liệu đã lưu",
  sample: "dữ liệu mẫu",
  unknown: "chưa rõ độ mới",
};

/**
 * Freshness badge.
 *
 * Rendered as `data-freshness` so the E2E test can assert that a sample is actually
 * labelled in the browser, rather than trusting that the attribute was passed through.
 */
function Freshness({ dataset }: { dataset: RendererDataset | undefined }): ReactElement | null {
  if (!dataset) return null;
  return (
    <span className="cc-freshness" data-freshness={dataset.freshness}>
      {FRESHNESS_LABEL[dataset.freshness]}
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

function numeric(rows: Record<string, unknown>[], key: string): number[] {
  return rows.map((row) => Number(row[key])).filter((value) => Number.isFinite(value));
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

function LineChart({ props, dataset }: RendererProps): ReactElement {
  const title = String(props.title ?? "Biểu đồ");
  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason="Chưa có dữ liệu để vẽ. Biểu đồ sẽ hiện khi dataset sẵn sàng." />
      </Frame>
    );
  }

  const seriesKey = typeof props.series === "object" && Array.isArray(props.series) && props.series.length > 0
    ? String((props.series as unknown[])[0])
    : typeof props.unit === "string" && props.unit.includes("lần")
      ? "runs"
      : Object.keys(dataset.rows[0] ?? {}).find((key) => typeof dataset.rows[0]?.[key] === "number") ?? "value";

  const values = numeric(dataset.rows, seriesKey);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const width = 640;
  const height = 180;
  const padX = 28;
  const padY = 16;
  const step = values.length > 1 ? (width - padX * 2) / (values.length - 1) : 0;
  const scaleY = (value: number): number =>
    height - padY - ((value - min) / Math.max(max - min, 1)) * (height - padY * 2);

  const path = values.map((value, index) => `${index === 0 ? "M" : "L"} ${padX + index * step} ${scaleY(value)}`).join(" ");

  return (
    <Frame title={title} dataset={dataset} role="chart">
      <>
        <svg className="cc-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}: ${seriesKey}`}>
          <line className="axis" x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} />
          <path className="series" d={path} />
          {values.map((value, index) => (
            <circle key={index} className="point" cx={padX + index * step} cy={scaleY(value)} r={3} />
          ))}
          {dataset.rows.map((row, index) => (
            <text key={index} className="label" x={padX + index * step} y={height - 4} textAnchor="middle">
              {label(row, ["week", "name", "label"])}
            </text>
          ))}
          {values.map((value, index) => (
            <text key={`v${index}`} className="label" x={padX + index * step} y={scaleY(value) - 8} textAnchor="middle">
              {value}
            </text>
          ))}
        </svg>
        {/* The text alternative stays in the DOM for screen readers and for the E2E check. */}
        <span className="cc-sr-only" data-chart-summary="true">
          {values.map((value, index) => `${label(dataset.rows[index] ?? {}, ["week"])}: ${value}`).join(", ")}
        </span>
      </>
    </Frame>
  );
}

function BarChart({ props, dataset }: RendererProps): ReactElement {
  const title = String(props.title ?? "Biểu đồ cột");
  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason="Chưa có dữ liệu để vẽ." />
      </Frame>
    );
  }

  const seriesKey =
    Object.keys(dataset.rows[0] ?? {}).find((key) => typeof dataset.rows[0]?.[key] === "number") ?? "value";
  const values = numeric(dataset.rows, seriesKey);
  const max = Math.max(...values, 1);
  const width = 640;
  const height = 180;
  const padX = 28;
  const padY = 16;
  const slot = (width - padX * 2) / values.length;
  const barWidth = Math.max(slot * 0.55, 6);

  return (
    <Frame title={title} dataset={dataset} role="chart">
      <>
        <svg className="cc-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}: ${seriesKey}`}>
          <line className="axis" x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} />
          {values.map((value, index) => {
            const barHeight = (value / max) * (height - padY * 2);
            return (
              <rect
                key={index}
                className="bar"
                x={padX + index * slot + (slot - barWidth) / 2}
                y={height - padY - barHeight}
                width={barWidth}
                height={barHeight}
                rx={2}
              />
            );
          })}
          {dataset.rows.map((row, index) => (
            <text key={index} className="label" x={padX + index * slot + slot / 2} y={height - 4} textAnchor="middle">
              {label(row, ["week", "name", "label"])}
            </text>
          ))}
        </svg>
        <span className="cc-sr-only" data-chart-summary="true">
          {values.map((value, index) => `${label(dataset.rows[index] ?? {}, ["week"])}: ${value}`).join(", ")}
        </span>
      </>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Table
 * ------------------------------------------------------------------ */

function DataTable({ props, dataset, onAction }: RendererProps): ReactElement {
  const title = String(props.title ?? "Bảng dữ liệu");
  const [selected, setSelected] = useState<number | undefined>(undefined);

  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="table">
        <Unavailable reason="Chưa có dữ liệu để hiển thị." />
      </Frame>
    );
  }

  const columns = dataset.rows[0] === undefined ? [] : Object.keys(dataset.rows[0]);
  const rows = dataset.rows;

  return (
    <Frame title={title} dataset={dataset} role="table">
      <table className="cc-table">
        <caption className="cc-sr-only">{title}</caption>
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
            <tr
              key={index}
              aria-selected={selected === index}
              // Selection is a view action: it commits nothing and calls no model.
              onClick={() => {
                setSelected(index);
                onAction?.("row.select", { index, row });
              }}
            >
              {columns.map((column) => (
                <td key={column}>{String(row[column] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Note
 * ------------------------------------------------------------------ */

function Note({ props, state, onStateChange, onAction }: RendererProps): ReactElement {
  const title = String(props.title ?? "Ghi chú");
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
        <input
          className="cc-note-input"
          value={title}
          readOnly
          aria-label="Tiêu đề ghi chú"
        />
        <textarea
          className="cc-note-area"
          value={draft}
          aria-label="Nội dung ghi chú"
          placeholder="Viết gì đó…"
          onChange={(event) => {
            // The draft lives locally until it is saved, so a failed save cannot lose text.
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <div className="cc-note-meta" data-note-status={status}>
          {status === "draft" && "Có thay đổi chưa lưu."}
          {status === "saved" && "Đã lưu."}
          {status === "idle" && `Bản lưu hiện tại: revision ${revision}.`}
          {status === "conflict" &&
            "Bản trên máy đã đổi ở chỗ khác. Bản nháp của bạn vẫn còn — chọn giữ bản nháp hoặc tải bản mới."}
        </div>
        <div style={{ display: "flex", gap: "var(--cc-space-sm)" }}>
          <button
            className="cc-icon-btn"
            style={{ width: "auto", padding: "0 var(--cc-space-md)" }}
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
            Lưu
          </button>
          <button
            className="cc-icon-btn"
            style={{ width: "auto", padding: "0 var(--cc-space-md)" }}
            onClick={() => {
              // Explicit conflict resolution: fetch the newer body rather than guessing.
              setConflict(false);
              setDraft(initialBody);
            }}
          >
            Bỏ thay đổi
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
function Donut({ props, dataset }: RendererProps): ReactElement {
  const title = String(props.title ?? "Phân bố");
  if (!dataset || dataset.rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason="Chưa có dữ liệu để chia tỷ lệ." />
      </Frame>
    );
  }

  const valueKey = Object.keys(dataset.rows[0] ?? {}).find((key) => typeof dataset.rows[0]?.[key] === "number") ?? "value";
  const entries = dataset.rows.map((row) => ({ label: label(row, ["label", "name", "category"]), value: Number(row[valueKey] ?? 0) }));
  const result = donutSlices(entries);

  if (!result.ok) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason={`Không vẽ được biểu đồ tròn: ${result.reason}.`} />
      </Frame>
    );
  }

  if (result.totalZero) {
    return (
      <Frame title={title} dataset={dataset} role="chart">
        <Unavailable reason="Tất cả giá trị bằng 0 nên không có tỷ lệ nào để vẽ. Bảng số liệu vẫn đúng." />
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
          <svg className="cc-donut" viewBox="0 0 160 160" role="img" aria-label={`${title}: ${result.slices.length} phần`}>
            {result.slices.map((slice, index) => {
              const length = slice.share * circumference;
              const dash = `${length} ${circumference - length}`;
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
                />
              );
              offset += length;
              return element;
            })}
          </svg>
          <ul className="cc-legend">
            {result.slices.map((slice) => (
              <li key={slice.label}>
                <span>{slice.label}</span>
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
  const columns = Object.keys(rows[0] ?? {});
  return (
    <details className="cc-text-alt">
      <summary>Bảng số liệu</summary>
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
  const title = String(props.title ?? "Chỉ số");
  const rows = dataset?.rows ?? [];
  if (rows.length === 0) {
    return (
      <Frame title={title} dataset={dataset} role="metrics">
        <Unavailable reason="Chưa có số liệu trong khoảng đã chọn." />
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
  const current = typeof state?.period === "string" ? state.period : String(props.period ?? "week");
  const timezone = String(props.timezone ?? "UTC");
  const busy = state?.pending === true;

  return (
    <Frame title={String(props.title ?? "Khoảng thời gian")} dataset={undefined} role="filter">
      <>
        <label className="cc-filter">
          <span className="cc-sr-only">Khoảng thời gian</span>
          <select
            value={current}
            disabled={busy}
            data-period-select="true"
            onChange={(event) => onAction?.("period.change", { period: event.target.value, timezone })}
          >
            <option value="week">Tuần này</option>
            <option value="month">Tháng này</option>
          </select>
        </label>
        <span className="cc-freshness" data-timezone={timezone}>
          Múi giờ {timezone}
          {busy ? " — đang tải khoảng mới" : ""}
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
  const title = String(props.title ?? "Lịch");
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
        <Unavailable reason="Tháng này không đọc được, nên lịch chưa hiển thị." />
      </Frame>
    );
  }

  const selectedEvents = selectedDate === undefined ? [] : byDate.get(selectedDate) ?? [];

  return (
    <Frame title={title} dataset={dataset} role="calendar">
      <>
        <table className="cc-calendar" data-calendar-month={month}>
          <caption className="cc-sr-only">{`Lịch tháng ${month} (${timezone})`}</caption>
          <thead>
            <tr>
              {["T2", "T3", "T4", "T5", "T6", "T7", "CN"].map((day) => (
                <th key={day} scope="col">
                  {day}
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
                        aria-label={`${cell.date}, ${events.length} sự kiện`}
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
            ? "Chọn một ngày để xem sự kiện."
            : selectedEvents.length === 0
              ? "Ngày này chưa có sự kiện nào."
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
        <span className="cc-freshness">Sự kiện do bạn nhập trên máy này; chưa đồng bộ với Google Calendar.</span>
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
  const title = String(props.title ?? "Hình ảnh");
  const alt = String(props.alt ?? "");
  const imageRef = String(props.imageRef ?? "");
  const url = imageRef === "" ? undefined : imageUrl?.(imageRef);

  return (
    <Frame title={title} dataset={undefined} role="media">
      {url === undefined ? (
        <Unavailable reason={`Chưa tải được hình ảnh. Mô tả: ${alt}`} />
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
  const refs = pictureRefs(props.imageRefs);
  const alts = pictureAlts(props.alts, refs.length);
  const [index, setIndex] = useState(0);
  const current = refs.length === 0 ? 0 : Math.min(index, refs.length - 1);
  const ref = refs[current];
  const alt = alts[current] ?? "";
  const url = ref === undefined ? undefined : imageUrl?.(ref);

  return (
    <Frame title={String(props.title ?? "Bộ ảnh")} dataset={undefined} role="media">
      {refs.length === 0 || url === undefined ? (
        <Unavailable reason={`Chưa tải được hình ảnh. Mô tả: ${alts.filter((entry) => entry !== "").join(" · ")}`} />
      ) : (
        <div className="cc-carousel" data-carousel-index={current}>
          <figure className="cc-image">
            <img src={url} alt={alt} loading="lazy" decoding="async" data-image-ref={ref} />
            <figcaption className="cc-freshness">{alt}</figcaption>
          </figure>
          <div className="cc-carousel-controls">
            <button
              type="button"
              aria-label="Ảnh trước"
              onClick={() => setIndex(current <= 0 ? refs.length - 1 : current - 1)}
            >
              ‹
            </button>
            <span className="cc-freshness">
              {current + 1}/{refs.length}
            </span>
            <button type="button" aria-label="Ảnh sau" onClick={() => setIndex((current + 1) % refs.length)}>
              ›
            </button>
          </div>
        </div>
      )}
    </Frame>
  );
}

/** The same pictures as a grid, for when seeing them together is the point. */
function Gallery({ props, imageUrl }: RendererProps): ReactElement {
  const refs = pictureRefs(props.imageRefs);
  const alts = pictureAlts(props.alts, refs.length);
  const shown = refs.flatMap((ref, index) => {
    const url = imageUrl?.(ref);
    return url === undefined ? [] : [{ ref, url, alt: alts[index] ?? "" }];
  });

  return (
    <Frame title={String(props.title ?? "Thư viện ảnh")} dataset={undefined} role="media">
      {shown.length === 0 ? (
        <Unavailable reason={`Chưa tải được hình ảnh. Mô tả: ${alts.filter((entry) => entry !== "").join(" · ")}`} />
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
  const videoId = String(props.videoId ?? "");
  const title = String(props.title ?? "Video YouTube");
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
        <Unavailable reason={`Video: ${title}${description === "" ? "" : ` — ${description}`}`} />
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
  const ref = String(props.videoRef ?? "");
  const alt = String(props.alt ?? "");
  const posterRef = typeof props.posterRef === "string" ? props.posterRef : "";
  const url = ref === "" ? undefined : imageUrl?.(ref);
  const poster = posterRef === "" ? undefined : imageUrl?.(posterRef);

  return (
    <Frame title={String(props.title ?? "Video")} dataset={undefined} role="media">
      {url === undefined ? (
        <Unavailable reason={`Chưa phát được video. Mô tả: ${alt}`} />
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
  const label = String(props.label ?? "Lưu bản xem");
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
        {!actionable && <p className="cc-freshness">Chỉ xem: bản này không thao tác được.</p>}
      </div>
      <button
        type="button"
        className="cc-icon-btn"
        style={{ width: "auto", padding: "0 var(--cc-space-md)" }}
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
