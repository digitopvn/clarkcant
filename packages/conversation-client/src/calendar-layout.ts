import { type CalendarEvent, addDaysIso, eventDayCount, weekDates } from "@clarkcant/contracts";

/**
 * The calendar's layout and keyboard rules, kept apart from the component so they can be checked without a page.
 *
 * Dates are `YYYY-MM-DD` strings throughout: they compare in calendar order as text, and a day is a day whatever the
 * timezone's offset does that night.
 */

/**
 * The day an arrow key moves to on the month grid, or `undefined` when the key is not a move or would leave the grid.
 *
 * Left and right are a day, up and down a week, Home and End the start and end of the week: the moves a grid of days
 * is expected to have.
 */
export function moveDay(key: string, date: string, grid: readonly string[]): string | undefined {
  let next: string | undefined;
  if (key === "ArrowLeft") next = addDaysIso(date, -1);
  else if (key === "ArrowRight") next = addDaysIso(date, 1);
  else if (key === "ArrowUp") next = addDaysIso(date, -7);
  else if (key === "ArrowDown") next = addDaysIso(date, 7);
  else if (key === "Home") next = weekDates(date)[0];
  else if (key === "End") next = weekDates(date)[6];
  return next !== undefined && grid.includes(next) ? next : undefined;
}

/** The week the week view shows for `date`, and whether the grid has a week before and after it. */
export function calendarWeek(
  grid: readonly string[],
  date: string,
): { days: string[]; previous: string | undefined; next: string | undefined } {
  const days = weekDates(date);
  const back = addDaysIso(date, -7);
  const forward = addDaysIso(date, 7);
  return {
    days,
    previous: grid.includes(back) ? back : undefined,
    next: grid.includes(forward) ? forward : undefined,
  };
}

/** Where on its days an event is drawn on `date`: its only day, its first, one in the middle, or its last. */
export function eventSegment(
  event: CalendarEvent,
  date: string,
): { position: "only" | "first" | "middle" | "last"; day: number; days: number } {
  const days = eventDayCount(event);
  const day = eventDayCount({ ...event, lastDate: date });
  if (days <= 1) return { position: "only", day: 1, days: 1 };
  if (date === event.startDate) return { position: "first", day, days };
  if (date === event.lastDate) return { position: "last", day, days };
  return { position: "middle", day, days };
}

/**
 * Where the "now" line goes among a day's events: before the first timed event that has not started yet.
 *
 * All-day and dated events come first on a day and are not placed against a time, so the line never goes above them.
 * An event that started on an earlier day is already running, so the line goes after it.
 */
export function nowIndex(events: readonly CalendarEvent[], date: string, now: Date): number {
  const at = now.getTime();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined || event.startsAt === undefined) continue;
    if (event.startDate === date && Date.parse(event.startsAt) > at) return index;
  }
  return events.length;
}

/** The index an Up or Down key moves to in a list of `count` items, or `undefined` at either end or for another key. */
export function moveInList(key: string, index: number, count: number): number | undefined {
  if (key === "ArrowDown") return index + 1 < count ? index + 1 : undefined;
  if (key === "ArrowUp") return index > 0 ? index - 1 : undefined;
  if (key === "Home") return count > 0 ? 0 : undefined;
  if (key === "End") return count > 0 ? count - 1 : undefined;
  return undefined;
}
