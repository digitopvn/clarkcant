import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CommandCard, type ProviderSignInView, isPersonOnlyRoute, parseSlashCommand } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";
import { messagesSince } from "@clarkcant/storage";

import { ProviderSignIns, providerAuthPort } from "../src/application/provider-sign-in.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Slash commands, through the node's own message route: the host answers each one in the conversation with a message
 * and, where there is something to choose, a command card. No model turn runs for a command, and the typed command is
 * not stored as a message of its own.
 */

const AT = "2026-10-05T06:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let sequence = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-slash-"));
  services = bootNodeServices({ dataDir: join(dir, "node"), label: "test node" });
  const port = providerAuthPort(new FakePiAdapter());
  if (port === undefined) throw new Error("the fake adapter no longer signs in");
  services.providerAuth = port;
  sequence = 0;
  deps = {
    services,
    now: () => AT,
    newConversationId: () => {
      sequence += 1;
      return `conv_slash_${sequence}`;
    },
  };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

async function createConversation(title: string): Promise<string> {
  const response = await call("POST", "/conversations", { title });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

/** Sends the command and answers with the host's reply: its sentence and its card, if it carries one. */
async function command(conversationId: string, text: string): Promise<{ body: Record<string, unknown>; text: string; card: CommandCard | undefined }> {
  const response = await call("POST", `/conversations/${conversationId}/messages`, { text });
  expect(response.status).toBe(200);
  const messages = messagesSince(services.runtime.db, conversationId, 0, 40);
  const last = messages.at(-1);
  expect(last?.role).toBe("assistant");
  const said = last?.blocks.find((block) => block.type === "text");
  const card = last?.blocks.find((block) => block.type === "command-card");
  return {
    body: response.body as Record<string, unknown>,
    text: said !== undefined && "content" in said ? String(said.content) : "",
    card: card as CommandCard | undefined,
  };
}

describe("parseSlashCommand", () => {
  it("reads a known command at the start of the message, ignoring the name's case", () => {
    expect(parseSlashCommand("/new")).toEqual({ command: "new", argument: "" });
    expect(parseSlashCommand("  /Thinking  high ")).toEqual({ command: "thinking", argument: "high" });
    expect(parseSlashCommand("/background tóm tắt\ntuần này")).toEqual({ command: "background", argument: "tóm tắt\ntuần này" });
  });

  it("leaves sentences alone, including ones that only look like commands", () => {
    expect(parseSlashCommand("/newsletter ideas")).toBeUndefined();
    expect(parseSlashCommand("mở /sessions giúp tôi")).toBeUndefined();
    expect(parseSlashCommand("/unknown")).toBeUndefined();
    expect(parseSlashCommand("/")).toBeUndefined();
  });
});

describe("slash commands in a conversation", () => {
  it("answers /new with the decision to go home, keeping this conversation", async () => {
    const id = await createConversation("trước");
    const { body, text } = await command(id, "/new");

    expect(body["appIntent"]).toMatchObject({ kind: "intent", intent: { kind: "nav.home" }, requiresConfirmation: false });
    expect(text.length).toBeGreaterThan(0);
    // The command itself is not a message: only the host's answer is recorded.
    expect(messagesSince(services.runtime.db, id, 0, 40).filter((message) => message.role === "user")).toHaveLength(0);
  });

  it("lists earlier conversations on /sessions, with a way to open each and none for this one", async () => {
    const earlier = await createConversation("hồ sơ thuế");
    const current = await createConversation("hiện tại");
    const { card } = await command(current, "/sessions");

    expect(card?.command).toBe("sessions");
    const row = card?.rows.find((candidate) => candidate.rowId === `conversation:${earlier}`);
    expect(row?.actions).toEqual([expect.objectContaining({ action: { kind: "open-conversation", conversationId: earlier } })]);
    expect(card?.rows.some((candidate) => candidate.rowId === `conversation:${current}`)).toBe(false);
  });

  it("sets the thinking level from /thinking, and marks it as the current one afterwards", async () => {
    const id = await createConversation("suy nghĩ");
    const listed = await command(id, "/thinking");
    expect(listed.card?.rows.find((row) => row.current === true)?.rowId).toBe("default");

    await command(id, "/thinking high");
    const after = await command(id, "/thinking");
    const high = after.card?.rows.find((row) => row.rowId === "high");
    expect(high?.current).toBe(true);
    // The chosen level offers nothing to press: it is already chosen.
    expect(high?.actions).toEqual([]);
  });

  it("refuses an unknown thinking level by naming the ones there are", async () => {
    const id = await createConversation("suy nghĩ");
    const { text, card } = await command(id, "/thinking turbo");

    expect(card).toBeUndefined();
    expect(text).toContain("turbo");
    expect(text).toContain("high");
  });

  it("asks for the request when /background has none", async () => {
    const id = await createConversation("nền");
    const { text, card } = await command(id, "/background");

    expect(card).toBeUndefined();
    expect(text).toContain("/background");
  });

  it("offers every provider on /login with the ways it can be signed in to", async () => {
    const id = await createConversation("đăng nhập");
    const { card } = await command(id, "/login");

    const other = card?.rows.find((row) => row.rowId === "fake-other");
    expect(other?.actions.map((entry) => entry.action)).toEqual([
      { kind: "provider-sign-in", providerId: "fake-other", method: "oauth" },
      { kind: "provider-sign-in", providerId: "fake-other", method: "api_key" },
    ]);
  });

  it("offers no sign-out on /logout for a key the node only reads from its environment", async () => {
    const id = await createConversation("đăng xuất");
    const { card } = await command(id, "/logout");

    const fake = card?.rows.find((row) => row.rowId === "fake");
    expect(fake).toBeDefined();
    expect(fake?.actions).toEqual([]);
    expect(fake?.note ?? "").not.toBe("");
  });
});

describe("provider sign-in routes", () => {
  async function waitFor(signInId: string, state: ProviderSignInView["state"]): Promise<ProviderSignInView> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await call("GET", `/providers/sign-ins/${signInId}`);
      const view = response.body as ProviderSignInView;
      if (view.state === state) return view;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`sign-in never reached ${state}`);
  }

  it("signs in with an API key through the card's answer, then signs out of the stored key", async () => {
    const started = await call("POST", "/providers/fake-other/sign-in", { method: "api_key" });
    expect(started.status).toBe(202);
    const { signInId } = started.body as ProviderSignInView;

    const waiting = await waitFor(signInId, "waiting");
    expect(waiting.prompt).toMatchObject({ type: "secret" });

    const answered = await call("POST", `/providers/sign-ins/${signInId}/answer`, { value: "test-key-value" });
    expect(answered.status).toBe(200);
    const done = await waitFor(signInId, "done");
    // The answer is never part of what a later read returns.
    expect(JSON.stringify(done)).not.toContain("test-key-value");

    const listed = (await call("GET", "/providers/auth")).body as { providers: { providerId: string; configured: boolean; source?: string }[] };
    expect(listed.providers.find((entry) => entry.providerId === "fake-other")).toMatchObject({ configured: true, source: "stored" });

    const signedOut = await call("POST", "/providers/fake-other/sign-out", {});
    expect(signedOut.body).toMatchObject({ signedOut: true });
  });

  it("shows the provider's page on an account sign-in, and cancels it without storing anything", async () => {
    const started = await call("POST", "/providers/fake-other/sign-in", { method: "oauth" });
    const { signInId } = started.body as ProviderSignInView;
    const waiting = await waitFor(signInId, "waiting");
    expect(waiting.events).toContainEqual(expect.objectContaining({ type: "auth_url" }));

    const cancelled = await call("POST", `/providers/sign-ins/${signInId}/cancel`, {});
    expect((cancelled.body as ProviderSignInView).state).toBe("cancelled");
    const listed = (await call("GET", "/providers/auth")).body as { providers: { providerId: string; configured: boolean }[] };
    expect(listed.providers.find((entry) => entry.providerId === "fake-other")?.configured).toBe(false);
  });

  it("refuses to sign out of a key that comes from the environment, saying where it lives", async () => {
    const response = await call("POST", "/providers/fake/sign-out", {});
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain("SIGN_OUT_NOT_HERE");
  });

  it("refuses a sign-in method the provider does not have", async () => {
    const response = await call("POST", "/providers/fake/sign-in", { method: "oauth" });
    expect(response.status).toBe(409);
  });

  it("keeps sign-in and sign-out to the person, while the provider list is readable by machine surfaces", () => {
    expect(isPersonOnlyRoute("GET", "/providers/auth")).toBe(false);
    expect(isPersonOnlyRoute("POST", "/providers/fake/sign-in")).toBe(true);
    expect(isPersonOnlyRoute("POST", "/providers/fake/sign-out")).toBe(true);
    expect(isPersonOnlyRoute("GET", "/providers/sign-ins/x")).toBe(true);
    expect(isPersonOnlyRoute("POST", "/providers/sign-ins/x/answer")).toBe(true);
  });
});

describe("ProviderSignIns", () => {
  it("runs one sign-in per provider at a time", () => {
    const port = providerAuthPort(new FakePiAdapter());
    if (port === undefined) throw new Error("the fake adapter no longer signs in");
    const signIns = new ProviderSignIns(port);

    const first = signIns.start("fake-other", "api_key");
    const second = signIns.start("fake-other", "api_key");
    expect(second.signInId).toBe(first.signInId);
    signIns.cancel(first.signInId);
  });

  it("refuses an answer when nothing is being asked", () => {
    const port = providerAuthPort(new FakePiAdapter());
    if (port === undefined) throw new Error("the fake adapter no longer signs in");
    const signIns = new ProviderSignIns(port);

    expect(signIns.answer("missing", "x")).toMatchObject({ ok: false, code: "SIGN_IN_NOT_FOUND" });
  });
});
