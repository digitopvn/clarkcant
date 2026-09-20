import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { readAgenda, writeEvent } from "../src/calendar-api.ts";

/**
 * The reference integration's read and write path (V10).
 *
 * These run against a Calendar API this test starts on loopback, answering in the shape Google Calendar does. What
 * that proves is the wiring: the request is built the way the API expects, the answer is read the way the node
 * needs it, and an outcome that is not known is not reported as one that is.
 *
 * What it cannot prove is named in the ledger: no Google account exists, so the API a live connection would call has
 * never been called.
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

interface Fixture {
  origin: string;
  endpoint: string;
  received: Received[];
}

async function startCalendar(
  answer: (received: Received) => { status: number; body: string; contentType?: string } | Promise<{ status: number; body: string; contentType?: string }> = () => ({
    status: 200,
    body: JSON.stringify({
      items: [
        {
          id: "ev_1",
          summary: "họp nhóm",
          start: { dateTime: "2026-09-21T09:00:00+07:00", timeZone: "Asia/Ho_Chi_Minh" },
          end: { dateTime: "2026-09-21T10:00:00+07:00" },
        },
      ],
    }),
  }),
): Promise<Fixture> {
  const received: Received[] = [];
  const fixture: Fixture = { origin: "", endpoint: "", received };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
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
      response.writeHead(answered.status, { "content-type": answered.contentType ?? "application/json" });
      response.end(answered.body);
    })();
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fixture calendar did not bind a port");
  fixture.origin = `http://127.0.0.1:${String(address.port)}`;
  fixture.endpoint = `${fixture.origin}/calendar/v3`;
  return fixture;
}

const RANGE = { timeMin: "2026-09-21T00:00:00Z", timeMax: "2026-09-22T00:00:00Z" };

describe("reading an agenda", () => {
  it("asks for the range and reads the events back as live", async () => {
    const calendar = await startCalendar();

    const result = await readAgenda({
      endpoint: calendar.endpoint,
      allowedOrigins: [calendar.origin],
      accessToken: "token_1",
      ...RANGE,
      fetchImpl: fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.freshness).toBe("live");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventId).toBe("ev_1");
    expect(result.events[0]?.title).toBe("họp nhóm");
    // The event's own zone, taken from the start because that is where the fixture put it.
    expect(result.events[0]?.timezone).toBe("Asia/Ho_Chi_Minh");

    const sent = calendar.received[0];
    expect(sent?.method).toBe("GET");
    expect(sent?.url).toContain("timeMin=");
    expect(sent?.url).toContain("singleEvents=true");
    // The token travels in the header, never in the URL: a query string is logged by everything it passes through.
    expect(sent?.authorization).toBe("Bearer token_1");
    expect(sent?.url).not.toContain("token_1");
  });

  it("never calls a read that failed current data", async () => {
    const calendar = await startCalendar(() => ({ status: 403, body: JSON.stringify({ error: "forbidden" }) }));

    const result = await readAgenda({
      endpoint: calendar.endpoint,
      allowedOrigins: [calendar.origin],
      accessToken: "token_1",
      ...RANGE,
      fetchImpl: fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("REFUSED");
    // The rule this row is about: freshness is part of the answer, and a read that did not happen is not current.
    expect(result.ok ? "" : result.freshness).toBe("unknown");
  });

  it("reports an unreachable calendar rather than an empty agenda", async () => {
    // A port nothing is listening on: the failure mode where an empty list would be mistaken for a free day.
    const result = await readAgenda({
      endpoint: "http://127.0.0.1:1/calendar/v3",
      allowedOrigins: ["http://127.0.0.1:1"],
      accessToken: "token_1",
      ...RANGE,
      fetchImpl: fetch,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("UNREACHABLE");
    expect(result.ok ? "" : result.freshness).toBe("unknown");
  });

  it("refuses an answer that is not JSON, and one whose endpoint is not a URL", async () => {
    const calendar = await startCalendar(() => ({ status: 200, body: "<html>not json</html>", contentType: "text/html" }));
    const notJson = await readAgenda({
      endpoint: calendar.endpoint,
      allowedOrigins: [calendar.origin],
      accessToken: "token_1",
      ...RANGE,
      fetchImpl: fetch,
    });
    expect(notJson.ok ? "" : notJson.code).toBe("INVALID_RESPONSE");

    const notAUrl = await readAgenda({
      endpoint: "not a url",
      allowedOrigins: [],
      accessToken: "token_1",
      ...RANGE,
      fetchImpl: fetch,
    });
    // Reported, not thrown: this builds a URL, and a base URL that cannot be parsed is an answer the caller can use.
    expect(notAUrl.ok ? "" : notAUrl.code).toBe("ENDPOINT_REFUSED");
  });

  it("skips an entry that is not an event instead of inventing one", async () => {
    const calendar = await startCalendar(() => ({
      status: 200,
      body: JSON.stringify({ items: [{ id: "ev_1", summary: "có thật", start: { dateTime: "2026-09-21T09:00:00Z" }, end: { dateTime: "2026-09-21T10:00:00Z" } }, { summary: "không có id" }] }),
    }));

    const result = await readAgenda({
      endpoint: calendar.endpoint,
      allowedOrigins: [calendar.origin],
      accessToken: "token_1",
      ...RANGE,
      fetchImpl: fetch,
    });

    expect(result.ok ? result.events.length : -1).toBe(1);
  });
});

describe("writing an event", () => {
  it("sends the event in the shape the API takes and reports it as applied", async () => {
    const calendar = await startCalendar((received) =>
      received.method === "POST"
        ? { status: 200, body: JSON.stringify({ id: "ev_new" }) }
        : { status: 200, body: JSON.stringify({ items: [] }) },
    );

    const outcome = await writeEvent({
      endpoint: calendar.endpoint,
      allowedOrigins: [calendar.origin],
      accessToken: "token_1",
      event: {
        title: "họp nhóm",
        startsAt: "2026-09-21T09:00:00+07:00",
        endsAt: "2026-09-21T10:00:00+07:00",
        timezone: "Asia/Ho_Chi_Minh",
      },
      fetchImpl: fetch,
    });

    expect(outcome.status).toBe("applied");
    expect(outcome.status === "applied" ? outcome.eventId : "").toBe("ev_new");
    const body = calendar.received[0]?.body;
    expect(body?.summary).toBe("họp nhóm");
    // The zone travels with the event, so a calendar in another zone stores the moment that was meant.
    expect((body?.start as Record<string, unknown> | undefined)?.timeZone).toBe("Asia/Ho_Chi_Minh");
  });

  it("separates a refusal from a rejection", async () => {
    const refusing = await startCalendar(() => ({ status: 403, body: JSON.stringify({ error: "forbidden" }) }));
    const refused = await writeEvent({
      endpoint: refusing.endpoint,
      allowedOrigins: [refusing.origin],
      accessToken: "token_1",
      event: { title: "x", startsAt: "2026-09-21T09:00:00Z", endsAt: "2026-09-21T10:00:00Z", timezone: "UTC" },
      fetchImpl: fetch,
    });
    expect(refused.status).toBe("refused");

    const rejecting = await startCalendar(() => ({ status: 409, body: JSON.stringify({ error: "duplicate" }) }));
    const conflicted = await writeEvent({
      endpoint: rejecting.endpoint,
      allowedOrigins: [rejecting.origin],
      accessToken: "token_1",
      event: { title: "x", startsAt: "2026-09-21T09:00:00Z", endsAt: "2026-09-21T10:00:00Z", timezone: "UTC" },
      fetchImpl: fetch,
    });
    expect(conflicted.status).toBe("failed");
    expect(conflicted.status === "failed" ? conflicted.code : "").toBe("CONFLICT");
  });

  it("calls a write it did not hear back about unknown, not failed", async () => {
    const calendar = await startCalendar(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return { status: 200, body: JSON.stringify({ id: "too_late" }) };
    });

    const outcome = await writeEvent({
      endpoint: calendar.endpoint,
      allowedOrigins: [calendar.origin],
      accessToken: "token_1",
      event: { title: "x", startsAt: "2026-09-21T09:00:00Z", endsAt: "2026-09-21T10:00:00Z", timezone: "UTC" },
      fetchImpl: fetch,
      timeoutMs: 60,
    });

    /*
     * The assertion this row exists for. A timeout after the request left the machine may well have created the
     * event; reporting that as a failure invites a retry that creates a second one.
     */
    expect(outcome.status).toBe("unknown");
  });

  it("does not claim a write worked when the calendar named no event", async () => {
    const calendar = await startCalendar(() => ({ status: 200, body: JSON.stringify({ kind: "calendar#event" }) }));

    const outcome = await writeEvent({
      endpoint: calendar.endpoint,
      allowedOrigins: [calendar.origin],
      accessToken: "token_1",
      event: { title: "x", startsAt: "2026-09-21T09:00:00Z", endsAt: "2026-09-21T10:00:00Z", timezone: "UTC" },
      fetchImpl: fetch,
    });

    // Accepted but unnameable: the id that would let anybody reference it is missing, so it is not known to have worked.
    expect(outcome.status).toBe("unknown");
  });
});
