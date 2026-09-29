import { civilParts, monthGrid } from "./period.ts";
import { clipWithMarker } from "./text-rules.ts";
import type { StateMigrationStep } from "./widgets.ts";
import type { SemanticValue } from "./widget-semantic.ts";
import { SNAPSHOT_TEXT_LIMIT } from "./widgets.ts";

/**
 * The calendar's three views — month, week and agenda — and the events they draw, read the same way by the node and the
 * page.
 *
 * Every event is placed on the days it covers in the calendar's own timezone, so an event that crosses midnight is on
 * both days and an event that runs for three days is on all three. An all-day event is a run of calendar dates, not a
 * pair of instants: it is on the same dates wherever it is looked at, as iCalendar and Google Calendar treat it, because
 * reading it as midnight in some timezone is how an all-day event drifts onto the day before.
 *
 * What a person changes — the view, the day selected, the event selected — is widget state the node holds, changed
 * through one bound view operation (`calendar.view`) the node checks against the rows it holds now. Adding, moving or
 * removing an event is not the calendar's to do: that stays a bound capability of whatever owns the events.
 */

export const CALENDAR_ID = "canvas.calendar@1";

export const CALENDAR_VIEWS = ["month", "week", "agenda"] as const;
export type CalendarViewKind = (typeof CALENDAR_VIEWS)[number];

/** The one view operation the calendar is bound to: it sets the view, the selected day and the selected event together. */
export const CALENDAR_VIEW_OPERATION = "calendar.view";

/**
 * The calendar's state version.
 *
 * Version 1 held only `selectedDate`, because the calendar had one view. Version 2 names the view; a version 1 state is
 * a month view, which is what the step below says, so a calendar saved before there were views opens as it was.
 */
export const CALENDAR_STATE_VERSION = 2;
export const CALENDAR_STATE_MIGRATIONS: readonly StateMigrationStep[] = [
  { from: 1, to: 2, ops: [{ op: "default", key: "view", value: "month" }] },
];

/** Rows one calendar reads. A longer dataset is read from its first rows, and the calendar says how many it left out. */
export const MAX_CALENDAR_EVENTS = 500;
export const MAX_EVENT_ID = 200;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in `YYYY-MM-DD` form: 2026-02-30 is not one. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The date `days` after `date`, both `YYYY-MM-DD`. Calendar arithmetic, so a 23-hour day is still one day. */
export function addDaysIso(date: string, days: number): string {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

/** The Monday-to-Sunday week `date` falls in. */
export function weekDates(date: string): string[] {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  const monday = addDaysIso(date, -((weekday + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => addDaysIso(monday, index));
}

const knownZones = new Map<string, boolean>();

/** Whether this runtime can place instants in `timeZone`; an unknown one would silently fall back to UTC elsewhere. */
export function isKnownTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 60) return false;
  const cached = knownZones.get(timeZone);
  if (cached !== undefined) return cached;
  let known = true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    known = false;
  }
  knownZones.set(timeZone, known);
  return known;
}

/** The calendar date an instant falls on in a timezone. */
export function dateInZone(at: Date, timeZone: string): string {
  const parts = civilParts(at, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** The wall-clock time an instant shows in a timezone, `HH:MM` on a 24-hour clock. */
export function timeInZone(at: Date, timeZone: string): string {
  const parts = civilParts(at, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ *
 * The events
 * ------------------------------------------------------------------ */

/** One event as the calendar draws it. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** An all-day event: a run of dates, the same wherever it is seen. */
  allDay: boolean;
  /** First day the event is on, in the calendar's timezone (or its own dates, when it is all-day). */
  startDate: string;
  /** Last day the event is on, inclusive. */
  lastDate: string;
  /** Instants, for a timed event. A row with a date and no instants is on that date with no time. */
  startsAt?: string;
  endsAt?: string;
  /** The timezone the event was written in, when the row names one; its times are shown in the calendar's. */
  timezone?: string;
  source?: string;
}

export interface CalendarEvents {
  events: CalendarEvent[];
  /** Rows read that are not an event the calendar can place: no title, no date, an end before the start. */
  unreadable: number;
  /** Rows in the dataset; more than were read when the calendar read only its first rows. */
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function eventId(row: Record<string, unknown>, index: number): string {
  const own = row.eventId ?? row.id;
  if (typeof own === "string" && own.trim() !== "" && own.length <= MAX_EVENT_ID) return own;
  if (typeof own === "number" && Number.isFinite(own)) return String(own);
  return `row-${String(index + 1)}`;
}

/**
 * The events in a calendar dataset's rows, placed on the days they cover in `timeZone`.
 *
 * A row is read in one of three shapes:
 * - all-day: `allDay: true` with `startDate` and an exclusive `endDate` (the iCalendar and Google Calendar convention), or
 *   only `startDate` or `date` for a single day;
 * - timed: `startsAt` and `endsAt` instants, on every day from the one it starts on to the one it is still running on;
 * - dated: a `date` with no instants, on that day with no time.
 * A row that fits none of them, has no title, or ends before it starts is counted as unreadable rather than guessed at.
 */
export function readCalendarEvents(rows: readonly unknown[], timeZone: string): CalendarEvents {
  const read = rows.slice(0, MAX_CALENDAR_EVENTS);
  const events: CalendarEvent[] = [];
  let unreadable = 0;
  read.forEach((row, index) => {
    const event = isRecord(row) ? readEvent(row, index, timeZone) : undefined;
    if (event === undefined) unreadable += 1;
    else events.push(event);
  });
  return { events: events.sort(compareEvents), unreadable, total: rows.length };
}

function readEvent(row: Record<string, unknown>, index: number, timeZone: string): CalendarEvent | undefined {
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (title === "") return undefined;
  const common = {
    id: eventId(row, index),
    title,
    ...(typeof row.timezone === "string" && row.timezone !== "" ? { timezone: row.timezone } : {}),
    ...(typeof row.source === "string" && row.source !== "" ? { source: row.source } : {}),
  };

  if (row.allDay === true) {
    const startDate = isIsoDate(row.startDate) ? row.startDate : isIsoDate(row.date) ? row.date : undefined;
    if (startDate === undefined) return undefined;
    const endDate = isIsoDate(row.endDate) ? row.endDate : addDaysIso(startDate, 1);
    // The end is the day after the last one, so an end on or before the start is an event of no days.
    if (endDate <= startDate) return undefined;
    return { ...common, allDay: true, startDate, lastDate: addDaysIso(endDate, -1) };
  }

  const start = instant(row.startsAt);
  const end = instant(row.endsAt);
  if (start !== undefined && end !== undefined) {
    if (end < start) return undefined;
    // An event that ends at midnight is not on the day that midnight begins, so its last day is read a moment before.
    const lastMoment = end > start ? end - 1 : start;
    return {
      ...common,
      allDay: false,
      startDate: dateInZone(new Date(start), timeZone),
      lastDate: dateInZone(new Date(lastMoment), timeZone),
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
    };
  }

  if (isIsoDate(row.date)) return { ...common, allDay: false, startDate: row.date, lastDate: row.date };
  return undefined;
}

/** All-day and dated events first, then timed ones by when they start; a tie is broken by title, then id. */
function compareEvents(left: CalendarEvent, right: CalendarEvent): number {
  const leftTimed = left.startsAt !== undefined;
  const rightTimed = right.startsAt !== undefined;
  if (leftTimed !== rightTimed) return leftTimed ? 1 : -1;
  const byStart = leftTimed ? (left.startsAt ?? "").localeCompare(right.startsAt ?? "") : left.startDate.localeCompare(right.startDate);
  if (byStart !== 0) return byStart;
  const byTitle = left.title.localeCompare(right.title);
  return byTitle !== 0 ? byTitle : left.id.localeCompare(right.id);
}

/** Whether an event is on `date`. */
export function isOnDay(event: CalendarEvent, date: string): boolean {
  return event.startDate <= date && date <= event.lastDate;
}

/** The events on `date`, in the calendar's order. */
export function eventsOnDay(events: readonly CalendarEvent[], date: string): CalendarEvent[] {
  return events.filter((event) => isOnDay(event, date));
}

/** How many days an event covers. */
export function eventDayCount(event: CalendarEvent): number {
  return Math.round((Date.parse(`${event.lastDate}T00:00:00Z`) - Date.parse(`${event.startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * When an event is, in words and in the calendar's timezone: "all day", "all day, 2026-10-05 to 2026-10-07",
 * "2026-10-05 at 09:00–10:00", "2026-10-05 at 22:00 to 2026-10-06 at 02:00", or the date alone for a row with no time.
 *
 * The date and the time are joined by "at" rather than a space: ten digits separated only by dashes and spaces are what
 * the redaction of phone numbers looks for, and a semantic document that says "[redacted]" for a time says nothing.
 */
export function eventWhenText(event: CalendarEvent, timeZone: string): string {
  if (event.allDay) {
    return event.startDate === event.lastDate ? `${event.startDate}, all day` : `all day, ${event.startDate} to ${event.lastDate}`;
  }
  if (event.startsAt === undefined || event.endsAt === undefined) return event.startDate;
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const endDate = dateInZone(end, timeZone);
  return endDate === event.startDate
    ? `${event.startDate} at ${timeInZone(start, timeZone)}–${timeInZone(end, timeZone)}`
    : `${event.startDate} at ${timeInZone(start, timeZone)} to ${endDate} at ${timeInZone(end, timeZone)}`;
}

/* ------------------------------------------------------------------ *
 * The month, and the days a calendar may select
 * ------------------------------------------------------------------ */

/** The dates a calendar of `month` draws: six Monday-to-Sunday weeks, including the neighbouring months' days. */
export function calendarGridDates(month: string): string[] {
  return monthGrid(month, "UTC").map((cell) => cell.date);
}

/** The month's own days, first to last. */
export function monthDates(month: string): string[] {
  return monthGrid(month, "UTC")
    .filter((cell) => cell.inMonth)
    .map((cell) => cell.date);
}

/**
 * The day the week view shows and the keyboard starts from: the selected day, else today when it is on the calendar,
 * else the first of the month.
 */
export function calendarFocusDate(month: string, selectedDate: string | undefined, today: string | undefined): string {
  const grid = calendarGridDates(month);
  if (selectedDate !== undefined && grid.includes(selectedDate)) return selectedDate;
  const own = monthDates(month);
  if (today !== undefined && own.includes(today)) return today;
  return own[0] ?? grid[0] ?? "";
}

/* ------------------------------------------------------------------ *
 * The view a person set
 * ------------------------------------------------------------------ */

export interface CalendarViewState {
  view: CalendarViewKind;
  selectedDate?: string;
  selectedEventId?: string;
}

const VIEW_KEYS = new Set(["view", "selectedDate", "selectedEventId"]);

function isView(value: unknown): value is CalendarViewKind {
  return typeof value === "string" && (CALENDAR_VIEWS as readonly string[]).includes(value);
}

/**
 * Everything wrong with a view a page asks the node to hold.
 *
 * The view is one of the three; a selected day is one the calendar of `month` draws; a selected event is one of the
 * events the node reads from the rows it holds now, on the selected day when a day is selected too.
 */
export function calendarViewProblems(month: string, input: unknown, events: readonly CalendarEvent[]): string[] {
  if (!isRecord(input)) return ["a calendar view is an object with view, selectedDate and selectedEventId"];
  const extra = Object.keys(input).filter((key) => !VIEW_KEYS.has(key));
  if (extra.length > 0) return [`a calendar view carries view, selectedDate and selectedEventId, not ${extra.slice(0, 5).join(", ")}`];

  const problems: string[] = [];
  if (!isView(input.view)) problems.push(`the view is one of ${CALENDAR_VIEWS.join(", ")}`);

  const grid = calendarGridDates(month);
  const date = input.selectedDate;
  if (date !== undefined) {
    if (!isIsoDate(date)) problems.push("the selected day is a date in YYYY-MM-DD form");
    else if (!grid.includes(date)) problems.push(`${date} is not on this calendar, which shows ${grid[0] ?? "?"} to ${grid.at(-1) ?? "?"}`);
  }

  const selected = input.selectedEventId;
  if (selected !== undefined) {
    if (typeof selected !== "string" || selected === "" || selected.length > MAX_EVENT_ID) {
      problems.push("the selected event is named by its id");
    } else {
      const event = events.find((candidate) => candidate.id === selected);
      if (event === undefined) problems.push(`"${clipWithMarker(selected, 64, "…")}" is not an event on this calendar now`);
      else if (isIsoDate(date) && !isOnDay(event, date)) problems.push(`"${event.title}" is not on ${date}`);
    }
  }
  return problems;
}

/**
 * The view in `state`, read leniently: what no longer fits is dropped rather than refused.
 *
 * Used where the state is shown rather than written, so a view stored before an event was removed still draws, without
 * the selection on an event that is gone. A state with no view — the calendar's first state version, or none — is the
 * view the calendar was placed with, which is the month unless its props say otherwise.
 */
export function readCalendarState(
  state: unknown,
  month: string,
  initialView: unknown,
  events?: readonly CalendarEvent[],
): CalendarViewState {
  const body = isRecord(state) ? state : {};
  const view = isView(body.view) ? body.view : isView(initialView) ? initialView : "month";
  const grid = calendarGridDates(month);
  const selectedDate = isIsoDate(body.selectedDate) && grid.includes(body.selectedDate) ? body.selectedDate : undefined;
  const id = body.selectedEventId;
  const event = typeof id === "string" && events !== undefined ? events.find((candidate) => candidate.id === id) : undefined;
  const keepEvent =
    typeof id === "string" && id !== "" && (events === undefined || (event !== undefined && (selectedDate === undefined || isOnDay(event, selectedDate))));
  return {
    view,
    ...(selectedDate === undefined ? {} : { selectedDate }),
    ...(keepEvent ? { selectedEventId: id } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * What the calendar says, as text and as semantic state
 * ------------------------------------------------------------------ */

export interface CalendarSubject {
  title?: string;
  month: string;
  timeZone: string;
}

function inMonth(events: readonly CalendarEvent[], month: string): CalendarEvent[] {
  const days = monthDates(month);
  const first = days[0] ?? "";
  const last = days.at(-1) ?? "";
  return events.filter((event) => event.startDate <= last && event.lastDate >= first);
}

function cutText(read: CalendarEvents): string {
  const parts: string[] = [];
  const left = read.total - Math.min(read.total, MAX_CALENDAR_EVENTS);
  if (left > 0) parts.push(`the first ${String(MAX_CALENDAR_EVENTS)} of ${String(read.total)} rows`);
  if (read.unreadable > 0) parts.push(`${String(read.unreadable)} row(s) not readable as events`);
  return parts.join("; ");
}

/**
 * The calendar as plain text: the text alternative a reader gets when it cannot be drawn, kept with the snapshot.
 *
 * Each event of the month once, with when it is in the calendar's timezone, so a transcript that outlives the dataset
 * still says what the calendar showed.
 */
export function calendarText(subject: CalendarSubject, read: CalendarEvents, limit: number = SNAPSHOT_TEXT_LIMIT): string {
  const head = `${subject.title === undefined ? "" : `${subject.title}: `}Calendar for ${subject.month} (${subject.timeZone})`;
  const events = inMonth(read.events, subject.month);
  const cut = cutText(read);
  if (events.length === 0) return clipWithMarker(`${head}: no events.${cut === "" ? "" : ` (${cut})`}`, limit);
  const lines = events.map((event) => `${event.title} (${eventWhenText(event, subject.timeZone)})`);
  return clipWithMarker(`${head}: ${String(events.length)} event(s)${cut === "" ? "" : ` (${cut})`}. ${lines.join("; ")}.`, limit);
}

/**
 * What the calendar means for voice and `inspect_ui`: the view, the day and event selected, and what is on that day, all
 * from the node's own state and rows.
 *
 * `read` is undefined when the dataset is no longer on the node, and the summary then says so instead of describing
 * events nobody can see.
 */
export function calendarSemantic(
  subject: CalendarSubject,
  read: CalendarEvents | undefined,
  view: CalendarViewState,
): { title?: string; summary: string; values: Record<string, SemanticValue>; selectedIds: string[] } {
  const title = subject.title === undefined ? {} : { title: subject.title };
  const values: Record<string, SemanticValue> = {
    view: view.view,
    month: subject.month,
    timezone: subject.timeZone,
    ...(view.selectedDate === undefined ? {} : { selectedDate: view.selectedDate }),
  };
  const head = `Calendar for ${subject.month} (${subject.timeZone}), ${view.view} view`;
  if (read === undefined) {
    return { ...title, summary: `${head}; its events are not available on this node`, values, selectedIds: [] };
  }

  const events = inMonth(read.events, subject.month);
  values.events = events.length;
  const cut = cutText(read);
  if (cut !== "") values.notShown = cut;

  let selectedIds: string[] = [];
  let summary = `${head}: ${String(events.length)} event(s) this month`;
  if (view.selectedDate !== undefined) {
    const day = eventsOnDay(read.events, view.selectedDate);
    values.selectedDayEvents = day.map((event) => event.title);
    summary += `; ${view.selectedDate} selected, ${String(day.length)} event(s) that day`;
  }
  if (view.selectedEventId !== undefined) {
    const event = read.events.find((candidate) => candidate.id === view.selectedEventId);
    if (event === undefined) {
      values.selectedEvent = "an event that is no longer in the data";
    } else {
      const when = eventWhenText(event, subject.timeZone);
      values.selectedEvent = `${event.title} (${when})`;
      if (event.timezone !== undefined && event.timezone !== subject.timeZone) values.selectedEventTimezone = event.timezone;
      selectedIds = [event.id];
      summary += `; selected event: ${event.title}, ${when}`;
    }
  }
  return { ...title, summary, values, selectedIds };
}
