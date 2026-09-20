import { validateEndpoint } from "./index.ts";

/**
 * The reference integration's read and write path, against a Calendar API.
 *
 * The machinery behind this was already real — scope planning, time normalisation, agenda building, conflict
 * detection, write-outcome classification and freshness labelling — and none of it had ever spoken to an API,
 * because there is no Google account here. So the client is built against an injected `fetch`, and the tests drive
 * it against a local endpoint that answers in the shape Google Calendar does.
 *
 * Two rules in here are about not claiming more than is known:
 *
 * 1. **A read that failed is never `live`.** Freshness is part of the answer, not a decoration on it, and a read
 *    that did not happen cannot be labelled as current data.
 * 2. **A write whose outcome is unknown is `unknown`, not `failed`.** A timeout after the request left the machine
 *    may well have created the event. Reporting that as a failure invites a retry that creates a second one.
 */

export const CALENDAR_API_STATUS = "implemented-against-local-fixture";

export type CalendarFreshness = "live" | "cached" | "unknown";

export interface CalendarEvent {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
}

export interface CalendarReadInput {
  endpoint: string;
  allowedOrigins: readonly string[];
  /** Sent in the `authorization` header and never in the URL: a query string is logged by everything it passes. */
  accessToken: string;
  /** RFC 3339 instants bounding the range. */
  timeMin: string;
  timeMax: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

export type AgendaRead =
  | { ok: true; events: CalendarEvent[]; freshness: "live" }
  | {
      ok: false;
      code: "ENDPOINT_REFUSED" | "REFUSED" | "UNREACHABLE" | "INVALID_RESPONSE";
      message: string;
      /** Never `live`: a read that did not happen is not current data. */
      freshness: "unknown";
    };

export interface CalendarWriteInput {
  endpoint: string;
  allowedOrigins: readonly string[];
  accessToken: string;
  event: { title: string; startsAt: string; endsAt: string; timezone: string };
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

/**
 * What happened to a write, in the vocabulary the rest of the node already uses.
 *
 * `unknown` is a distinct answer and not a synonym for `failed`: the request may have been applied. `refused` is
 * the server saying no to this caller, which is a different thing from the server saying no to this content.
 */
export type CalendarWriteOutcome =
  | { status: "applied"; eventId: string }
  | { status: "refused"; reason: string }
  | { status: "failed"; code: "REJECTED" | "CONFLICT"; message: string }
  | { status: "unknown"; reason: string };

const DEFAULT_TIMEOUT_MS = 15_000;

/** A bounded request, with a redirect refused because it would carry the token to whatever Location names. */
async function send(
  input: { endpoint: string; allowedOrigins: readonly string[]; fetchImpl: typeof fetch; timeoutMs?: number },
  request: { url: string; method: string; accessToken: string; body?: unknown },
): Promise<{ ok: true; response: Response } | { ok: false; code: "ENDPOINT_REFUSED" | "UNREACHABLE"; message: string }> {
  const endpoint = validateEndpoint({ url: request.url, allowedOrigins: input.allowedOrigins });
  if (!endpoint.ok) return { ok: false, code: "ENDPOINT_REFUSED", message: endpoint.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await input.fetchImpl(request.url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${request.accessToken}`,
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
      redirect: "error",
    });
    clearTimeout(timer);
    return { ok: true, response };
  } catch (cause) {
    clearTimeout(timer);
    const detail = controller.signal.aborted ? "the endpoint did not answer in time" : (cause instanceof Error ? cause.message : String(cause));
    return { ok: false, code: "UNREACHABLE", message: detail };
  }
}

/**
 * The events URL, or `undefined` when the endpoint is not one.
 *
 * Wrapped rather than left to throw: this builds a string, and a base URL that cannot be parsed is a refused
 * endpoint the caller can report, not an exception escaping a helper. The endpoint is still validated by `send`
 * before the request goes out — this only makes the failure arrive as an answer instead of a crash.
 */
function eventsUrl(endpoint: string, input: { timeMin: string; timeMax: string }): string | undefined {
  try {
    const url = new URL(`${endpoint.replace(/\/+$/, "")}/calendars/primary/events`);
    url.searchParams.set("timeMin", input.timeMin);
    url.searchParams.set("timeMax", input.timeMax);
    // Expanded so a recurring event arrives as the occurrences in the range rather than as a rule the caller would
    // have to expand itself and could get wrong.
    url.searchParams.set("singleEvents", "true");
    return url.toString();
  } catch {
    return undefined;
  }
}

function readEvent(record: Record<string, unknown>): CalendarEvent | undefined {
  const eventId = typeof record.id === "string" ? record.id : "";
  const start = typeof record.start === "object" && record.start !== null ? (record.start as Record<string, unknown>) : {};
  const end = typeof record.end === "object" && record.end !== null ? (record.end as Record<string, unknown>) : {};
  const startsAt = typeof start.dateTime === "string" ? start.dateTime : "";
  const endsAt = typeof end.dateTime === "string" ? end.dateTime : "";
  if (eventId === "" || startsAt === "" || endsAt === "") return undefined;

  return {
    eventId,
    title: typeof record.summary === "string" ? record.summary : "",
    startsAt,
    endsAt,
    // The event's own zone, taken from whichever end carries one: a calendar that stored it on the start only is
    // still an event with a zone, and guessing the node's own would move it for anybody travelling.
    timezone: typeof start.timeZone === "string" ? start.timeZone : typeof end.timeZone === "string" ? end.timeZone : "UTC",
  };
}

/** Read the agenda for a range. */
export async function readAgenda(input: CalendarReadInput): Promise<AgendaRead> {
  const url = eventsUrl(input.endpoint, { timeMin: input.timeMin, timeMax: input.timeMax });
  if (url === undefined) {
    return {
      ok: false,
      code: "ENDPOINT_REFUSED",
      message: `endpoint ${input.endpoint} is not a valid absolute URL`,
      freshness: "unknown",
    };
  }

  const sent = await send(input, {
    url,
    method: "GET",
    accessToken: input.accessToken,
  });
  if (!sent.ok) {
    return {
      ok: false,
      code: sent.code,
      message: sent.message,
      freshness: "unknown",
    };
  }

  const { response } = sent;
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: "REFUSED", message: `the calendar refused this connection (${String(response.status)})`, freshness: "unknown" };
  }
  if (!response.ok) {
    return { ok: false, code: "UNREACHABLE", message: `the calendar answered ${String(response.status)}`, freshness: "unknown" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, code: "INVALID_RESPONSE", message: "the calendar did not answer with JSON", freshness: "unknown" };
  }

  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const items = Array.isArray(record.items) ? record.items : [];
  const events: CalendarEvent[] = [];
  for (const item of items) {
    const event = readEvent(typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {});
    /*
     * An entry that is not an event is skipped rather than invented. A calendar carries entries this node has no
     * use for, and turning one into a blank event would put a row on somebody's agenda that does not exist.
     */
    if (event !== undefined) events.push(event);
  }

  return { ok: true, events, freshness: "live" };
}

/** Create an event, and say what happened to it. */
export async function writeEvent(input: CalendarWriteInput): Promise<CalendarWriteOutcome> {
  const sent = await send(input, {
    url: `${input.endpoint.replace(/\/+$/, "")}/calendars/primary/events`,
    method: "POST",
    accessToken: input.accessToken,
    body: {
      summary: input.event.title,
      start: { dateTime: input.event.startsAt, timeZone: input.event.timezone },
      end: { dateTime: input.event.endsAt, timeZone: input.event.timezone },
    },
  });
  if (!sent.ok) {
    // Not `failed`: a request that never got an answer may have been applied, and calling it a failure is how a
    // retry creates the event twice.
    return { status: "unknown", reason: sent.message };
  }

  const { response } = sent;
  if (response.status === 401 || response.status === 403) {
    return { status: "refused", reason: `the calendar refused this connection (${String(response.status)})` };
  }
  if (response.status === 409) {
    return { status: "failed", code: "CONFLICT", message: "the calendar says that event already exists" };
  }
  if (!response.ok) {
    return { status: "failed", code: "REJECTED", message: `the calendar answered ${String(response.status)}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A 2xx with an unreadable body: the event was very likely created, and the id that would let it be referenced
    // is missing, so the honest answer is that the outcome is not known rather than that it worked.
    return { status: "unknown", reason: "the calendar accepted the write but did not answer with JSON" };
  }

  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const eventId = typeof record.id === "string" ? record.id : "";
  if (eventId === "") {
    return { status: "unknown", reason: "the calendar accepted the write without naming the event it created" };
  }

  return { status: "applied", eventId };
}
