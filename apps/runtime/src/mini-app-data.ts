import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CompositionPeriod,
  type CompiledSection,
  type CompositionSection,
  type Instant,
  type PeriodRange,
  type SurfaceCompositionSpec,
  type Principal,
  bucketKeyOf,
  countsByBucket,
  donutSlices,
  localTimeToUtc,
  periodRange,
  summariseSeries,
} from "@clarkcant/contracts";
import {
  type CalendarEventRecord,
  type Database,
  type LocalImageRecord,
  allRows,
  deleteCalendarEvent,
  deleteLocalImage,
  getCalendarEvent,
  getLocalImage,
  insertCalendarEvent,
  insertLocalImage,
  listCalendarEvents,
  updateCalendarEvent,
  upsertDataset,
} from "@clarkcant/storage";

/**
 * Local data for composed surfaces.
 *
 * Everything here is derived from this node's own records: tasks and runs in SQLite, calendar
 * events the user typed, images the user imported. There is no sample data, no plausible default,
 * and no placeholder row — when the store is empty the surface shows an empty state with an
 * affordance to create something, because an overview that fills itself in with invented numbers
 * is worse than one that says it has nothing to show.
 *
 * Two definitions are load-bearing and are stated once, here:
 *
 * - **completed** means `state = 'succeeded'`, and its timestamp is `updated_at`. There is no
 *   `completed_at` column, and inventing one from `created_at` would report work as finished when
 *   it was started.
 * - **pending** means any non-terminal state. Failed and cancelled tasks are counted separately
 *   and are never folded into either figure.
 */

export const TERMINAL_TASK_STATES = ["succeeded", "failed", "cancelled"] as const;

/** Every payload a composed surface can reference, by kind. */
export type MiniAppDataRef = string;

export interface MiniAppDataDeps {
  db: Database;
  nodeId: string;
  /** Where imported image bytes live. Under the node's own data directory. */
  dataDir: string;
  now: () => Instant;
  newId: (prefix: string) => string;
}

/* ------------------------------------------------------------------ *
 * Task metrics
 * ------------------------------------------------------------------ */

export interface TaskMetric {
  id: "completed" | "pending" | "failed" | "created";
  label: string;
  value: number;
  unit: string;
  hint: string;
}

export interface TaskMetricsResult {
  range: PeriodRange;
  metrics: TaskMetric[];
  /** Rows for the metrics renderer: one per tile. */
  rows: Record<string, unknown>[];
  /** Rows for a donut over task outcomes, with the zero-total case already decided. */
  outcomeRows: Record<string, unknown>[];
  trendRows: Record<string, unknown>[];
  provenance: {
    nodeId: string;
    timezone: string;
    period: CompositionPeriod;
    from: string;
    to: string;
    /** Digest of the rows the figures were computed from, so a number can be traced to a read. */
    queryRevision: string;
    definitions: { completedAt: string; pending: string };
  };
}

interface TaskRow {
  state: string;
  created_at: string;
  updated_at: string;
  conversation_id: string;
}

/**
 * Compute the figures a period covers.
 *
 * The rows are read once and bucketed in memory. A local node's task table is small, and doing the
 * bucketing in SQL would mean writing the timezone arithmetic a second time in a place that cannot
 * be unit tested without a database.
 */
export function taskMetricsForRange(
  deps: MiniAppDataDeps,
  input: { period: CompositionPeriod; timezone: string; reference?: Date },
): TaskMetricsResult {
  const range = periodRange(input.period, input.reference ?? new Date(deps.now()), input.timezone);
  const rows = allRows<TaskRow>(
    deps.db,
    "SELECT state, created_at, updated_at, conversation_id FROM tasks WHERE home_node_id = ?",
    deps.nodeId,
  );

  const inRange = (instant: string): boolean => {
    const at = new Date(instant).getTime();
    return Number.isFinite(at) && at >= new Date(range.from).getTime() && at < new Date(range.to).getTime();
  };

  let completed = 0;
  let failed = 0;
  let created = 0;
  const createdInstants: string[] = [];
  const completedInstants: string[] = [];

  for (const row of rows) {
    if (inRange(row.created_at)) {
      created += 1;
      createdInstants.push(row.created_at);
    }
    if (row.state === "succeeded" && inRange(row.updated_at)) {
      completed += 1;
      completedInstants.push(row.updated_at);
    }
    if (!TERMINAL_TASK_STATES.includes(row.state as (typeof TERMINAL_TASK_STATES)[number])) {
      // Pending is a current-state count, not a per-period one: work that is still open is open
      // regardless of when it started.
    }
    if (row.state === "failed" && inRange(row.updated_at)) failed += 1;
  }

  const pending = rows.filter(
    (row) => !TERMINAL_TASK_STATES.includes(row.state as (typeof TERMINAL_TASK_STATES)[number]),
  ).length;
  const cancelled = rows.filter((row) => row.state === "cancelled" && inRange(row.updated_at)).length;

  const metrics: TaskMetric[] = [
    {
      id: "completed",
      label: "Hoàn thành",
      value: completed,
      unit: "task",
      hint: "state = succeeded, tính theo updated_at trong kỳ",
    },
    { id: "pending", label: "Đang mở", value: pending, unit: "task", hint: "mọi trạng thái chưa kết thúc" },
    { id: "failed", label: "Thất bại", value: failed, unit: "task", hint: "state = failed trong kỳ" },
    { id: "created", label: "Tạo mới", value: created, unit: "task", hint: "created_at trong kỳ" },
  ];

  const trendCounts = {
    created: countsByBucket(range, createdInstants),
    completed: countsByBucket(range, completedInstants),
  };

  const trendRows = range.buckets.map((bucket, index) => ({
    bucket: bucket.key,
    label: bucket.label,
    created: trendCounts.created[index]?.value ?? 0,
    completed: trendCounts.completed[index]?.value ?? 0,
  }));

  const outcomeEntries = [
    { label: "Hoàn thành", value: completed },
    { label: "Thất bại", value: failed },
    { label: "Đã huỷ", value: cancelled },
  ];
  const slices = donutSlices(outcomeEntries);
  const outcomeRows = slices.ok
    ? slices.slices.map((slice) => ({ label: slice.label, value: slice.value, share: slice.share }))
    : [];

  return {
    range,
    metrics,
    rows: metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      value: metric.value,
      unit: metric.unit,
      hint: metric.hint,
    })),
    outcomeRows,
    trendRows,
    provenance: {
      nodeId: deps.nodeId,
      timezone: input.timezone,
      period: input.period,
      from: range.from,
      to: range.to,
      queryRevision: digestOf(rows),
      definitions: {
        completedAt: "updated_at của task ở trạng thái succeeded (không có cột completed_at)",
        pending: "state không thuộc {succeeded, failed, cancelled}",
      },
    },
  };
}

function digestOf(rows: readonly TaskRow[]): string {
  const canonical = rows
    .map((row) => `${row.state}|${row.created_at}|${row.updated_at}|${row.conversation_id}`)
    .sort()
    .join("\n");
  return `sha256:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** Trend summary, so a renderer can decide its own empty/stale wording from one place. */
export function trendSummary(result: TaskMetricsResult): ReturnType<typeof summariseSeries> {
  return summariseSeries(result.trendRows.map((row) => Number(row.completed ?? 0)));
}

/* ------------------------------------------------------------------ *
 * Local calendar
 * ------------------------------------------------------------------ */

export const MAX_EVENT_TITLE = 200;

export type CalendarValidation =
  | { ok: true; title: string; startsAt: string; endsAt: string; timezone: string }
  | { ok: false; code: "INVALID_TITLE" | "INVALID_RANGE" | "INVALID_TIMEZONE" | "INVALID_INSTANT"; message: string };

/**
 * Validate a local event.
 *
 * An end before the start is refused rather than swapped: the two timestamps came from somewhere,
 * and silently reordering them hides the bug that produced them. An unknown timezone is refused
 * too, because `Intl` falling back to UTC would move every event in the month view.
 */
export function validateLocalEvent(input: {
  title: unknown;
  startsAt: unknown;
  endsAt: unknown;
  timezone: unknown;
}): CalendarValidation {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length === 0 || title.length > MAX_EVENT_TITLE) {
    return {
      ok: false,
      code: "INVALID_TITLE",
      message: `an event title must be 1–${MAX_EVENT_TITLE} characters`,
    };
  }
  const timezone = typeof input.timezone === "string" ? input.timezone : "";
  if (!isKnownTimezone(timezone)) {
    return { ok: false, code: "INVALID_TIMEZONE", message: `"${timezone}" is not a timezone this node knows` };
  }
  const startsAt = typeof input.startsAt === "string" ? input.startsAt : "";
  const endsAt = typeof input.endsAt === "string" ? input.endsAt : "";
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { ok: false, code: "INVALID_INSTANT", message: "start and end must be ISO instants" };
  }
  if (endMs <= startMs) {
    return { ok: false, code: "INVALID_RANGE", message: "an event must end after it starts" };
  }
  return { ok: true, title, startsAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(), timezone };
}

const timezoneCache = new Map<string, boolean>();

export function isKnownTimezone(timezone: string): boolean {
  if (timezone.length === 0 || timezone.length > 60) return false;
  const cached = timezoneCache.get(timezone);
  if (cached !== undefined) return cached;
  let known: boolean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    known = true;
  } catch {
    known = false;
  }
  timezoneCache.set(timezone, known);
  return known;
}

/** The local calendar day an instant falls on, in the event's own timezone. */
export function localDateOf(instant: string, timezone: string): string {
  const at = new Date(instant);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parts;
}

export function createLocalEvent(
  deps: MiniAppDataDeps,
  input: {
    principalId: Principal["principalId"];
    title: unknown;
    startsAt: unknown;
    endsAt: unknown;
    timezone: unknown;
  },
): { ok: true; event: CalendarEventRecord } | { ok: false; code: string; message: string } {
  const validated = validateLocalEvent(input);
  if (!validated.ok) return validated;

  const at = deps.now();
  const event: CalendarEventRecord = {
    eventId: deps.newId("cevt"),
    ownerPrincipalId: input.principalId,
    nodeId: deps.nodeId,
    title: validated.title,
    startsAt: validated.startsAt,
    endsAt: validated.endsAt,
    timezone: validated.timezone,
    localDate: localDateOf(validated.startsAt, validated.timezone),
    createdAt: at,
    updatedAt: at,
  };
  insertCalendarEvent(deps.db, event);
  return { ok: true, event };
}

export function updateLocalEvent(
  deps: MiniAppDataDeps,
  input: {
    principalId: Principal["principalId"];
    eventId: string;
    title: unknown;
    startsAt: unknown;
    endsAt: unknown;
    timezone: unknown;
  },
): { ok: true; event: CalendarEventRecord } | { ok: false; code: string; message: string } {
  const existing = getCalendarEvent(deps.db, input.eventId, input.principalId);
  if (existing === undefined) {
    // Reported as absent rather than forbidden: telling one principal that another principal's
    // event exists is itself a disclosure.
    return { ok: false, code: "EVENT_NOT_FOUND", message: "that event is not on this principal's calendar" };
  }
  const validated = validateLocalEvent(input);
  if (!validated.ok) return validated;

  const event: CalendarEventRecord = {
    ...existing,
    title: validated.title,
    startsAt: validated.startsAt,
    endsAt: validated.endsAt,
    timezone: validated.timezone,
    localDate: localDateOf(validated.startsAt, validated.timezone),
    updatedAt: deps.now(),
  };
  const changed = updateCalendarEvent(deps.db, event);
  if (!changed) {
    return { ok: false, code: "EVENT_NOT_FOUND", message: "that event is no longer on this principal's calendar" };
  }
  return { ok: true, event };
}

export function removeLocalEvent(
  deps: MiniAppDataDeps,
  input: { principalId: Principal["principalId"]; eventId: string },
): { ok: true } | { ok: false; code: "EVENT_NOT_FOUND"; message: string } {
  const removed = deleteCalendarEvent(deps.db, input.eventId, input.principalId, deps.now());
  return removed
    ? { ok: true }
    : { ok: false, code: "EVENT_NOT_FOUND", message: "that event is not on this principal's calendar" };
}

/** Calendar rows for the range, in the shape the calendar renderer draws. */
export function calendarRowsForRange(
  deps: MiniAppDataDeps,
  input: { principalId: Principal["principalId"]; range: PeriodRange },
): Record<string, unknown>[] {
  const events = listCalendarEvents(deps.db, {
    principalId: input.principalId,
    from: input.range.from,
    to: input.range.to,
    limit: 500,
  });
  return events.map((event) => ({
    eventId: event.eventId,
    date: event.localDate,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    /** Labelled so the UI can say plainly that this is a local record. */
    source: "local" as const,
  }));
}

/* ------------------------------------------------------------------ *
 * Imported images
 * ------------------------------------------------------------------ */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8192;
/** Raster only. An SVG or an HTML file served as an image is a script, not a picture. */
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type ImageSniff =
  | { ok: true; mimeType: (typeof ALLOWED_IMAGE_TYPES)[number]; width: number | undefined; height: number | undefined }
  | { ok: false; code: "IMAGE_TOO_LARGE" | "IMAGE_TYPE_NOT_ALLOWED" | "IMAGE_TYPE_MISMATCH" | "IMAGE_UNREADABLE"; message: string };

/**
 * Identify an image from its own bytes.
 *
 * The declared MIME type is not trusted and the extension is not consulted, because both are
 * chosen by whoever supplied the file. The magic bytes decide, and the declared type has to agree
 * with them afterwards: a PNG declared as `text/html` is refused rather than served with a
 * content type that would let a browser interpret it as a document.
 */
export function sniffImage(bytes: Uint8Array, declaredType: string): ImageSniff {
  if (bytes.byteLength === 0) {
    return { ok: false, code: "IMAGE_UNREADABLE", message: "the file is empty" };
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      code: "IMAGE_TOO_LARGE",
      message: `the file is ${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte image ceiling`,
    };
  }

  const detected = detectFormat(bytes);
  if (detected === undefined) {
    return {
      ok: false,
      code: "IMAGE_TYPE_NOT_ALLOWED",
      message: "the file is not a PNG, JPEG, WebP or GIF image",
    };
  }
  if (declaredType !== "" && declaredType !== detected.mimeType) {
    return {
      ok: false,
      code: "IMAGE_TYPE_MISMATCH",
      message: `the file is a ${detected.mimeType} but was declared as ${declaredType}`,
    };
  }
  if (
    detected.width !== undefined &&
    detected.height !== undefined &&
    (detected.width > MAX_IMAGE_DIMENSION || detected.height > MAX_IMAGE_DIMENSION)
  ) {
    return {
      ok: false,
      code: "IMAGE_UNREADABLE",
      message: `the image is ${detected.width}×${detected.height}, over the ${MAX_IMAGE_DIMENSION}-pixel ceiling`,
    };
  }
  return { ok: true, mimeType: detected.mimeType, width: detected.width, height: detected.height };
}

function detectFormat(
  bytes: Uint8Array,
): { mimeType: (typeof ALLOWED_IMAGE_TYPES)[number]; width: number | undefined; height: number | undefined } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR at offset 16.
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: FF D8 FF, then scan for a start-of-frame marker carrying the dimensions.
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return {
          mimeType: "image/jpeg",
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        };
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
    return { mimeType: "image/jpeg", width: undefined, height: undefined };
  }

  // GIF: "GIF87a" or "GIF89a", little-endian dimensions.
  if (bytes.byteLength >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === "GIF") {
    return { mimeType: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // WebP: "RIFF" .... "WEBP".
  if (
    bytes.byteLength >= 16 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
      const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
      return { mimeType: "image/webp", width, height };
    }
    return { mimeType: "image/webp", width: undefined, height: undefined };
  }

  return undefined;
}

export interface ImportImageInput {
  principalId: Principal["principalId"];
  bytes: Uint8Array;
  declaredMimeType: string;
  altText: unknown;
  /** Original file name, stored nowhere: it is only used to reject obvious mismatches in a message. */
  filename?: string;
}

export type ImageRejectionCode =
  | "IMAGE_TOO_LARGE"
  | "IMAGE_TYPE_NOT_ALLOWED"
  | "IMAGE_TYPE_MISMATCH"
  | "IMAGE_UNREADABLE"
  | "IMAGE_ALT_REQUIRED";

export type ImportImageResult =
  | { ok: true; image: LocalImageRecord }
  | { ok: false; code: ImageRejectionCode; message: string };

/**
 * Import an image into the node's approved store.
 *
 * Alt text is mandatory. An image without a description is unreadable to a screen reader and to
 * anyone using the text alternative of a snapshot, and making it optional would mean the
 * accessibility path silently degrades exactly when the image matters most.
 */
export function importLocalImage(deps: MiniAppDataDeps, input: ImportImageInput): ImportImageResult {
  const altText = typeof input.altText === "string" ? input.altText.trim() : "";
  if (altText.length === 0 || altText.length > 300) {
    return { ok: false, code: "IMAGE_ALT_REQUIRED", message: "an imported image needs alt text of 1–300 characters" };
  }

  const sniffed = sniffImage(input.bytes, input.declaredMimeType);
  if (!sniffed.ok) return sniffed;

  const digest = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
  const extension = sniffed.mimeType === "image/jpeg" ? "jpg" : sniffed.mimeType.split("/")[1] ?? "bin";
  const directory = join(deps.dataDir, "blobs");
  mkdirSync(directory, { recursive: true });
  const blobPath = join(directory, `${digest.slice("sha256:".length, "sha256:".length + 32)}.${extension}`);
  writeFileSync(blobPath, input.bytes, { mode: 0o600 });

  const image: LocalImageRecord = {
    imageId: deps.newId("img"),
    ownerPrincipalId: input.principalId,
    nodeId: deps.nodeId,
    artifactId: deps.newId("art"),
    mimeType: sniffed.mimeType,
    byteSize: input.bytes.byteLength,
    width: sniffed.width,
    height: sniffed.height,
    digest,
    altText,
    blobPath,
    createdAt: deps.now(),
  };
  insertLocalImage(deps.db, image);
  return { ok: true, image };
}

export function readLocalImage(
  deps: MiniAppDataDeps,
  input: { principalId: Principal["principalId"]; imageId: string },
): LocalImageRecord | undefined {
  return getLocalImage(deps.db, input.imageId, input.principalId);
}

export function removeLocalImage(
  deps: MiniAppDataDeps,
  input: { principalId: Principal["principalId"]; imageId: string },
): boolean {
  return deleteLocalImage(deps.db, input.imageId, input.principalId, deps.now());
}

/* ------------------------------------------------------------------ *
 * Dataset publication
 * ------------------------------------------------------------------ */

/**
 * Dataset ids are per principal.
 *
 * A derived dataset is addressed by an opaque reference, and two people on one node would
 * otherwise generate the same id for the same week and overwrite each other's ownership.
 */
export function derivedDatasetId(principalId: string, kind: string, range: PeriodRange): string {
  const owner = createHash("sha256").update(principalId).digest("hex").slice(0, 8);
  return `ds_${kind}_${owner}_${range.period}_${range.startDate}`;
}

export interface PublishedMiniAppData {
  range: PeriodRange;
  metricsRef: string;
  trendRef: string;
  outcomeRef: string;
  calendarRef: string;
  metrics: TaskMetricsResult;
  calendarRows: Record<string, unknown>[];
  imageRefs: { imageId: string; altText: string }[];
}

/**
 * Publish the datasets a composed surface references, and return their references.
 *
 * The rows are written into the `datasets` table so a live render resolves them the same way every
 * other widget does, and they are also returned so the snapshot bundle can materialise exactly
 * what was published. Reusing one read for both is what keeps the snapshot and the live view from
 * disagreeing at capture time.
 */
export function publishMiniAppData(
  deps: MiniAppDataDeps,
  input: {
    principalId: Principal["principalId"];
    period: CompositionPeriod;
    timezone: string;
    reference?: Date;
  },
): PublishedMiniAppData {
  const metrics = taskMetricsForRange(deps, {
    period: input.period,
    timezone: input.timezone,
    ...(input.reference === undefined ? {} : { reference: input.reference }),
  });
  const calendarRows = calendarRowsForRange(deps, { principalId: input.principalId, range: metrics.range });

  const metricsRef = derivedDatasetId(input.principalId, "metrics", metrics.range);
  const trendRef = derivedDatasetId(input.principalId, "trend", metrics.range);
  const outcomeRef = derivedDatasetId(input.principalId, "outcome", metrics.range);
  const calendarRef = derivedDatasetId(input.principalId, "calendar", metrics.range);

  const publishedAt = deps.now();
  const publish = (datasetId: string, rows: Record<string, unknown>[]): void => {
    upsertDataset(deps.db, {
      datasetId,
      originNodeId: deps.nodeId,
      rowCount: rows.length,
      freshness: "live",
      updatedAt: publishedAt,
      document: { rows },
      ownerPrincipalId: input.principalId,
    });
  };

  publish(metricsRef, metrics.rows);
  publish(trendRef, metrics.trendRows);
  publish(outcomeRef, metrics.outcomeRows);
  publish(calendarRef, calendarRows);

  return {
    range: metrics.range,
    metricsRef,
    trendRef,
    outcomeRef,
    calendarRef,
    metrics,
    calendarRows,
    imageRefs: [],
  };
}

export interface LiveSectionResolution {
  sections: CompiledSection[];
  availability: Record<string, RegionAvailabilityKind>;
  published: PublishedMiniAppData;
  period: CompositionPeriod;
  timezone: string;
}

/** How a region resolved for a live read. Mirrors what the client draws. */
export type RegionAvailabilityKind = "live" | "missing" | "denied";

/**
 * Resolve the rows a live composed surface shows right now.
 *
 * One read path for both the live surface and the snapshot: the live read fills `rows` from current
 * records, and the snapshot bundle carries the rows that were filled when it was captured. The
 * client draws the same shape either way, which is what keeps a snapshot render from needing a
 * second code path that can drift.
 */
export function resolveLiveSections(
  deps: MiniAppDataDeps,
  input: {
    principalId: Principal["principalId"];
    composition: SurfaceCompositionSpec;
    state: Record<string, unknown>;
  },
): LiveSectionResolution {
  const period: CompositionPeriod = input.state.period === "month" ? "month" : input.composition.initialState.period;
  const timezone =
    typeof input.state.timezone === "string" && input.state.timezone.length > 0
      ? input.state.timezone
      : input.composition.initialState.timezone;

  const published = publishMiniAppData(deps, { principalId: input.principalId, period, timezone });
  const availability: Record<string, RegionAvailabilityKind> = {};
  const sections: CompiledSection[] = input.composition.sections.map((section) => {
    const { rows, state: availabilityState } = rowsForSlot(section, published, deps, input.principalId);
    availability[section.sectionId] = availabilityState;
    return {
      ...section,
      ...(rows === undefined ? {} : { rows }),
    };
  });

  return { sections, availability, published, period, timezone };
}

function rowsForSlot(
  section: CompositionSection,
  published: PublishedMiniAppData,
  deps: MiniAppDataDeps,
  principalId: Principal["principalId"],
): { rows: Record<string, unknown>[] | undefined; state: RegionAvailabilityKind } {
  switch (section.slot) {
    case "metrics":
      return { rows: published.metrics.rows, state: published.metrics.rows.length === 0 ? "missing" : "live" };
    case "trend":
    case "table":
      return {
        rows: published.metrics.trendRows,
        state: published.metrics.trendRows.every((row) => Number(row.completed ?? 0) + Number(row.created ?? 0) === 0)
          ? "missing"
          : "live",
      };
    case "calendar":
      return { rows: published.calendarRows, state: published.calendarRows.length === 0 ? "missing" : "live" };
    case "image": {
      // An image reference that no longer resolves is reported as missing rather than drawn as a
      // broken picture, and the alt text stays part of the section so it can still be read.
      const imageRef = section.props.imageRef;
      if (typeof imageRef !== "string" || imageRef === "") return { rows: undefined, state: "missing" };
      const image = getLocalImage(deps.db, imageRef, principalId);
      return { rows: undefined, state: image === undefined ? "missing" : "live" };
    }
    default:
      return { rows: undefined, state: "live" };
  }
}

/** Where a local day starts, exposed so a caller can build a range without duplicating the math. */
export function dayStartUtc(date: { year: number; month: number; day: number }, timezone: string): string {
  return localTimeToUtc(date.year, date.month, date.day, timezone).toISOString();
}

/** Which bucket an instant belongs to, for callers that already hold a range. */
export { bucketKeyOf };
