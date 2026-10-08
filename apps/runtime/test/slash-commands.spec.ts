import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CommandCard, type ProviderSignInView, isPersonOnlyRoute, parseSlashCommand } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";
import { messagesSince } from "@clarkcant/storage";

import { type ProviderAuthPort, ProviderSignIns, providerAuthPort } from "../src/application/provider-sign-in.ts";
import { createWidgetDevSessions } from "../src/application/widget-dev-sessions.ts";
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

  it("names the unset level auto, in the same words as the statusline, without making it a level of its own", async () => {
    const id = await createConversation("suy nghĩ");
    const vi = await command(id, "/thinking");
    expect(vi.text).toContain("tự động");
    expect(vi.card?.rows.find((row) => row.rowId === "default")?.label).toBe("Tự động (mặc định của model)");

    expect((await call("PUT", "/preferences/experience.language", { value: "en" })).status).toBe(200);
    const en = await command(id, "/thinking");
    expect(en.text).toContain("Thinking level now: auto");
    const auto = en.card?.rows.find((row) => row.rowId === "default");
    expect(auto?.label).toBe("Auto (model default)");
    expect(auto?.current).toBe(true);
    // The explicit efforts keep their own names, and choosing auto still clears the level rather than sending "auto".
    expect(en.card?.rows.map((row) => row.rowId)).toEqual(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

    await command(id, "/thinking high");
    const cleared = await command(id, "/thinking auto");
    expect(cleared.text).toBe("Thinking is back to auto: from the next turn, the model uses its own default.");
    expect((await command(id, "/thinking")).card?.rows.find((row) => row.current === true)?.rowId).toBe("default");
  });

  it("refuses an unknown thinking level by naming the ones there are", async () => {
    const id = await createConversation("suy nghĩ");
    const { text, card } = await command(id, "/thinking turbo");

    expect(card).toBeUndefined();
    expect(text).toContain("turbo");
    expect(text).toContain("high");
  });

  it("answers /settings with the host's own decision to open Settings, on a tab when one is named", async () => {
    const id = await createConversation("cài đặt");
    const plain = await command(id, "/settings");
    expect(plain.body["appIntent"]).toEqual({ kind: "intent", intent: { kind: "settings.open" }, requiresConfirmation: false, readBack: "Tôi mở Settings nhé." });
    expect(plain.text).toBe("Tôi mở Settings nhé.");
    expect(plain.card).toBeUndefined();

    // A tab by its id, by its Vietnamese words with or without marks, and after the word "tab".
    for (const [argument, tab] of [["ai", "ai"], ["thiết bị", "devices"], ["Kiem Soat", "control"], ["tab memory", "memory"]] as const) {
      const named = await command(id, `/settings ${argument}`);
      expect(named.body["appIntent"]).toMatchObject({ kind: "intent", intent: { kind: "settings.tab", tab }, requiresConfirmation: false });
    }

    // The command is not stored as the person's message, and the conversation keeps everything it had.
    expect(messagesSince(services.runtime.db, id, 0, 40).filter((message) => message.role === "user")).toHaveLength(0);
  });

  it("refuses a Settings tab that does not exist by naming the ones there are, and opens nothing", async () => {
    const id = await createConversation("cài đặt");
    const { body, text } = await command(id, "/settings billing");

    expect(body["appIntent"]).toBeUndefined();
    expect(text).toContain("billing");
    expect(text).toContain("experience, ai, control, extensions, devices, memory, developer");
  });

  it("reads /settings back in English when the person's language is English", async () => {
    const id = await createConversation("settings");
    expect((await call("PUT", "/preferences/experience.language", { value: "en" })).status).toBe(200);

    const { body, text } = await command(id, "/settings devices");
    expect(text).toBe("Opening Settings on the Devices & Voice tab.");
    expect(body["appIntent"]).toMatchObject({ intent: { kind: "settings.tab", tab: "devices" }, readBack: text });
    expect((await command(id, "/settings nowhere")).text).toBe(
      'Settings has no tab "nowhere". Tabs: experience, ai, control, extensions, devices, memory, developer. Type /settings to open Settings.',
    );
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

  it("says plainly on /develop when the node is not running widget dev sessions", async () => {
    const id = await createConversation("phát triển");
    const { text, card } = await command(id, "/develop");

    expect(card).toBeUndefined();
    expect(text.length).toBeGreaterThan(0);
  });

  it("offers on /develop to choose a folder, and on /develop <folder> to develop that one, with the sessions there are", async () => {
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false });
    try {
      const id = await createConversation("phát triển");
      const plain = await command(id, "/develop");
      expect(plain.card).toMatchObject({ command: "develop", owner: "host" });
      expect(plain.card?.rows.map((row) => row.rowId)).toEqual(["choose"]);
      expect(plain.card?.rows[0]?.actions).toEqual([expect.objectContaining({ tone: "primary", action: { kind: "develop-folder" } })]);

      const typed = join(dir, "projects", "đồng hồ");
      mkdirSync(typed, { recursive: true });
      // The card names the folder as it resolves on the node.
      const folder = realpathSync.native(typed);
      const named = await command(id, `/develop ${typed}`);
      expect(named.card?.rows.map((row) => row.rowId)).toEqual(["proposed", "choose"]);
      expect(named.card?.rows[0]).toMatchObject({ label: folder, actions: [{ action: { kind: "develop-folder", root: folder } }] });
      // The card only offers: nothing starts until the person presses it.
      expect(services.widgetDev.list()).toEqual([]);
    } finally {
      await services.widgetDev.close();
    }
  });

  it("lists on /develop forget the folders Clark may develop in because the person chose them, and says when there are none", async () => {
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false });
    try {
      const id = await createConversation("thu hồi");
      const { text, card } = await command(id, "/develop Forget");
      expect(card).toMatchObject({ command: "develop", owner: "host", rows: [] });
      expect(card?.empty ?? "").not.toBe("");
      expect(text.length).toBeGreaterThan(0);
      // The word is the command's, not a folder: nothing is offered to develop.
      expect(card?.rows.some((row) => row.rowId === "proposed")).toBe(false);
    } finally {
      await services.widgetDev.close();
    }
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

  it("leaves a key typed into the /login card nowhere on the node: no table, no file, no log line, no later reply", async () => {
    const KEY = "sk-sentinel-4f9c2e7a1b8d4c63-must-not-persist";
    // The control: a string the node does store, which the same scan has to find for its silence about the key to
    // mean anything.
    const MARKER = "marker-7c1d-conversation-title";
    let markerInTable = false;
    let markerInFile = false;
    const written: string[] = [];
    const capture = (chunk: unknown): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    const replies: unknown[] = [];
    try {
      // The whole journey a person takes: the command in a conversation, the card's sign-in, the key, then more
      // commands in the same conversation that read back what the node knows.
      const conversationId = await createConversation(MARKER);
      replies.push(await command(conversationId, "/login"));
      const started = await call("POST", "/providers/fake-other/sign-in", { method: "api_key" });
      const { signInId } = started.body as ProviderSignInView;
      await waitFor(signInId, "waiting");
      replies.push((await call("POST", `/providers/sign-ins/${signInId}/answer`, { value: KEY })).body);
      replies.push(await waitFor(signInId, "done"));
      replies.push((await call("GET", "/providers/auth")).body);
      replies.push(await command(conversationId, "/login"));
      replies.push(await command(conversationId, "/logout"));
      replies.push(await command(conversationId, "/sessions"));
      replies.push((await call("GET", `/conversations/${conversationId}`)).body);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }

    expect(JSON.stringify(replies)).not.toContain(KEY);
    expect(written.join("")).not.toContain(KEY);

    // Every table, which is where the transcript, the search index, the audit trail and the context a later turn is
    // built from all live. Read by name from the schema, so a table added later is covered without being listed here.
    const db = services.runtime.db;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(tables.length).toBeGreaterThan(10);
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
      const dump = JSON.stringify(rows, (_key, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value));
      expect(dump.includes(KEY), `table ${table} holds the key`).toBe(false);
      markerInTable ||= dump.includes(MARKER);
    }
    expect(markerInTable).toBe(true);

    // And every file under the node's data directory, the database's own pages and write-ahead log included.
    const files = readdirSync(join(dir, "node"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(join(file.parentPath, file.name));
      expect(bytes.includes(KEY), `${file.name} holds the key`).toBe(false);
      markerInFile ||= bytes.includes(MARKER);
    }
    expect(markerInFile).toBe(true);
  });

  it("keeps a typed key out of what the provider says back about it", async () => {
    const KEY = "sk-sentinel-9d1e5b2c7a3f4e80-echoed-by-provider";
    // A provider that repeats the key it was given: once as progress, once in the reason it refuses it.
    const echoing: ProviderAuthPort = {
      providerAuth: async () => [],
      signOut: async () => undefined,
      signIn: async (_providerId, _method, interaction) => {
        const value = await interaction.prompt({ type: "secret", message: "API key" });
        interaction.notify({ type: "progress", message: `checking ${value}` });
        throw new Error(`401 Unauthorized: the key ${value} is not valid`);
      },
    };
    const signIns = new ProviderSignIns(echoing);

    const { signInId } = signIns.start("echoing", "api_key");
    await vi.waitFor(() => expect(signIns.view(signInId)?.state).toBe("waiting"));
    const answered = signIns.answer(signInId, KEY);
    await vi.waitFor(() => expect(signIns.view(signInId)?.state).toBe("failed"));

    const view = signIns.view(signInId);
    expect(JSON.stringify([answered, view])).not.toContain(KEY);
    // The reason is still told, with the key's place marked.
    expect(view?.error).toContain("401 Unauthorized");
    expect(view?.error).toContain("[redacted]");
    expect(view?.events).toEqual([{ type: "progress", message: "checking [redacted]" }]);
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
