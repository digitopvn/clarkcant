import type { ConnectionDescriptor } from "@clarkcant/integration-sdk";
import { verifyScopes } from "@clarkcant/integration-sdk";

/**
 * Google Calendar reference integration.
 *
 * This is the integration the release has to prove end to end, so the parts that can be
 * built without an account are built properly here: the scope plan, the event-time
 * contract, the conflict and unknown-effect handling, and the refresh policy.
 *
 * Everything requiring a registered OAuth client and a real calendar is blocked and says
 * so. In particular this pack never reports a connection as usable: `connectionUsable`
 * requires a passed capability probe, so authorization succeeding is not enough.
 */

export const PROVIDER = "google.calendar";

/**
 * Scope plan for the reference journey.
 *
 * Read-only first. `calendar.events` is requested only when the user asks to create or
 * move an event, and the request is a separate authorization step, because a native
 * client cannot assume incremental authorization works the way the web flow does.
 */
export const CONNECTION: ConnectionDescriptor = {
  provider: PROVIDER,
  flow: "oauth-native-pkce",
  requestedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  optionalScopes: ["https://www.googleapis.com/auth/calendar.events"],
  capabilityProbe: {
    capabilityRef: "google.calendar.events.list@1",
    description: "Read one day's events from the calendar the user selected",
  },
  redirectKind: "loopback",
};

export const CAPABILITIES = [
  "google.calendar.events.list@1",
  "google.calendar.events.create@1",
  "google.calendar.events.update@1",
] as const;

/* ------------------------------------------------------------------ *
 * Date and time contract
 * ------------------------------------------------------------------ */

export type CalendarTime =
  /** A timed event. `timeZone` is required so an update cannot silently shift it. */
  | { kind: "timed"; dateTime: string; timeZone: string }
  /** An all-day event. `date` is a calendar date, not an instant. */
  | { kind: "date"; date: string };

export interface CalendarEvent {
  id: string;
  summary: string;
  start: CalendarTime;
  end: CalendarTime;
  /** `cancelled` instances must be filtered out of an agenda rather than displayed. */
  status: "confirmed" | "tentative" | "cancelled";
  /** Set for a single instance of a recurring event. */
  recurringEventId?: string;
  /** Version used for optimistic concurrency on update. */
  etag: string;
}

/**
 * Normalise an event time.
 *
 * Date-only values and timed values are kept apart rather than coerced. Treating an
 * all-day event as midnight in some timezone is how an agenda drifts by a day, and no
 * amount of string replacement fixes that.
 */
export function normalizeTime(input: {
  date?: string;
  dateTime?: string;
  timeZone?: string;
  fallbackTimeZone: string;
}): { ok: true; time: CalendarTime } | { ok: false; reason: string } {
  if (input.date !== undefined && input.dateTime !== undefined) {
    return { ok: false, reason: "an event time carries both a date and a dateTime; the source is malformed" };
  }
  if (input.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      return { ok: false, reason: `all-day date ${input.date} is not in YYYY-MM-DD form` };
    }
    return { ok: true, time: { kind: "date", date: input.date } };
  }
  if (input.dateTime !== undefined) {
    return {
      ok: true,
      time: { kind: "timed", dateTime: input.dateTime, timeZone: input.timeZone ?? input.fallbackTimeZone },
    };
  }
  return { ok: false, reason: "an event time must carry either a date or a dateTime" };
}

/**
 * Filter a raw event list into an agenda.
 *
 * Cancelled instances are dropped and the result is ordered by start. The ordering uses
 * the event's own timezone offset when present rather than assuming UTC, because a
 * recurring series can span a DST boundary.
 */
export function buildAgenda(events: readonly CalendarEvent[]): CalendarEvent[] {
  return [...events]
    .filter((event) => event.status !== "cancelled")
    .sort((a, b) => instantOf(a.start).localeCompare(instantOf(b.start)));
}

function instantOf(time: CalendarTime): string {
  return time.kind === "date" ? `${time.date}T00:00:00Z` : time.dateTime;
}

/* ------------------------------------------------------------------ *
 * Conflicts and unknown effects
 * ------------------------------------------------------------------ */

export interface Conflict {
  existingEventId: string;
  existingSummary: string;
}

/**
 * Find overlaps with a proposed change.
 *
 * Surfaced before the user confirms, because "move this to tomorrow afternoon" that
 * silently double-books the user is worse than asking.
 */
export function findConflicts(
  candidate: { start: CalendarTime; end: CalendarTime; excludeEventId?: string },
  agenda: readonly CalendarEvent[],
): Conflict[] {
  const start = instantOf(candidate.start);
  const end = instantOf(candidate.end);
  return agenda
    .filter((event) => event.id !== candidate.excludeEventId)
    .filter((event) => {
      const eventStart = instantOf(event.start);
      const eventEnd = instantOf(event.end);
      return eventStart < end && eventEnd > start;
    })
    .map((event) => ({ existingEventId: event.id, existingSummary: event.summary }));
}

/**
 * Classify the result of a create or update call.
 *
 * A timeout is `unknown`, not `failed`. Google Calendar's insert is not idempotent
 * without a request id, so a timeout has to be resolved by reading the calendar back
 * rather than by repeating the write — repeating it is how the user ends up with two
 * copies of the same meeting (acceptance test T38).
 */
export function classifyWriteOutcome(input: {
  httpStatus?: number;
  timedOut: boolean;
  readBackFoundEvent: boolean;
}): "confirmed" | "failed" | "unknown" | "conflict" {
  if (input.timedOut) {
    return input.readBackFoundEvent ? "confirmed" : "unknown";
  }
  if (input.httpStatus === 412 || input.httpStatus === 409) return "conflict";
  if (input.httpStatus !== undefined && input.httpStatus >= 200 && input.httpStatus < 300) {
    return "confirmed";
  }
  return "failed";
}

/**
 * Whether the displayed data can be described as live.
 *
 * A cached agenda with no visible last-updated time is the specific misleading case the
 * blueprint calls out, so the freshness label is derived from the data rather than
 * chosen by the presenter (acceptance test T36).
 */
export function freshnessOf(input: {
  fetchedAt: string;
  now: string;
  maxAgeMs: number;
  online: boolean;
}): "live" | "cached" | "offline" {
  if (!input.online) return "offline";
  const age = new Date(input.now).getTime() - new Date(input.fetchedAt).getTime();
  return age <= input.maxAgeMs ? "live" : "cached";
}

export { verifyScopes };

/**
 * @status-ref pack.google-calendar
 * TODO(P7): the live Calendar API client and token refresh. Scope verification, time
 * normalization, agenda construction, conflict detection, write-outcome classification
 * and freshness labelling are implemented and tested; reading or writing a real calendar
 * needs a registered OAuth client, an enabled API and a real account, none of which this
 * repository holds. Until then no journey may report a calendar as connected.
 */
export const LIVE_API_STATUS = "external-blocked-oauth-client-required";
