import { z } from "zod";

import { dateInZone, isIsoDate, isKnownTimeZone, timeInZone } from "./calendar-view.ts";
import { STATUS_TONES, type StatusTone } from "./status-cards.ts";
import { cardSchemaProblems, clipWithMarker, hiddenCharacterProblem, hiddenCharacterSegments, oneLineText } from "./text-rules.ts";
import type { SemanticValue } from "./widget-semantic.ts";
import { SNAPSHOT_TEXT_LIMIT } from "./widgets.ts";

/**
 * An activity timeline: dated entries the model states, sorted by time and grouped by day.
 *
 * Every entry is what the model wrote when it placed the timeline. Nothing here reads a feed or keeps itself current, so
 * the timeline never says it is live; newer entries arrive as new props.
 *
 * One description serves the node and the page. The node refuses props that fail `timelineProblems` before an instance
 * exists and checks every selection with `timelineSelectionProblems` against the entries it holds; the page reads the
 * same props with `readTimeline` and groups them by the same rule. The day an entry is on is read in the timeline's own
 * timezone — the one the node stored when it placed it — so the node, the page, a transcript and a screen reader put an
 * entry on the same day wherever it is opened. An all-day entry is a date, not an instant, and is on that date everywhere.
 */

export const TIMELINE_ID = "canvas.timeline@1";

/** The one view operation a timeline is bound to: it selects an entry, or clears the selection. */
export const TIMELINE_SELECT_OPERATION = "timeline.select";

export const TIMELINE_ORDERS = ["newest", "oldest"] as const;
export type TimelineOrder = (typeof TIMELINE_ORDERS)[number];

/** Entries one timeline holds. A longer list is refused; a model that leaves some out says so with `truncated`. */
export const MAX_TIMELINE_ENTRIES = 200;
export const MAX_TIMELINE_ID = 120;
export const MAX_TIMELINE_TITLE = 200;
export const MAX_TIMELINE_DESCRIPTION = 1000;
export const MAX_TIMELINE_ACTOR = 80;
export const MAX_TIMELINE_TIMEZONE = 60;
export const TIMELINE_PAGE_SIZES = { min: 5, max: 50, default: 10 } as const;

/**
 * When an entry happened: a date (`2026-09-30`) for an all-day entry, or an instant with its offset
 * (`2026-09-30T09:15:00+07:00`, `2026-09-30T02:15:00Z`). A time without an offset is refused: it names a different moment
 * in every timezone, and the timeline cannot know which one the model meant.
 */
export const TIMELINE_AT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:\\d{2}))?$";
/** An IANA timezone name as it is spelled; whether this runtime knows it is checked apart. */
export const TIMELINE_TIMEZONE_PATTERN = "^[A-Za-z][A-Za-z0-9_+\\-/]*$";

const AT = new RegExp(TIMELINE_AT_PATTERN, "u");
const INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u;

/**
 * How a text field treats a hidden character: the node refuses one, with the reason; the page keeps it, so a timeline
 * stored before a rule tightened is still drawn, with each hidden character shown as a marker instead of applied.
 */
type HiddenMode = "refuse" | "keep";

function lineText(max: number, required: boolean, hidden: HiddenMode) {
  if (hidden === "refuse") return oneLineText(max, required);
  return z
    .string()
    .max(max, `is longer than ${String(max)} characters`)
    .transform((value) => value.normalize("NFC").trim())
    .refine((value) => !required || value !== "", "is empty");
}

function manyLinesText(max: number, hidden: HiddenMode) {
  return z
    .string()
    .max(max, `is longer than ${String(max)} characters`)
    .superRefine((value, ctx) => {
      if (hidden === "keep") return;
      const problem = hiddenCharacterProblem(value, { lineBreaks: true });
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    })
    .transform((value) => value.normalize("NFC").trim());
}

/** An id is matched exactly, so it is never trimmed or normalised; one of spaces only names nothing a person can see. */
function idText(hidden: HiddenMode) {
  return z
    .string()
    .min(1, "is empty")
    .max(MAX_TIMELINE_ID, `is longer than ${String(MAX_TIMELINE_ID)} characters`)
    .superRefine((value, ctx) => {
      const problem = hidden === "refuse" ? hiddenCharacterProblem(value) : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
      else if (value.trim() === "") ctx.addIssue({ code: "custom", message: "is only spaces" });
    });
}

function timelineSchema(hidden: HiddenMode) {
  const entry = z.strictObject({
    id: idText(hidden),
    at: z
      .string()
      .max(40, "is longer than 40 characters")
      .regex(AT, "is not a date (2026-09-30) or an instant with its offset (2026-09-30T09:15:00+07:00)"),
    title: lineText(MAX_TIMELINE_TITLE, true, hidden),
    description: manyLinesText(MAX_TIMELINE_DESCRIPTION, hidden).optional(),
    actor: lineText(MAX_TIMELINE_ACTOR, false, hidden).optional(),
    tone: z.enum(STATUS_TONES, `is not one of ${STATUS_TONES.join(", ")}`).optional(),
  });
  return z.strictObject({
    title: lineText(MAX_TIMELINE_TITLE, false, hidden).optional(),
    entries: z.array(entry).max(MAX_TIMELINE_ENTRIES, `has more than ${String(MAX_TIMELINE_ENTRIES)} entries; place the most recent and set truncated`),
    order: z.enum(TIMELINE_ORDERS, `is not one of ${TIMELINE_ORDERS.join(", ")}`).optional(),
    pageSize: z
      .int(`is not a whole number from ${String(TIMELINE_PAGE_SIZES.min)} to ${String(TIMELINE_PAGE_SIZES.max)}`)
      .min(TIMELINE_PAGE_SIZES.min, `is below ${String(TIMELINE_PAGE_SIZES.min)}`)
      .max(TIMELINE_PAGE_SIZES.max, `is above ${String(TIMELINE_PAGE_SIZES.max)}`)
      .optional(),
    timezone: z
      .string()
      .min(1, "is empty")
      .max(MAX_TIMELINE_TIMEZONE, `is longer than ${String(MAX_TIMELINE_TIMEZONE)} characters`)
      .regex(new RegExp(TIMELINE_TIMEZONE_PATTERN, "u"), "is not an IANA timezone name such as Asia/Saigon")
      .optional(),
    truncated: z.boolean().optional(),
  });
}

const STRICT = timelineSchema("refuse");
const KEEPING = timelineSchema("keep");

/* ------------------------------------------------------------------ *
 * The entries
 * ------------------------------------------------------------------ */

/** One entry as the timeline reads it. */
export interface TimelineEntry {
  id: string;
  /** What the model wrote, kept so the text and the semantic document say the time the model gave. */
  at: string;
  title: string;
  description?: string;
  actor?: string;
  tone: StatusTone;
  /** A date with no time: on that date wherever it is seen. */
  allDay: boolean;
  /** The instant, in milliseconds since the epoch; for an all-day entry, the start of its date in UTC, for ordering only. */
  ms: number;
  /** The day it is on in the timeline's timezone, `YYYY-MM-DD`. */
  day: string;
  /** The wall-clock time it shows in the timeline's timezone, `HH:MM`; absent for an all-day entry. */
  time?: string;
  /** Where the model put it, so two entries at one instant keep the model's order. */
  index: number;
}

export interface Timeline {
  title?: string;
  /** Sorted in the timeline's order: by day, all-day entries first within a day, then by instant, then as written. */
  entries: TimelineEntry[];
  order: TimelineOrder;
  pageSize: number;
  /** The timezone the days are read in. */
  timeZone: string;
  /** The model said it left entries out. */
  truncated: boolean;
}

/**
 * The instant or date an entry's `at` names, or undefined when it names neither.
 *
 * Read by hand rather than by `Date.parse`, which engines disagree about beyond three digits of a second: the node and
 * every browser read the same instant from the same text.
 */
export function readTimelineAt(at: unknown): { allDay: true; date: string } | { allDay: false; ms: number } | undefined {
  if (typeof at !== "string" || at.length > 40 || !AT.test(at)) return undefined;
  if (isIsoDate(at)) return { allDay: true, date: at };
  const match = INSTANT.exec(at);
  if (match === null) return undefined;
  const [, date = "", hourText = "", minuteText = "", secondText = "0", fraction = "", zone = "", sign = "+", offsetHours = "0", offsetMinutes = "0"] =
    match;
  const [hour, minute, second] = [Number(hourText), Number(minuteText), Number(secondText)];
  if (!isIsoDate(date) || hour > 23 || minute > 59 || second > 59) return undefined;
  if (Number(offsetHours) > 23 || Number(offsetMinutes) > 59) return undefined;
  const offset = zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes));
  const [year, month, day] = date.split("-").map(Number);
  const millis = fraction === "" ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));
  const ms = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour, minute, second, millis) - offset * 60_000;
  return Number.isFinite(ms) ? { allDay: false, ms } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Parsed = z.infer<typeof STRICT>;

/** What the schema says about the props, as the JSON Schema a model reads says it. */
export function timelineSchemaProblems(props: unknown): string[] {
  const result = STRICT.safeParse(props);
  return result.success ? [] : cardSchemaProblems(result.error.issues);
}

/** What the entries say that the schema cannot: an id used twice, a date that does not exist, an hour past 23. */
function entryProblems(parsed: Parsed): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  const badTimes: string[] = [];
  parsed.entries.forEach((entry, index) => {
    if (seen.has(entry.id)) repeated.add(entry.id);
    seen.add(entry.id);
    if (readTimelineAt(entry.at) === undefined) badTimes.push(`"entries.${String(index)}.at" (${entry.at})`);
  });
  if (repeated.size > 0) {
    problems.push(`ids repeat: ${[...repeated].slice(0, 5).map((id) => `"${clipWithMarker(id, 40, "…")}"`).join(", ")}; each entry needs its own id`);
  }
  if (badTimes.length > 0) problems.push(`not a real date or time: ${badTimes.slice(0, 5).join(", ")}`);
  return problems;
}

/**
 * Everything wrong with a timeline's props: what the schema says, then what it cannot say — an id used twice, a date
 * that does not exist (2026-02-30), an hour past 23, a timezone this runtime does not know.
 */
export function timelineProblems(props: unknown): string[] {
  const result = STRICT.safeParse(props);
  if (!result.success) return cardSchemaProblems(result.error.issues);
  const problems = entryProblems(result.data);
  const zone = result.data.timezone;
  if (zone !== undefined && !isKnownTimeZone(zone)) problems.push(`"timezone": ${zone} is not a timezone this node knows`);
  return problems;
}

function compareEntries(order: TimelineOrder) {
  const direction = order === "newest" ? -1 : 1;
  return (left: TimelineEntry, right: TimelineEntry): number => {
    if (left.day !== right.day) return direction * left.day.localeCompare(right.day);
    // An all-day entry is about the whole day, so it heads its day in either order.
    if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
    if (left.ms !== right.ms) return direction * (left.ms - right.ms);
    return left.index - right.index;
  };
}

/**
 * The timeline its props describe, with each entry on its day in `timeZone`, or undefined when the props are not a
 * timeline.
 *
 * The timezone is the one the props name, else `timeZone`, else UTC; one this runtime does not know is read as UTC, and
 * the page says so. `keepHidden` is the page's reading: a hidden character is kept for the page to mark rather than
 * refused, and every other rule still holds.
 */
export function readTimeline(props: unknown, options: { timeZone?: string; keepHidden?: boolean } = {}): Timeline | undefined {
  const result = (options.keepHidden === true ? KEEPING : STRICT).safeParse(props);
  if (!result.success) return undefined;
  const parsed = result.data;
  if (entryProblems(parsed).length > 0) return undefined;
  const named = parsed.timezone ?? options.timeZone ?? "UTC";
  const timeZone = isKnownTimeZone(named) ? named : "UTC";
  const order = parsed.order ?? "newest";
  const entries: TimelineEntry[] = [];
  parsed.entries.forEach((entry, index) => {
    const when = readTimelineAt(entry.at);
    if (when === undefined) return;
    const description = entry.description === undefined || entry.description === "" ? {} : { description: entry.description };
    const actor = entry.actor === undefined || entry.actor === "" ? {} : { actor: entry.actor };
    const common = { id: entry.id, at: entry.at, title: entry.title, ...description, ...actor, tone: entry.tone ?? "neutral", index };
    if (when.allDay) {
      entries.push({ ...common, allDay: true, ms: Date.parse(`${when.date}T00:00:00Z`), day: when.date });
    } else {
      const at = new Date(when.ms);
      entries.push({ ...common, allDay: false, ms: when.ms, day: dateInZone(at, timeZone), time: timeInZone(at, timeZone) });
    }
  });
  entries.sort(compareEntries(order));
  return {
    ...(parsed.title === undefined || parsed.title === "" ? {} : { title: parsed.title }),
    entries,
    order,
    pageSize: parsed.pageSize ?? TIMELINE_PAGE_SIZES.default,
    timeZone,
    truncated: parsed.truncated === true,
  };
}

/** How many hidden characters the timeline's words hold: the page says so beside the markers it draws for them. */
export function timelineHiddenCount(timeline: Timeline): number {
  let count = 0;
  const add = (text: string | undefined): void => {
    if (text !== undefined) count += hiddenCharacterSegments(text).filter((segment) => "hidden" in segment).length;
  };
  add(timeline.title);
  for (const entry of timeline.entries) {
    add(entry.id);
    add(entry.title);
    add(entry.description);
    add(entry.actor);
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Days and pages
 * ------------------------------------------------------------------ */

export interface TimelineDay {
  day: string;
  entries: TimelineEntry[];
}

/** Consecutive entries grouped by the day they are on, in the order given. */
export function groupTimelineByDay(entries: readonly TimelineEntry[]): TimelineDay[] {
  const days: TimelineDay[] = [];
  for (const entry of entries) {
    const last = days.at(-1);
    if (last !== undefined && last.day === entry.day) last.entries.push(entry);
    else days.push({ day: entry.day, entries: [entry] });
  }
  return days;
}

/** How many pages the timeline has, at least one. */
export function timelinePageCount(timeline: Pick<Timeline, "entries" | "pageSize">): number {
  return Math.max(1, Math.ceil(timeline.entries.length / timeline.pageSize));
}

/** The page an entry is on, from 0; the first page when the entry is not on the timeline. */
export function timelinePageOf(timeline: Pick<Timeline, "entries" | "pageSize">, entryId: string | undefined): number {
  if (entryId === undefined) return 0;
  const index = timeline.entries.findIndex((entry) => entry.id === entryId);
  return index < 0 ? 0 : Math.floor(index / timeline.pageSize);
}

/** The entries on one page, grouped by day. */
export function timelinePage(timeline: Pick<Timeline, "entries" | "pageSize">, page: number): TimelineDay[] {
  const last = timelinePageCount(timeline) - 1;
  const at = Math.min(Math.max(0, Math.trunc(page)), last);
  return groupTimelineByDay(timeline.entries.slice(at * timeline.pageSize, (at + 1) * timeline.pageSize));
}

/** The first and last day the timeline covers, earliest first, or undefined when it has no entries. */
export function timelineRange(timeline: Pick<Timeline, "entries">): { from: string; to: string } | undefined {
  if (timeline.entries.length === 0) return undefined;
  const days = timeline.entries.map((entry) => entry.day).sort();
  return { from: days[0] ?? "", to: days.at(-1) ?? "" };
}

/** How many entries each tone has, every tone listed. */
export function timelineToneCounts(timeline: Pick<Timeline, "entries">): Record<StatusTone, number> {
  const counts = Object.fromEntries(STATUS_TONES.map((tone) => [tone, 0])) as Record<StatusTone, number>;
  for (const entry of timeline.entries) counts[entry.tone] += 1;
  return counts;
}

/* ------------------------------------------------------------------ *
 * The selection
 * ------------------------------------------------------------------ */

export interface TimelineSelection {
  selectedId?: string;
}

/**
 * Everything wrong with a selection a page asks the node to hold.
 *
 * `selectedId` names an entry of the timeline the node holds now; an empty one clears the selection. Nothing else is
 * carried.
 */
export function timelineSelectionProblems(timeline: Pick<Timeline, "entries">, input: unknown): string[] {
  if (!isRecord(input)) return ["a timeline selection is an object with selectedId"];
  const extra = Object.keys(input).filter((key) => key !== "selectedId");
  if (extra.length > 0) return [`a timeline selection carries only selectedId, not ${extra.slice(0, 5).join(", ")}`];
  const selected = input.selectedId;
  if (typeof selected !== "string") return ["selectedId names an entry by its id, or is empty to clear the selection"];
  if (selected === "") return [];
  if (selected.length > MAX_TIMELINE_ID || !timeline.entries.some((entry) => entry.id === selected)) {
    return [`"${clipWithMarker(selected, 64, "…")}" is not an entry on this timeline now`];
  }
  return [];
}

/**
 * The selection in `state`, read leniently: an entry that is no longer on the timeline is dropped rather than refused,
 * so a selection stored before the props changed still draws, without it.
 */
export function readTimelineSelection(state: unknown, timeline?: Pick<Timeline, "entries">): TimelineSelection {
  const selected = isRecord(state) ? state.selectedId : undefined;
  if (typeof selected !== "string" || selected === "" || selected.length > MAX_TIMELINE_ID) return {};
  if (timeline !== undefined && !timeline.entries.some((entry) => entry.id === selected)) return {};
  return { selectedId: selected };
}

/* ------------------------------------------------------------------ *
 * What the timeline says, as text and as semantic state
 * ------------------------------------------------------------------ */

/**
 * When an entry is, in words: "2026-09-30, all day" or "2026-09-30 at 09:15".
 *
 * The date and the time are joined by "at" rather than a space: ten digits separated only by dashes and spaces are what
 * the redaction of phone numbers looks for, and a semantic document that says "[redacted]" for a time says nothing.
 */
export function timelineWhenText(entry: Pick<TimelineEntry, "day" | "time">): string {
  return entry.time === undefined ? `${entry.day}, all day` : `${entry.day} at ${entry.time}`;
}

function entryLine(entry: TimelineEntry): string {
  const tone = entry.tone === "neutral" ? "" : ` [${entry.tone}]`;
  const actor = entry.actor === undefined ? "" : ` by ${entry.actor}`;
  return `${entry.time ?? "all day"} ${entry.title}${tone}${actor}`;
}

/**
 * The timeline as plain text: the text alternative a reader gets when it cannot be drawn, kept with the snapshot.
 *
 * A dated list: each day once, then its entries with their time, tone and actor, in the timeline's order.
 */
export function timelineText(timeline: Timeline, limit: number = SNAPSHOT_TEXT_LIMIT): string {
  const head = `${timeline.title === undefined ? "" : `${timeline.title}: `}Activity timeline (${timeline.timeZone}, ${timeline.order} first)`;
  const cut = timeline.truncated ? " More entries were left out." : "";
  if (timeline.entries.length === 0) return clipWithMarker(`${head}: no entries.${cut}`, limit);
  const days = groupTimelineByDay(timeline.entries).map((day) => `${day.day}: ${day.entries.map(entryLine).join("; ")}`);
  return clipWithMarker(`${head}: ${String(timeline.entries.length)} entr${timeline.entries.length === 1 ? "y" : "ies"}.${cut} ${days.join(". ")}.`, limit);
}

/**
 * What the timeline means for voice and `inspect_ui`: how many entries, the days they cover, the selected entry and how
 * many entries have each tone — all from the props and the state the node holds.
 */
export function timelineSemantic(
  timeline: Timeline,
  selection: TimelineSelection,
): { title?: string; summary: string; values: Record<string, SemanticValue>; selectedIds: string[] } {
  const range = timelineRange(timeline);
  const tones = timelineToneCounts(timeline);
  const values: Record<string, SemanticValue> = {
    entries: timeline.entries.length,
    order: timeline.order,
    timezone: timeline.timeZone,
    truncated: timeline.truncated,
    ...(range === undefined ? {} : { from: range.from, to: range.to }),
    ...Object.fromEntries(STATUS_TONES.map((tone) => [`tone${tone[0]?.toUpperCase() ?? ""}${tone.slice(1)}`, tones[tone]])),
  };
  const counted = STATUS_TONES.filter((tone) => tones[tone] > 0).map((tone) => `${String(tones[tone])} ${tone}`);
  let summary =
    timeline.entries.length === 0
      ? `Activity timeline (${timeline.timeZone}) with no entries`
      : `Activity timeline (${timeline.timeZone}): ${String(timeline.entries.length)} entr${timeline.entries.length === 1 ? "y" : "ies"}` +
        `${range === undefined ? "" : range.from === range.to ? ` on ${range.from}` : ` from ${range.from} to ${range.to}`}, ${counted.join(", ")}`;
  if (timeline.truncated) summary += "; more entries were left out";
  const selected = selection.selectedId === undefined ? undefined : timeline.entries.find((entry) => entry.id === selection.selectedId);
  if (selected === undefined) {
    return { ...(timeline.title === undefined ? {} : { title: timeline.title }), summary, values, selectedIds: [] };
  }
  values.selectedEntry = selected.title;
  values.selectedAt = timelineWhenText(selected);
  values.selectedTone = selected.tone;
  summary += `; selected: ${selected.title}, ${timelineWhenText(selected)}`;
  return { ...(timeline.title === undefined ? {} : { title: timeline.title }), summary, values, selectedIds: [selected.id] };
}
