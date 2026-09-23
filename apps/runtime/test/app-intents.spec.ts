import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_INTENT_NOT_UNDERSTOOD } from "@clarkcant/contracts";

import { consumeConfirmation, mintConfirmation, type AppIntentDeps } from "../src/app-intents.ts";
import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The application-intent registry.
 *
 * Two properties carry the weight. The first is that the three ways of asking produce one audit
 * record with one kind and only the source differing, which is what "there is no second execution
 * path" means in practice. The second is that quitting cannot happen from a single request: the
 * route hands back a token, the token is single-use, it expires, and it belongs to one principal.
 */

const AT = "2026-09-19T05:00:00.000Z";
const LATER = "2026-09-19T05:10:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let conversationId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-app-intents-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  deps = { services, now: () => AT };
  conversationId = await createConversation();
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function request(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
  const outgoing: GatewayRequest = {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  };
  return handleRequest(deps, outgoing);
}

async function createConversation(): Promise<string> {
  const response = await handleRequest(deps, {
    method: "POST",
    path: "/conversations",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: JSON.stringify({ title: "app intents" }),
  });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

function json(response: GatewayResponse): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

/** Every audit record written so far, newest last. */
function auditRecords(): { kind: string; source: string }[] {
  const rows = services.runtime.db
    .prepare("SELECT document FROM events WHERE kind = ? ORDER BY source_sequence")
    .all("app.intent") as { document: string }[];
  return rows.map((row) => {
    const document = JSON.parse(row.document) as { kind: string; source: string };
    return { kind: document.kind, source: document.source };
  });
}

function intentDeps(): AppIntentDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => AT as never,
    newId: services.conductor.newId,
  };
}

describe("the same intent from three sources", () => {
  it("produces one audit kind and only the source differs", async () => {
    // Typed in the composer.
    const chat = await request("POST", `/conversations/${conversationId}/messages`, { text: "mở settings" });
    expect(chat.status).toBe(200);
    expect((json(chat).appIntent as { kind: string }).kind).toBe("intent");

    // Clicked: the client already knows what it wants.
    const click = await request("POST", "/app-intents", { kind: "settings.open", source: "click" });
    expect(click.status).toBe(200);
    expect((json(click).decision as { kind: string }).kind).toBe("intent");

    // Spoken: the voice session posts the transcript through the same registry.
    const voice = await request("POST", "/app-intents", { text: "mở settings", source: "voice" });
    expect(voice.status).toBe(200);

    const records = auditRecords();
    expect(records).toHaveLength(3);
    // One kind of record, one intent, three sources: there is no second execution path to drift.
    expect(new Set(records.map((record) => record.kind))).toEqual(new Set(["settings.open"]));
    expect(records.map((record) => record.source)).toEqual(["chat", "click", "voice"]);
  });

  it("refuses a request that names no source, and records nothing", async () => {
    const response = await request("POST", "/app-intents", { kind: "settings.open" });
    expect(response.status).toBe(400);
    expect(json(response).code).toBe("INVALID_SCHEMA");
    expect(auditRecords()).toHaveLength(0);
  });

  it("answers an intent that is not the registry's business with none, not a refusal", async () => {
    const response = await request("POST", "/app-intents", {
      text: "xem cài đặt của máy chủ này giúp tôi",
      source: "chat",
    });
    expect(response.status).toBe(200);
    // `none` keeps the caller on the ordinary path; a refusal would stop it.
    expect((json(response).decision as { kind: string }).kind).toBe("none");
    expect(auditRecords()).toHaveLength(0);
  });
});

describe("quitting the application", () => {
  it("is not executable until the confirmation route returns it", async () => {
    const asked = await request("POST", "/app-intents", { text: "thoát ứng dụng", source: "voice" });
    expect(asked.status).toBe(200);
    const decision = json(asked).decision as { kind: string; intent: { kind: string }; confirmationToken: string };
    expect(decision.kind).toBe("needs-confirmation");
    // The intent travels so the question can name what it is asking about, but this is not the
    // executable member: the client runs only `kind: "intent"`, and this is not it. What makes the
    // single request harmless is that the token is required and is not yet permission.
    expect(decision.kind).not.toBe("intent");
    expect(decision.intent.kind).toBe("app.quit");
    expect(decision.confirmationToken).toMatch(/^[0-9a-f-]{36}$/);

    const confirmed = await request("POST", "/app-intents/confirm", {
      confirmationToken: decision.confirmationToken,
      decision: "granted",
    });
    expect(confirmed.status).toBe(200);
    const granted = json(confirmed).decision as { kind: string; intent: { kind: string } };
    expect(granted.kind).toBe("intent");
    expect(granted.intent.kind).toBe("app.quit");

    const records = auditRecords();
    // Only the confirmed quit is audited: the question is not an action.
    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe("voice");
  });

  it("refuses a second confirmation of the same token", async () => {
    const asked = await request("POST", "/app-intents", { text: "thoát ứng dụng", source: "click" });
    const token = (json(asked).decision as { confirmationToken: string }).confirmationToken;

    const first = await request("POST", "/app-intents/confirm", { confirmationToken: token, decision: "granted" });
    expect(first.status).toBe(200);

    const second = await request("POST", "/app-intents/confirm", { confirmationToken: token, decision: "granted" });
    expect(second.status).toBe(409);
    expect(json(second).code).toBe("CONFIRMATION_ALREADY_USED");
  });

  it("refuses a token that is older than the window", async () => {
    const asked = await request("POST", "/app-intents", { text: "thoát ứng dụng", source: "voice" });
    const token = (json(asked).decision as { confirmationToken: string }).confirmationToken;

    const late = { ...deps, now: () => LATER };
    const response = await handleRequest(late, {
      method: "POST",
      path: "/app-intents/confirm",
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: JSON.stringify({ confirmationToken: token, decision: "granted" }),
    });
    expect(response.status).toBe(410);
    expect(json(response).code).toBe("CONFIRMATION_EXPIRED");
  });

  it("refuses a token that was minted for somebody else", async () => {
    const token = mintConfirmation(intentDeps(), {
      principalId: services.runtime.identity.ownerPrincipalId,
      intent: { kind: "app.quit" },
      source: "voice",
    });

    // Not found rather than "belongs to another principal": saying the second thing would confirm the
    // token exists, which is the one fact a prober is after.
    const outcome = consumeConfirmation(intentDeps(), { principalId: "prin_someone_else", token });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("CONFIRMATION_NOT_FOUND");
  });

  it("burns the token even when the answer is no", async () => {
    const asked = await request("POST", "/app-intents", { text: "thoát ứng dụng", source: "click" });
    const token = (json(asked).decision as { confirmationToken: string }).confirmationToken;

    const denied = await request("POST", "/app-intents/confirm", { confirmationToken: token, decision: "denied" });
    expect(denied.status).toBe(200);
    expect(json(denied).granted).toBe(false);
    expect((json(denied).decision as { kind: string }).kind).toBe("refused");

    // A denial is an answer. Letting the same token be answered again would let a "no" be undone.
    const again = await request("POST", "/app-intents/confirm", { confirmationToken: token, decision: "granted" });
    expect(again.status).toBe(409);
  });
});

describe("a typed command in the composer", () => {
  it("is answered by the host, recorded with source chat, and asks no model", async () => {
    const response = await request("POST", `/conversations/${conversationId}/messages`, { text: "mở settings" });
    expect(response.status).toBe(200);

    const records = auditRecords();
    expect(records).toEqual([{ kind: "settings.open", source: "chat" }]);

    // One message, written by the host. A model turn would have left a user message plus a reply.
    const rows = services.runtime.db
      .prepare("SELECT role FROM messages WHERE conversation_id = ?")
      .all(conversationId) as { role: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("assistant");
  });

  it("answers a command-shaped sentence it does not know without an agent turn", async () => {
    const response = await request("POST", `/conversations/${conversationId}/messages`, { text: "mở cửa sổ trời" });
    expect(response.status).toBe(200);
    const decision = json(response).appIntent as { kind: string; say: string };
    expect(decision.kind).toBe("refused");
    expect(decision.say).toBe(APP_INTENT_NOT_UNDERSTOOD);

    const row = services.runtime.db
      .prepare("SELECT document FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { document: string };
    expect(row.document).toContain(APP_INTENT_NOT_UNDERSTOOD);
    // Nothing happened, so there is nothing to have a record of.
    expect(auditRecords()).toHaveLength(0);
  });

  it("still sends an ordinary question to the agent", async () => {
    // The registry must not swallow real work. This one mentions settings and is not a command.
    const response = await request("POST", `/conversations/${conversationId}/messages`, {
      text: "xem cài đặt của máy chủ này giúp tôi",
    });
    // 202 rather than 200: this one was accepted for a turn. The host-answered app intents above return
    // 200, and the difference is the honest one - there is nothing to wait for in those.
    expect(response.status).toBe(202);
    expect(json(response).appIntent).toBeUndefined();

    // It went through the ordinary path, which means the turn machinery saw it - whether the turn
    // itself succeeds depends on a model fixture, and that is not what this test is about.
    const rows = services.runtime.db
      .prepare("SELECT role FROM messages WHERE conversation_id = ?")
      .all(conversationId) as { role: string }[];
    expect(rows.some((row) => row.role === "user")).toBe(true);
  });
});

/**
 * The streaming route.
 *
 * The composer posts here and not to the plain route, so this is the one that decides whether a typed command
 * reaches the registry at all. Wiring only the plain route first is exactly the mistake these tests exist to catch:
 * it looked correct in the suite and did nothing in the browser.
 */
describe("a typed command on the streaming route", () => {
  /** The node writes one JSON object per frame on one line, so a frame is two lines and a blank. */
  function frames(chunks: readonly string[]): { event: string; data: Record<string, unknown> }[] {
    return chunks.map((chunk) => {
      const lines = chunk.split("\n");
      const event = (lines.find((line) => line.startsWith("event: ")) ?? "event: unknown").slice(7).trim();
      const data = (lines.find((line) => line.startsWith("data: ")) ?? "data: {}").slice(6);
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
  }

  async function streamed(text: string): Promise<{ event: string; data: Record<string, unknown> }[]> {
    const response = await request("POST", `/conversations/${conversationId}/messages/stream`, { text });
    expect(response.status).toBe(200);
    const stream = response.stream;
    expect(stream).toBeDefined();
    const chunks: string[] = [];
    await stream?.run((chunk) => chunks.push(chunk));
    return frames(chunks);
  }

  it("carries the decision to the page in the done frame and records the audit event", async () => {
    const events = await streamed("mở settings");

    const done = events.find((event) => event.event === "done");
    expect(done?.data.resolution).toBe("app-intent");
    expect(done?.data.appIntent).toMatchObject({ kind: "intent", intent: { kind: "settings.open" } });
    // The sentence travels as a delta, so the same renderer that draws a reply draws this.
    expect(events.some((event) => event.event === "delta")).toBe(true);
    expect(auditRecords()).toEqual([{ kind: "settings.open", source: "chat" }]);

    // One host message and no turn: a command is not a question, so there is no user message to answer.
    const rows = services.runtime.db
      .prepare("SELECT role FROM messages WHERE conversation_id = ?")
      .all(conversationId) as { role: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("assistant");
  });

  it("refuses a command it cannot match, in the frame and in the conversation both", async () => {
    const events = await streamed("mở cửa sổ trời");

    const done = events.find((event) => event.event === "done");
    expect(done?.data.appIntent).toMatchObject({ kind: "refused", say: APP_INTENT_NOT_UNDERSTOOD });
    // Nothing was done, so nothing is audited.
    expect(auditRecords()).toHaveLength(0);
  });

  it("carries a quit as a question with a token", async () => {
    const events = await streamed("thoát ứng dụng");

    const done = events.find((event) => event.event === "done");
    const decision = done?.data.appIntent as { kind: string; confirmationToken?: string };
    expect(decision.kind).toBe("needs-confirmation");
    expect(decision.confirmationToken).toMatch(/^[0-9a-f-]{36}$/);
  });
});

/**
 * The read-back follows the stored UI language, not the language the answer used to default to.
 *
 * `experience.language` is the same `scope: "global"` preference the settings panel's Language control
 * writes, so setting it through `/preferences/experience.language` is exactly what a person switching
 * the UI to English does. Before this, `decideAppIntent`/`describeAppIntent` never saw that choice: a
 * click, a typed command and a spoken one all read back in Vietnamese regardless of the UI language,
 * which is the bug this suite guards against.
 */
describe("the read-back follows the stored UI language", () => {
  it("answers a click in Vietnamese by default", async () => {
    const click = await request("POST", "/app-intents", { kind: "settings.open", source: "click" });
    expect(click.status).toBe(200);
    const decision = json(click).decision as { readBack: string };
    expect(decision.readBack).toBe("Tôi mở Settings nhé.");
  });

  it("answers a click in English once the UI language preference is set", async () => {
    const written = await request("PUT", "/preferences/experience.language", { value: "en" });
    expect(written.status).toBe(200);

    const click = await request("POST", "/app-intents", { kind: "settings.open", source: "click" });
    expect(click.status).toBe(200);
    const decision = json(click).decision as { readBack: string };
    expect(decision.readBack).toBe("Opening Settings.");
  });

  it("answers a typed command through the chat path in English too", async () => {
    await request("PUT", "/preferences/experience.language", { value: "en" });

    const chat = await request("POST", `/conversations/${conversationId}/messages`, { text: "mở settings" });
    expect(chat.status).toBe(200);
    const appIntent = json(chat).appIntent as { readBack: string };
    expect(appIntent.readBack).toBe("Opening Settings.");
  });

  it("answers a confirmed quit in English once the UI language preference is set", async () => {
    await request("PUT", "/preferences/experience.language", { value: "en" });

    const asked = await request("POST", "/app-intents", { text: "thoát ứng dụng", source: "click" });
    const token = (json(asked).decision as { confirmationToken: string }).confirmationToken;
    const confirmed = await request("POST", "/app-intents/confirm", {
      confirmationToken: token,
      decision: "granted",
    });
    expect(confirmed.status).toBe(200);
    const decision = json(confirmed).decision as { readBack: string };
    expect(decision.readBack).toBe("I understand you want to quit the app. Do you confirm?");
  });
});
