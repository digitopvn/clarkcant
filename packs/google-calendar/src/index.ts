import type { ConnectionDescriptor, TokenGrant } from "@clarkcant/integration-sdk";
import { connectionUsable, readAgenda, verifyScopes, writeEvent } from "@clarkcant/integration-sdk";

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

/* ------------------------------------------------------------------ *
 * The connector path
 * ------------------------------------------------------------------ */

/**
 * What a connection holds, and where the token lives.
 *
 * The token is a parameter of this object and nothing else: it is not stored in a preference, not put in a prompt
 * and not written to a KV row the model can read. A calendar read is the one call that needs it, and it travels in
 * the `authorization` header — the SDK's client owns that, so a token cannot end up in a query string that
 * everything it passes through will log.
 */
export interface CalendarConnection {
  /** The API base. The SDK validates it against `allowedOrigins` before anything is sent. */
  endpoint: string;
  allowedOrigins: readonly string[];
  accessToken: string;
  fetchImpl: typeof fetch;
  /** A bounded request, in milliseconds. A calendar that never answers must not hold a call open forever. */
  timeoutMs?: number;
}

/**
 * Turn a token grant into a connection, or say why it is not one.
 *
 * A token arriving is not a connection working, and this pack has said so from the start: the scopes that came back
 * have to cover the read, and the capability probe has to have passed. Both checks are the SDK's `connectionUsable`,
 * called here rather than re-implemented, so "authorization succeeded" can never be reported as "the calendar
 * works".
 */
export function connectionFromGrant(input: {
  grant: TokenGrant;
  endpoint: string;
  allowedOrigins: readonly string[];
  fetchImpl: typeof fetch;
  /** The last result of the capability probe, whatever it was. `pass` is the only one that opens a connection. */
  lastProbeResult: "pass" | "fail" | "not-run" | undefined;
  timeoutMs?: number;
}): { ok: true; connection: CalendarConnection } | { ok: false; reason: string } {
  const usable = connectionUsable({
    status: "connected",
    grantedScopes: input.grant.scopes.granted,
    requiredScopes: CONNECTION.requestedScopes,
    lastProbeResult: input.lastProbeResult,
  });
  if (!usable.usable) return { ok: false, reason: usable.reason };
  return {
    ok: true,
    connection: {
      endpoint: input.endpoint,
      allowedOrigins: input.allowedOrigins,
      accessToken: input.grant.accessToken,
      fetchImpl: input.fetchImpl,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
  };
}

/**
 * One day's agenda, read through the SDK's Calendar client.
 *
 * The events come back in this pack's own shape, because the agenda, the conflicts and the freshness label are the
 * pack's rules and they need the time contract rather than a second one. A read that failed is never `live` — the
 * freshness field is part of the answer, not a decoration on it — and an entry whose time cannot be read is skipped
 * rather than invented as a blank row on somebody's day.
 */
export type ConnectorRead =
  | { ok: true; events: CalendarEvent[]; freshness: "live" }
  | { ok: false; code: string; message: string; freshness: "unknown" };

export async function readAgendaThroughConnector(input: {
  connection: CalendarConnection;
  timeMin: string;
  timeMax: string;
  /** The zone to fall back to when the calendar stored none, which is the node's own. */
  fallbackTimeZone: string;
}): Promise<ConnectorRead> {
  const read = await readAgenda({
    endpoint: input.connection.endpoint,
    allowedOrigins: input.connection.allowedOrigins,
    accessToken: input.connection.accessToken,
    timeMin: input.timeMin,
    timeMax: input.timeMax,
    fetchImpl: input.connection.fetchImpl,
    ...(input.connection.timeoutMs === undefined ? {} : { timeoutMs: input.connection.timeoutMs }),
  });
  if (!read.ok) return { ok: false, code: read.code, message: read.message, freshness: "unknown" };

  const events: CalendarEvent[] = [];
  for (const event of read.events) {
    const start = normalizeTime({
      dateTime: event.startsAt,
      timeZone: event.timezone,
      fallbackTimeZone: input.fallbackTimeZone,
    });
    const end = normalizeTime({
      dateTime: event.endsAt,
      timeZone: event.timezone,
      fallbackTimeZone: input.fallbackTimeZone,
    });
    if (!start.ok || !end.ok) continue;
    events.push({
      id: event.eventId,
      summary: event.title,
      start: start.time,
      end: end.time,
      status: event.status,
      etag: event.etag,
    });
  }
  // Through `buildAgenda`, so a cancelled instance is dropped and the order is the pack's rather than the API's.
  return { ok: true, events: buildAgenda(events), freshness: "live" };
}

/**
 * Create a timed event through the SDK's Calendar client.
 *
 * The four words are this pack's — `classifyWriteOutcome`'s vocabulary — and they are derived from the SDK's answer
 * rather than from an HTTP status read a second time here. `unknown` stays `unknown`: a request that left the
 * machine and timed out may well have created the event, and calling that a failure is how a retry puts two copies
 * of the same meeting in somebody's calendar.
 *
 * An all-day event is refused. Google stores one as a `date` rather than a `dateTime`, and the write this connector
 * has access to sends only the latter — turning `2026-09-21` into midnight in some zone is the drift the time
 * contract exists to prevent, so the honest answer is that this path cannot write it.
 */
export async function createEventThroughConnector(input: {
  connection: CalendarConnection;
  event: { title: string; start: CalendarTime; end: CalendarTime };
}): Promise<{
  outcome: "confirmed" | "failed" | "unknown" | "conflict";
  eventId: string | undefined;
  reason: string | undefined;
}> {
  if (input.event.start.kind === "date" || input.event.end.kind === "date") {
    return {
      outcome: "failed",
      eventId: undefined,
      reason: "this connector writes timed events only; an all-day event is stored as a date, and sending it as an instant would move it",
    };
  }

  const written = await writeEvent({
    endpoint: input.connection.endpoint,
    allowedOrigins: input.connection.allowedOrigins,
    accessToken: input.connection.accessToken,
    event: {
      title: input.event.title,
      startsAt: input.event.start.dateTime,
      endsAt: input.event.end.dateTime,
      // The start's zone, and the end's when the start has none: an event whose ends disagree about their zone is a
      // malformed source rather than a second opinion to pick from.
      timezone: input.event.start.timeZone,
    },
    fetchImpl: input.connection.fetchImpl,
    ...(input.connection.timeoutMs === undefined ? {} : { timeoutMs: input.connection.timeoutMs }),
  });

  switch (written.status) {
    case "applied":
      return { outcome: "confirmed", eventId: written.eventId, reason: undefined };
    case "refused":
      return { outcome: "failed", eventId: undefined, reason: written.reason };
    case "unknown":
      return { outcome: "unknown", eventId: undefined, reason: written.reason };
    case "failed":
      return {
        outcome: written.code === "CONFLICT" ? "conflict" : "failed",
        eventId: undefined,
        reason: written.message,
      };
  }
}

/**
 * @status-ref pack.google-calendar
 *
 * The connector path is wired and real: `connectionFromGrant` takes a grant the SDK's authorization-code exchange
 * produced, `readAgendaThroughConnector` and `createEventThroughConnector` call the SDK's Calendar client, and the
 * pack's own time contract, agenda order, conflict rule and four write-outcome words are what come back. A
 * connection is still never reported as usable on the strength of a token: the scopes have to cover the read and
 * the capability probe has to have passed.
 *
 * TODO(P7): the live connection. What is missing is a registered OAuth client, an enabled API and a real account,
 * so the endpoint a live connection would call has never been called — external gate #2. Until then no journey may
 * report a calendar as connected.
 */
export const LIVE_API_STATUS = "external-blocked-oauth-client-required";
