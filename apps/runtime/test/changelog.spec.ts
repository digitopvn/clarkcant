import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ChangelogCard, type Instant, changelogCardSchema, instantSchema } from "@clarkcant/contracts";
import { messagesSince } from "@clarkcant/storage";

import {
  RELEASE_NOTES_FILE,
  type ReleaseHistoryRead,
  describeChangelog,
  parseReleaseHistory,
  readChangelog,
  readEmbeddedReleaseHistory,
} from "../src/application/changelog.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { createNodeTools } from "../src/node-tools.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createShowChangelogTool } from "../src/show-changelog-tool.ts";

/**
 * The changelog: one capability, reached by `/changelog`, Clark's `show_changelog` and `GET /changelog`, all reading the
 * release notes embedded with the build.
 */

const AT = "2026-10-06T06:00:00.000Z";
const SOURCE = "https://github.com/digitopvn/clarkcant/releases";
const RANGE = { from: "806c39686b2b531a4671f519e7d8072041b2a494", to: "a448d3e4a448d3e4a448d3e4a448d3e4a448d3e4" };

function record(version: string, previousVersion: string, summary: string) {
  return {
    version,
    kind: "release",
    channel: "stable",
    date: "2026-10-06",
    previousVersion,
    commitRange: RANGE,
    notes: `## ${version}\n\n* ${summary}`,
    entries: [{ kind: "fix", summary, scope: "runtime", commit: "a448d3e4a448" }],
    omittedEntries: 2,
    artifacts: [],
  };
}

const FIXTURE: ReleaseHistoryRead = parseReleaseHistory(
  JSON.stringify({
    schemaVersion: 1,
    build: { version: "1.5.0", channel: "stable" },
    source: SOURCE,
    releases: [
      record("1.5.0", "1.4.2", "keep the queued message"),
      record("1.4.2", "1.4.0", "stop reading dated model ids as phone numbers"),
      record("1.4.0", "0.2.1", "word the host text in the owner's language"),
      {
        version: "0.2.1",
        kind: "baseline",
        date: "2026-10-01",
        previousVersion: null,
        commitRange: { from: null, to: RANGE.from },
        notes: "history",
        entries: [],
        omittedEntries: 0,
        artifacts: [],
      },
    ],
  }),
);
const fixture = (): ReleaseHistoryRead => FIXTURE;

describe("the embedded release notes", () => {
  it("ship with the runtime, match their contract and name the canonical Clark version", () => {
    const read = readEmbeddedReleaseHistory();
    expect(read.ok, read.ok ? "" : read.reason).toBe(true);
    if (!read.ok) return;
    const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(read.history.build.version).toBe(root.version);
    // Real history, not a sample: the baseline names the commit it was built from.
    expect(read.history.releases.at(-1)?.kind).toBe("baseline");
    expect(read.history.releases.at(-1)?.commitRange.to).toMatch(/^[0-9a-f]{40}$/);
    expect(RELEASE_NOTES_FILE.pathname.endsWith("/apps/runtime/release-notes.json")).toBe(true);
  });

  it("reports a record that breaks its contract instead of showing part of it", () => {
    expect(parseReleaseHistory("{")).toMatchObject({ ok: false });
    const wrong = parseReleaseHistory(JSON.stringify({ schemaVersion: 2 }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toMatch(/contract/);
  });
});

describe("readChangelog", () => {
  it("lists every release, newest first, with the installed version", () => {
    const answer = readChangelog({}, fixture);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.view.installed).toEqual({ version: "1.5.0", channel: "stable" });
    expect(answer.view.releases.map((release) => release.version)).toEqual(["1.5.0", "1.4.2", "1.4.0", "0.2.1"]);
    expect(answer.view.source).toBe(SOURCE);
    // The view carries entries, never the raw notes markdown or artifacts.
    expect(Object.keys(answer.view.releases[0] ?? {})).not.toContain("notes");
  });

  it("keeps only what came after a version written the way people write it", () => {
    const answer = readChangelog({ since: "v1.4" }, fixture);
    expect(answer.ok && answer.view.since).toBe("1.4.0");
    expect(answer.ok && answer.view.releases.map((release) => release.version)).toEqual(["1.5.0", "1.4.2"]);
    const none = readChangelog({ since: "1.5" }, fixture);
    expect(none.ok && none.view.releases).toEqual([]);
  });

  it("refuses a value that is not a version rather than reading it as everything", () => {
    expect(readChangelog({ since: "yesterday" }, fixture)).toMatchObject({ ok: false, code: "invalid-version" });
  });

  it("says the notes are unavailable when the build carries none", () => {
    expect(readChangelog({}, () => ({ ok: false, reason: "missing" }))).toEqual({ ok: false, code: "unavailable", message: "missing" });
  });
});

describe("show_changelog", () => {
  let ids = 0;
  const tool = createShowChangelogTool({
    newId: (prefix) => `${prefix}_${String((ids += 1))}`,
    now: () => instantSchema.parse(AT),
    load: fixture,
  });

  it("answers with the host-owned card and the same entries for the model, said to be the whole record", async () => {
    const result = await tool.execute({ since: "1.4" });
    const card = changelogCardSchema.parse(result.hostCard);
    expect(card.releases.map((release) => release.version)).toEqual(["1.5.0", "1.4.2"]);
    expect(result.text).toContain("keep the queued message");
    expect(result.text).toContain("never add, invent or embellish");
    expect(result.text).toContain("do not offer to update");
    expect(result.text).toContain("2 more changes");
    expect(result.text).not.toContain("word the host text");
  });

  it("draws no card for a version it cannot read, and tells the model not to describe changes from memory", async () => {
    const invalid = await tool.execute({ since: "the last one" });
    expect(invalid.hostCard).toBeUndefined();
    const broken = createShowChangelogTool({ newId: () => "card_x", now: () => instantSchema.parse(AT), load: () => ({ ok: false, reason: "missing" }) });
    const unavailable = await broken.execute({});
    expect(unavailable.hostCard).toBeUndefined();
    expect(unavailable.text).toContain("do not describe changes from memory");
  });

  it("is registered only when the turn can record its card", () => {
    expect(describeChangelog({ installed: { version: "0.2.1", channel: "source" }, releases: [], source: SOURCE })).toContain("run from source");
    const names = (changelog?: { newId: (prefix: string) => string; now: () => Instant }) =>
      createNodeTools({
        search: { db: undefined as never, principalId: "p", nodeId: "n", now: () => instantSchema.parse(AT) } as never,
        projects: {} as never,
        ...(changelog === undefined ? {} : { changelog }),
      }).map((entry) => entry.name);
    expect(names()).not.toContain("show_changelog");
    expect(names({ newId: () => "card_1", now: () => instantSchema.parse(AT) })).toContain("show_changelog");
  });
});

describe("/changelog and GET /changelog", () => {
  let dir: string;
  let services: NodeServices;
  let deps: GatewayDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-changelog-"));
    services = bootNodeServices({ dataDir: join(dir, "node"), label: "test node" });
    deps = { services, now: () => AT, newConversationId: () => "conv_changelog" };
  });

  afterEach(() => {
    services.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (method: string, path: string, query: Record<string, string> = {}, body?: unknown) =>
    handleRequest(deps, {
      method,
      path,
      query,
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: body === undefined ? "" : JSON.stringify(body),
    });

  it("serves the embedded notes, the same view the card carries", async () => {
    const response = await call("GET", "/changelog");
    expect(response.status).toBe(200);
    const embedded = readEmbeddedReleaseHistory();
    if (!embedded.ok) throw new Error(embedded.reason);
    expect(response.body).toMatchObject({ installed: embedded.history.build, source: embedded.history.source });
    expect(await call("GET", "/changelog", { since: "not a version" })).toMatchObject({ status: 400, body: { code: "INVALID_SCHEMA" } });
  });

  it("is refused without the bearer token", async () => {
    const response = await handleRequest(deps, { method: "GET", path: "/changelog", query: {}, headers: {}, body: "" });
    expect(response.status).toBe(401);
  });

  it("answers /changelog in the conversation with the host-owned card and stores no user message", async () => {
    const created = await call("POST", "/conversations", {}, { title: "có gì mới" });
    const conversationId = (created.body as { conversationId: string }).conversationId;
    const response = await call("POST", `/conversations/${conversationId}/messages`, {}, { text: "/changelog" });
    expect(response.status).toBe(200);
    const messages = messagesSince(services.runtime.db, conversationId, 0, 40);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(0);
    const card = messages.at(-1)?.blocks.find((block) => block.type === "changelog-card") as ChangelogCard | undefined;
    expect(card?.owner).toBe("host");
    expect(changelogCardSchema.safeParse(card).success).toBe(true);
    const said = messages.at(-1)?.blocks.find((block) => block.type === "text");
    expect(said !== undefined && "content" in said ? String(said.content) : "").toMatch(/Clark \d+\.\d+\.\d+/);
  });

  it("names a bad version in /changelog instead of drawing a card", async () => {
    const created = await call("POST", "/conversations", {}, { title: "phiên bản" });
    const conversationId = (created.body as { conversationId: string }).conversationId;
    await call("POST", `/conversations/${conversationId}/messages`, {}, { text: "/changelog hôm qua" });
    const last = messagesSince(services.runtime.db, conversationId, 0, 40).at(-1);
    expect(last?.blocks.some((block) => block.type === "changelog-card")).toBe(false);
    const said = last?.blocks.find((block) => block.type === "text");
    expect(said !== undefined && "content" in said ? String(said.content) : "").toContain("hôm qua");
  });
});
