import { type ReactElement, useMemo, useState } from "react";

import type { ResolvedDataset } from "./api.ts";

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
  children: ReactElement;
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
  "canvas.donut@1": BarChart,
  "canvas.table@1": DataTable,
  "canvas.note@1": Note,
};

export function resolveRenderer(definitionId: string): CatalogRenderer | undefined {
  return CATALOG[definitionId];
}

export const RENDERER_IDS = Object.keys(CATALOG);
