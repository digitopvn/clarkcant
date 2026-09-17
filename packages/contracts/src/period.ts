import { type CompositionPeriod, type CompositionSlot } from "./surface-composition.ts";

/**
 * Period arithmetic and series summarisation for composed surfaces.
 *
 * This is shared because two sides need the same answer: the runtime buckets task metrics by
 * period, and the client draws the labels and the range selector. Two implementations of "this
 * week" would eventually disagree, and the disagreement would look like a chart that does not
 * match its own filter.
 *
 * Timezones are handled explicitly. A period boundary is a local calendar boundary, so it cannot
 * be computed by adding 86 400 000 ms to an instant: on the day a timezone shifts its offset the
 * local day is 23 or 25 hours long, and a naive range would silently drop or double an hour of
 * data. Instants are stored and returned in UTC; the timezone is what makes them displayable.
 */

export const SLOT_ORDER: readonly CompositionSlot[] = [
  "metrics",
  "filter",
  "trend",
  "table",
  "calendar",
  "image",
  "note",
  "cta",
];

export interface PeriodBucket {
  /** Local calendar date, `YYYY-MM-DD`. Stable enough to key a map by. */
  key: string;
  /** Short label for an axis, `DD/MM`. */
  label: string;
  /** Inclusive UTC instant of local midnight. */
  from: string;
  /** Exclusive UTC instant of the next local midnight. */
  to: string;
}

export interface PeriodRange {
  period: CompositionPeriod;
  timezone: string;
  /** Inclusive start of the period, as a UTC instant. */
  from: string;
  /** Exclusive end of the period, as a UTC instant. */
  to: string;
  buckets: PeriodBucket[];
  /** `YYYY-MM-DD` of the period's first local day. */
  startDate: string;
  /** Inclusive `YYYY-MM-DD` of the period's last local day. */
  endDate: string;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** The civil date and time an instant falls on in a timezone. */
export function civilParts(at: Date, timeZone: string): CivilDate & { hour: number; minute: number; second: number } {
  const parts = partsFormatter(timeZone).formatToParts(at);
  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number.parseInt(value, 10);
  };
  // `hourCycle: h23` still yields 24 in some ICU builds; midnight is 0 either way.
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/** offset = local wall clock minus UTC, in milliseconds, at the given instant. */
export function timezoneOffsetMs(at: Date, timeZone: string): number {
  const parts = civilParts(at, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time.
 *
 * Solved by guessing and correcting: the offset of the guess is computed, the guess is shifted by
 * it, and the offset is recomputed once. The second pass matters on a day a timezone changes
 * offset, where the first guess can land on the other side of the transition.
 */
export function localTimeToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = timezoneOffsetMs(new Date(guess), timeZone);
  let instant = guess - firstOffset;
  const secondOffset = timezoneOffsetMs(new Date(instant), timeZone);
  if (secondOffset !== firstOffset) instant = guess - secondOffset;
  return new Date(instant);
}

function addDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function isoDate(date: CivilDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function shortLabel(date: CivilDate): string {
  return `${String(date.day).padStart(2, "0")}/${String(date.month).padStart(2, "0")}`;
}

/** ISO weekday: Monday is 1, Sunday is 7. */
function isoWeekday(date: CivilDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The range a period covers, with one bucket per local day.
 *
 * A week starts on Monday and a month starts on the first: both are local calendar boundaries, and
 * both are computed from the reference instant in the target timezone rather than from UTC.
 */
export function periodRange(period: CompositionPeriod, reference: Date, timeZone: string): PeriodRange {
  const today = civilParts(reference, timeZone);

  let start: CivilDate;
  let end: CivilDate;

  if (period === "week") {
    start = addDays(today, -(isoWeekday(today) - 1));
    end = addDays(start, 6);
  } else {
    start = { year: today.year, month: today.month, day: 1 };
    const lastDay = new Date(Date.UTC(today.year, today.month, 0)).getUTCDate();
    end = { year: today.year, month: today.month, day: lastDay };
  }

  const buckets: PeriodBucket[] = [];
  const dayCount = Math.round(
    (Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000,
  );
  for (let index = 0; index <= dayCount; index += 1) {
    const day = addDays(start, index);
    const next = addDays(day, 1);
    buckets.push({
      key: isoDate(day),
      label: shortLabel(day),
      from: localTimeToUtc(day.year, day.month, day.day, timeZone).toISOString(),
      to: localTimeToUtc(next.year, next.month, next.day, timeZone).toISOString(),
    });
  }

  return {
    period,
    timezone: timeZone,
    from: localTimeToUtc(start.year, start.month, start.day, timeZone).toISOString(),
    to: localTimeToUtc(addDays(end, 1).year, addDays(end, 1).month, addDays(end, 1).day, timeZone).toISOString(),
    buckets,
    startDate: isoDate(start),
    endDate: isoDate(end),
  };
}

/** Which local bucket an instant belongs to, or undefined when it falls outside the range. */
export function bucketKeyOf(range: PeriodRange, instant: string): string | undefined {
  const at = new Date(instant).getTime();
  for (const bucket of range.buckets) {
    if (at >= new Date(bucket.from).getTime() && at < new Date(bucket.to).getTime()) return bucket.key;
  }
  return undefined;
}

/** `YYYY-MM` of the local day an instant falls on. */
export function monthOfInstant(at: Date, timeZone: string): string {
  const parts = civilParts(at, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}`;
}

export interface MonthCell {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Day of the month, for the label. */
  day: number;
  /** False for the leading and trailing days that belong to the neighbouring months. */
  inMonth: boolean;
}

/**
 * The weeks a month view draws.
 *
 * Always six weeks of seven days starting on Monday, so the grid does not change height as the
 * user moves between months. Days outside the month are present and flagged rather than omitted,
 * because an empty cell in a calendar reads as a missing day.
 */
export function monthGrid(month: string, timeZone: string): MonthCell[] {
  const [yearText, monthText] = month.split("-");
  const year = Number.parseInt(yearText ?? "", 10);
  const monthNumber = Number.parseInt(monthText ?? "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return [];
  }

  const first: CivilDate = { year, month: monthNumber, day: 1 };
  const start = addDays(first, -(isoWeekday(first) - 1));
  const cells: MonthCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const day = addDays(start, index);
    cells.push({
      date: isoDate(day),
      day: day.day,
      inMonth: day.year === year && day.month === monthNumber,
    });
  }
  void timeZone;
  return cells;
}

/* ------------------------------------------------------------------ *
 * Series
 * ------------------------------------------------------------------ */

export interface SeriesSummary {
  count: number;
  total: number;
  max: number;
  min: number;
  average: number;
  /** Every value is zero or the series is empty. A chart of zeros is not a chart of nothing. */
  allZero: boolean;
  hasNegative: boolean;
}

export function summariseSeries(values: readonly number[]): SeriesSummary {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { count: 0, total: 0, max: 0, min: 0, average: 0, allZero: true, hasNegative: false };
  }
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    count: finite.length,
    total,
    max: Math.max(...finite),
    min: Math.min(...finite),
    average: total / finite.length,
    allZero: finite.every((value) => value === 0),
    hasNegative: finite.some((value) => value < 0),
  };
}

export type DonutResult =
  | { ok: true; slices: { label: string; value: number; share: number }[]; total: number; totalZero: boolean }
  | { ok: false; reason: string };

/**
 * Prepare donut slices.
 *
 * A donut is for parts of a whole, so the two inputs that cannot be drawn are refused explicitly
 * rather than drawn wrong: a negative share is not a wedge, and a zero total has no wedges to
 * size. The caller shows the text alternative in both cases instead of an empty circle that looks
 * like missing data.
 */
export function donutSlices(
  entries: readonly { label: string; value: number }[],
): DonutResult {
  const finite = entries.filter((entry) => Number.isFinite(entry.value));
  const negative = finite.find((entry) => entry.value < 0);
  if (negative !== undefined) {
    return { ok: false, reason: `"${negative.label}" has a negative value, which cannot be a share of a whole` };
  }
  const total = finite.reduce((sum, entry) => sum + entry.value, 0);
  if (total === 0) {
    return { ok: true, slices: finite.map((entry) => ({ ...entry, share: 0 })), total: 0, totalZero: true };
  }
  return {
    ok: true,
    slices: finite.map((entry) => ({ ...entry, share: entry.value / total })),
    total,
    totalZero: false,
  };
}

/** Fill a bucket list with counts, so a day with no events is present as zero rather than absent. */
export function countsByBucket(
  range: PeriodRange,
  instants: readonly string[],
): { key: string; label: string; value: number }[] {
  const counts = new Map(range.buckets.map((bucket) => [bucket.key, 0]));
  for (const instant of instants) {
    const key = bucketKeyOf(range, instant);
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return range.buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value: counts.get(bucket.key) ?? 0,
  }));
}

/** Sections in the order the container lays them out; unknown slots sort last, in input order. */
export function orderSections<T extends { slot: CompositionSlot }>(sections: readonly T[]): T[] {
  return [...sections].sort((left, right) => {
    const a = SLOT_ORDER.indexOf(left.slot);
    const b = SLOT_ORDER.indexOf(right.slot);
    return (a === -1 ? SLOT_ORDER.length : a) - (b === -1 ? SLOT_ORDER.length : b);
  });
}
