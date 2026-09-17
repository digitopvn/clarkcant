import { civilParts, localTimeToUtc, periodRange } from "@clarkcant/contracts";

/**
 * Deterministic time expressions.
 *
 * Search needs this whether or not a model is involved: "what did we fix yesterday" is a question
 * with an exact answer, and spending a provider call to compute a date is both slower and less
 * reliable than doing arithmetic. The parser is therefore the default path, and the selector in
 * Phase 9 only decides *between* retrieved results, never when "hôm qua" was.
 *
 * Two properties matter more than coverage:
 *
 * - **Local calendar boundaries.** A day starts at local midnight, so a range cannot be produced by
 *   subtracting 86 400 000 ms from an instant. The same helpers the overview uses are reused here.
 * - **It says nothing when it does not know.** An unrecognised phrase yields `none` rather than
 *   defaulting to today; a search silently narrowed to today's messages looks like an empty index.
 */

export interface TemporalRange {
  kind: "range";
  /** Inclusive UTC instant. */
  from: string;
  /** Exclusive UTC instant. */
  to: string;
  /** Human label, in the language the phrase was recognised in. */
  label: string;
  /** The phrase that produced this, filled in by `parseTemporal` rather than by a pattern. */
  matched?: string;
}

export interface TemporalInstant {
  kind: "instant";
  at: string;
  label: string;
  matched?: string;
}

export type TemporalParse = TemporalRange | TemporalInstant | { kind: "none"; matched?: undefined };

/** Remove diacritics so both spellings of a Vietnamese phrase match one pattern. */
export function stripDiacritics(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

interface DayBoundaries {
  from: string;
  to: string;
}

function dayBoundaries(at: Date, timezone: string, dayOffset = 0): DayBoundaries {
  const parts = civilParts(at, timezone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  const start = localTimeToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    timezone,
  );
  const next = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1));
  const end = localTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timezone);
  return { from: start.toISOString(), to: end.toISOString() };
}

function daysAgoRange(at: Date, timezone: string, days: number): DayBoundaries {
  return dayBoundaries(at, timezone, -days);
}

function lastDaysRange(at: Date, timezone: string, days: number): DayBoundaries {
  // `from` is the first instant of the earliest day, `to` the first instant of tomorrow: a window
  // of N local days that includes today.
  const start = dayBoundaries(at, timezone, -(days - 1));
  const end = dayBoundaries(at, timezone, 1);
  return { from: start.from, to: end.to };
}

interface Pattern {
  /** Tested against the diacritic-stripped, lowercased text. */
  matcher: RegExp;
  build: (input: { at: Date; timezone: string; match: RegExpExecArray }) => TemporalParse;
  label: string;
}

const PATTERNS: readonly Pattern[] = [
  {
    matcher: /\b(hom nay|ngay hom nay|today)\b/,
    label: "hôm nay",
    build: ({ at, timezone }) => ({ kind: "range", ...dayBoundaries(at, timezone, 0), label: "hôm nay" }),
  },
  {
    matcher: /\b(hom qua|ngay hom qua|yesterday)\b/,
    label: "hôm qua",
    build: ({ at, timezone }) => ({ kind: "range", ...dayBoundaries(at, timezone, -1), label: "hôm qua" }),
  },
  {
    matcher: /\b(hom kia)\b/,
    label: "hôm kia",
    build: ({ at, timezone }) => ({ kind: "range", ...dayBoundaries(at, timezone, -2), label: "hôm kia" }),
  },
  {
    matcher: /\b(sang nay|chieu nay|toi nay|this morning|tonight)\b/,
    label: "hôm nay",
    build: ({ at, timezone }) => ({ kind: "range", ...dayBoundaries(at, timezone, 0), label: "hôm nay" }),
  },
  {
    matcher: /\b(toi qua|dem qua|last night)\b/,
    label: "hôm qua",
    build: ({ at, timezone }) => ({ kind: "range", ...dayBoundaries(at, timezone, -1), label: "hôm qua" }),
  },
  {
    matcher: /\b(tuan nay|this week)\b/,
    label: "tuần này",
    build: ({ at, timezone }) => {
      const range = periodRange("week", at, timezone);
      return { kind: "range", from: range.from, to: range.to, label: "tuần này" };
    },
  },
  {
    matcher: /\b(tuan truoc|tuan roi|last week)\b/,
    label: "tuần trước",
    build: ({ at, timezone }) => {
      const thisWeek = periodRange("week", at, timezone);
      const previous = periodRange("week", new Date(new Date(thisWeek.from).getTime() - 86_400_000), timezone);
      return { kind: "range", from: previous.from, to: previous.to, label: "tuần trước" };
    },
  },
  {
    matcher: /\b(thang nay|this month)\b/,
    label: "tháng này",
    build: ({ at, timezone }) => {
      const range = periodRange("month", at, timezone);
      return { kind: "range", from: range.from, to: range.to, label: "tháng này" };
    },
  },
  {
    matcher: /\b(thang truoc|thang roi|last month)\b/,
    label: "tháng trước",
    build: ({ at, timezone }) => {
      const thisMonth = periodRange("month", at, timezone);
      const previous = periodRange("month", new Date(new Date(thisMonth.from).getTime() - 86_400_000), timezone);
      return { kind: "range", from: previous.from, to: previous.to, label: "tháng trước" };
    },
  },
  {
    matcher: /\b(\d{1,2})\s*(ngay|days?)\s*(truoc|ago)\b/,
    label: "N ngày trước",
    build: ({ at, timezone, match }) => {
      const days = Number.parseInt(match[1] ?? "0", 10);
      return { kind: "range", ...daysAgoRange(at, timezone, days), label: `${days} ngày trước` };
    },
  },
  {
    matcher: /\b(\d{1,2})\s*(tuan|weeks?)\s*(truoc|ago)\b/,
    label: "N tuần trước",
    build: ({ at, timezone, match }) => {
      const weeks = Number.parseInt(match[1] ?? "0", 10);
      return { kind: "range", ...daysAgoRange(at, timezone, weeks * 7), label: `${weeks} tuần trước` };
    },
  },
  {
    matcher: /\b(last\s+(\d{1,2})\s+days)\b/,
    label: "N ngày qua",
    build: ({ at, timezone, match }) => {
      const days = Number.parseInt(match[2] ?? "0", 10);
      return { kind: "range", ...lastDaysRange(at, timezone, days), label: `${days} ngày qua` };
    },
  },
  {
    matcher: /\b(\d{1,2})\s*ngay\s*(qua|nay)\b/,
    label: "N ngày qua",
    build: ({ at, timezone, match }) => {
      const days = Number.parseInt(match[1] ?? "0", 10);
      return { kind: "range", ...lastDaysRange(at, timezone, days), label: `${days} ngày qua` };
    },
  },
  {
    matcher: /\b(\d{4}-\d{2}-\d{2})\b/,
    label: "một ngày cụ thể",
    build: ({ timezone, match }) => {
      const [year, month, day] = (match[1] ?? "").split("-").map((part) => Number.parseInt(part, 10));
      if (year === undefined || month === undefined || day === undefined) return { kind: "none" };
      const start = localTimeToUtc(year, month, day, timezone);
      const next = localTimeToUtc(year, month, day + 1, timezone);
      return { kind: "range", from: start.toISOString(), to: next.toISOString(), label: match[1] ?? "" };
    },
  },
];

/**
 * A parse plus what is left of the query.
 *
 * An intersection rather than an interface extending the union: an interface cannot extend a union,
 * and the union is what makes `kind` a usable discriminator at every call site.
 */
export type TemporalParseResult = TemporalParse & {
  /** The query with the temporal phrase removed, so it is not searched for as a word. */
  rest: string;
};

/**
 * Parse the first time expression in a query.
 *
 * The phrase is removed from `rest` so the remaining text is what gets searched. Without that,
 * "bug login hôm qua" would also look for the words "hôm" and "qua", which appear in every message
 * from that day and would swamp the ranking.
 */
export function parseTemporal(
  text: string,
  options: { now: Date; timezone: string },
): TemporalParseResult {
  const haystack = stripDiacritics(text).toLowerCase();

  for (const pattern of PATTERNS) {
    const match = pattern.matcher.exec(haystack);
    if (match === null) continue;

    const built = pattern.build({ at: options.now, timezone: options.timezone, match });
    if (built.kind === "none") continue;

    const start = match.index;
    const end = start + match[0].length;
    const rest = `${text.slice(0, start)} ${text.slice(end)}`.replace(/\s+/g, " ").trim();

    return { ...built, matched: text.slice(start, end), rest };
  }

  return { kind: "none", rest: text };
}

/** Whether a parse narrowed the search, for a caller that wants to say what it understood. */
export function narrowed(parsed: TemporalParseResult): boolean {
  return parsed.kind === "range" || parsed.kind === "instant";
}
