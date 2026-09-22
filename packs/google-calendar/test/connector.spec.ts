import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createPkcePair, exchangeAuthorizationCode, s256 } from "@clarkcant/integration-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONNECTION,
  connectionFromGrant,
  createEventThroughConnector,
  readAgendaThroughConnector,
} from "../src/index.ts";

/**
 * The Calendar pack, wired through the connector path (V10, phase 6).
 *
 * The pack's own rules were real and tested before this — time contract, agenda order, conflicts, write-outcome
 * words, freshness — and none of them had ever spoken to an API: the pack held no client, and the SDK's Calendar
 * client held no caller. What is proven here is the wiring, end to end and inside this repository: a token that came
 * out of the SDK's own authorization-code exchange, a Calendar client answering in Google's shape, and the pack's
 * events, order and outcome words on the other side.
 *
 * Both endpoints are loopback fixtures this file starts, which is exactly what the evidence is allowed to claim and
 * no more: no registered OAuth client and no Google account exist here, so the endpoint a live connection would call
 * has never been called. That is external gate #2, and it stays open.
 */

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
}

let servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  servers = [];
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fixture did not bind a port");
  return `http://127.0.0.1:${String(address.port)}`;
}

/**
 * A token endpoint that checks PKCE for real.
 *
 * It recomputes `s256(code_verifier)` from what it is sent and compares it with the challenge the authorization
 * request carried, so a client that sent the challenge instead of the verifier gets a refusal rather than a token.
 */
async function startTokenEndpoint(challenge: string): Promise<{ origin: string; endpoint: string }> {
  const origin = await listen(
    createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const raw = await readBody(request);
        const sent = new URLSearchParams(raw);
        const verifier = sent.get("code_verifier") ?? "";
        // The SDK's own `s256`, so this fixture cannot drift from the function the client hashed the challenge with.
        const granted = verifier !== "" && s256(verifier) === challenge;
        if (!granted) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "token_from_the_exchange",
            refresh_token: "refresh_1",
            expires_in: 3600,
            scope: CONNECTION.requestedScopes.join(" "),
          }),
        );
      })();
    }),
  );
  return { origin, endpoint: `${origin}/token` };
}

/** The Calendar API, answering in the shape Google's does. */
async function startCalendar(
  answer: (received: Received) => { status: number; body: string } | Promise<{ status: number; body: string }> = () => ({
    status: 200,
    body: JSON.stringify({
      items: [
        {
          id: "ev_late",
          summary: "họp nhóm",
          status: "confirmed",
          etag: '"etag_2"',
          start: { dateTime: "2026-09-21T15:00:00+07:00", timeZone: "Asia/Ho_Chi_Minh" },
          end: { dateTime: "2026-09-21T16:00:00+07:00" },
        },
        {
          id: "ev_cancelled",
          summary: "buổi đã huỷ",
          status: "cancelled",
          start: { dateTime: "2026-09-21T08:00:00+07:00", timeZone: "Asia/Ho_Chi_Minh" },
          end: { dateTime: "2026-09-21T08:30:00+07:00" },
        },
        {
          id: "ev_early",
          summary: "ăn sáng",
          status: "confirmed",
          start: { dateTime: "2026-09-21T07:00:00+07:00", timeZone: "Asia/Ho_Chi_Minh" },
          end: { dateTime: "2026-09-21T07:30:00+07:00" },
        },
      ],
    }),
  }),
): Promise<{ origin: string; endpoint: string; received: Received[] }> {
  const received: Received[] = [];
  const origin = await listen(
    createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const raw = await readBody(request);
        let body: Record<string, unknown> | undefined;
        try {
          body = raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>);
        } catch {
          body = undefined;
        }
        const record: Received = {
          method: request.method ?? "",
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body,
        };
        received.push(record);
        const answered = await answer(record);
        response.writeHead(answered.status, { "content-type": "application/json" });
        response.end(answered.body);
      })();
    }),
  );
  return { origin, endpoint: `${origin}/calendar/v3`, received };
}

const RANGE = { timeMin: "2026-09-21T00:00:00Z", timeMax: "2026-09-22T00:00:00Z" };

/** A connection whose token really came out of the SDK's authorization-code exchange. */
async function connected(calendar: { origin: string; endpoint: string }): Promise<ReturnType<typeof connectionFromGrant>> {
  const pair = createPkcePair();
  const token = await startTokenEndpoint(pair.challenge);
  const exchanged = await exchangeAuthorizationCode({
    endpoint: token.endpoint,
    allowedOrigins: [token.origin],
    clientId: "client_from_this_repo",
    fetchImpl: fetch,
    redirectUri: "http://127.0.0.1/callback",
    code: "code_1",
    verifier: pair.verifier,
    expectedState: "state_1",
    receivedState: "state_1",
    descriptor: CONNECTION,
  });
  if (!exchanged.ok) throw new Error(exchanged.message);
  return connectionFromGrant({
    grant: exchanged.grant,
    endpoint: calendar.endpoint,
    allowedOrigins: [calendar.origin],
    fetchImpl: fetch,
    lastProbeResult: "pass",
  });
}

describe("reading a calendar through the connector", () => {
  it("reads a real range with a token the exchange issued, in the pack's own event shape", async () => {
    const calendar = await startCalendar();
    const made = await connected(calendar);
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const read = await readAgendaThroughConnector({
      connection: made.connection,
      ...RANGE,
      fallbackTimeZone: "Asia/Ho_Chi_Minh",
    });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.freshness).toBe("live");
    // The pack's order, not the API's: the cancelled instance is gone and the rest are by start.
    expect(read.events.map((event) => event.id)).toEqual(["ev_early", "ev_late"]);
    expect(read.events[1]?.start).toEqual({ kind: "timed", dateTime: "2026-09-21T15:00:00+07:00", timeZone: "Asia/Ho_Chi_Minh" });
    // The version came from the payload, so an update has something to be optimistic about.
    expect(read.events[1]?.etag).toBe('"etag_2"');

    const sent = calendar.received[0];
    expect(sent?.method).toBe("GET");
    expect(sent?.url).toContain("singleEvents=true");
    // The token the exchange issued travels in the header, and never in the URL: a query string is logged by
    // everything it passes through.
    expect(sent?.authorization).toBe("Bearer token_from_the_exchange");
    expect(sent?.url).not.toContain("token_from_the_exchange");
  });

  it("will not open a connection on a token alone", async () => {
    const calendar = await startCalendar();
    const made = await connected(calendar);
    if (!made.ok) throw new Error(made.reason);

    // The same token, with the capability probe not passed: this pack has never reported a calendar as usable on
    // the strength of an authorization succeeding, and it still does not.
    const probed = connectionFromGrant({
      grant: { accessToken: made.connection.accessToken, refreshToken: undefined, expiresInSeconds: 3600, scopes: { granted: [...CONNECTION.requestedScopes], missingRequired: [], missingOptional: [], status: "full" } },
      endpoint: calendar.endpoint,
      allowedOrigins: [calendar.origin],
      fetchImpl: fetch,
      lastProbeResult: "not-run",
    });
    expect(probed.ok).toBe(false);
    expect(probed.ok ? "" : probed.reason).toContain("capability probe");
  });

  it("never reports a read that was refused as current data", async () => {
    const calendar = await startCalendar(() => ({ status: 403, body: JSON.stringify({ error: "forbidden" }) }));
    const made = await connected(calendar);
    if (!made.ok) throw new Error(made.reason);

    const read = await readAgendaThroughConnector({
      connection: made.connection,
      ...RANGE,
      fallbackTimeZone: "Asia/Ho_Chi_Minh",
    });

    expect(read.ok).toBe(false);
    // Not an empty agenda, and not `live`: a read that did not happen is not today's schedule.
    expect(read.ok ? "" : read.freshness).toBe("unknown");
    expect(read.ok ? "" : read.code).toBe("REFUSED");
  });
});

describe("writing through the connector", () => {
  const EVENT = {
    title: "họp với khách",
    start: { kind: "timed" as const, dateTime: "2026-09-22T09:00:00+07:00", timeZone: "Asia/Ho_Chi_Minh" },
    end: { kind: "timed" as const, dateTime: "2026-09-22T10:00:00+07:00", timeZone: "Asia/Ho_Chi_Minh" },
  };

  it("reports an event the calendar created, with the id it answered", async () => {
    const calendar = await startCalendar(() => ({ status: 200, body: JSON.stringify({ id: "ev_new" }) }));
    const made = await connected(calendar);
    if (!made.ok) throw new Error(made.reason);

    const written = await createEventThroughConnector({ connection: made.connection, event: EVENT });

    expect(written.outcome).toBe("confirmed");
    expect(written.eventId).toBe("ev_new");
    expect(calendar.received[0]?.method).toBe("POST");
    expect(calendar.received[0]?.body).toEqual({
      summary: "họp với khách",
      start: { dateTime: EVENT.start.dateTime, timeZone: "Asia/Ho_Chi_Minh" },
      end: { dateTime: EVENT.end.dateTime, timeZone: "Asia/Ho_Chi_Minh" },
    });
  });

  it("reports a write that timed out as unknown, not as failed", async () => {
    // A calendar that never answers. The request left the machine, so the event may well exist.
    const calendar = await startCalendar(() => new Promise(() => undefined));
    const made = await connected(calendar);
    if (!made.ok) throw new Error(made.reason);

    const written = await createEventThroughConnector({
      connection: { ...made.connection, timeoutMs: 300 },
      event: EVENT,
    });

    expect(written.outcome).toBe("unknown");
    expect(written.outcome === "unknown" ? written.reason : "").not.toBe("");
  });

  it("reports a conflict as a conflict, and refuses an all-day event it cannot write", async () => {
    const calendar = await startCalendar(() => ({ status: 409, body: JSON.stringify({ error: "duplicate" }) }));
    const made = await connected(calendar);
    if (!made.ok) throw new Error(made.reason);

    const conflicted = await createEventThroughConnector({ connection: made.connection, event: EVENT });
    expect(conflicted.outcome).toBe("conflict");

    // Google stores an all-day event as a date; sending one as an instant is how it moves by a day.
    const allDay = await createEventThroughConnector({
      connection: made.connection,
      event: { title: "nghỉ", start: { kind: "date", date: "2026-09-22" }, end: { kind: "date", date: "2026-09-23" } },
    });
    expect(allDay.outcome).toBe("failed");
    expect(allDay.outcome === "failed" ? allDay.reason : "").toContain("all-day");
    // And nothing was sent for it: a refusal that still wrote is not a refusal.
    expect(calendar.received).toHaveLength(1);
  });
});
