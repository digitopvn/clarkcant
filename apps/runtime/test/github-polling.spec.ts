import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationId, Instant, MessageRecord } from "@clarkcant/contracts";
import { ingestSignal } from "@clarkcant/core";
import {
  allRows,
  createConversation,
  getSignalPollState,
  parseJson,
  putCredential,
  putSecretMetadata,
} from "@clarkcant/storage";

import { createAutomationTools } from "../src/automation-tools.ts";
import { startAutomationService } from "../src/automation-service.ts";
import { GITHUB_POLL_INTERVAL_MS, createGithubPolling, type GithubPolling } from "../src/github-polling.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A node GitHub cannot deliver to, reading its repositories' events instead.
 *
 * The node is real — its store, its secret broker, its inbox, its automation service — and so are the events: GitHub's
 * recorded issue payload, listed the way the Events API lists them. Only GitHub itself is a recording, so what the node
 * asked for, and with which headers, is what the tests read.
 */

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "packages", "signal-sources", "test", "fixtures", "github");
const REPOSITORY = "Codertocat/Hello-World";
const CONVERSATION_ID = "conv_github_poll" as ConversationId;
const TOKEN = "fixture-github-token-value";
const START = Date.parse("2026-09-29T08:00:00.000Z");
/** Longer than any back-off, so each attempt is due. */
const MAX_WAIT = 6 * 60 * 60_000;

interface Call {
  url: string;
  headers: Record<string, string>;
}

let dir: string;
let services: NodeServices;
let clock: number;
let calls: Call[];
let answer: (call: Call) => Response;
let polling: GithubPolling;

const now = (): Instant => new Date(clock).toISOString() as Instant;

const fakeFetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
  const call = { url, headers: init?.headers ?? {} };
  calls.push(call);
  return answer(call);
}) as unknown as typeof globalThis.fetch;

function boot(): void {
  services = bootNodeServices({ dataDir: dir, label: "github polling node" });
  polling = createGithubPolling(services, { fetch: fakeFetch, now });
}

const issue = JSON.parse(readFileSync(join(FIXTURES, "issues.labeled.json"), "utf8")) as Record<string, unknown>;

/** The Events API's answer: newest first, an issue labelled for each id. */
function listing(ids: string[], headers: Record<string, string> = {}): Response {
  const events = [...ids].reverse().map((id) => ({
    id,
    type: "IssuesEvent",
    actor: { login: "someone" },
    repo: { name: REPOSITORY },
    payload: { action: "labeled", issue: issue.issue, label: issue.label },
    created_at: "2026-09-29T07:59:00Z",
  }));
  return new Response(JSON.stringify(events), { status: 200, headers });
}

function later(ms: number): void {
  clock += ms;
}

function signalKeys(): string[] {
  return allRows<{ dedupe_key: string }>(services.runtime.db, "SELECT dedupe_key FROM signal_deliveries ORDER BY received_at, dedupe_key").map(
    (row) => row.dedupe_key,
  );
}

function notices(): { title: string; body: string; conversation_id: string | null; subject: string | null }[] {
  return allRows(services.runtime.db, "SELECT title, body, conversation_id, subject FROM notifications ORDER BY created_at");
}

function assistantTexts(): string[] {
  return allRows<{ document: string }>(services.runtime.db, "SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence", CONVERSATION_ID).flatMap(
    (row) => {
      const message = parseJson<MessageRecord>(row.document, "messages.document");
      if (message.role !== "assistant") return [];
      return message.blocks.flatMap((block) => (block.type === "text" ? [block.content] : []));
    },
  );
}

function tools() {
  return createAutomationTools({
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    principalId: services.runtime.identity.ownerPrincipalId,
    conversationId: CONVERSATION_ID,
    now,
    newId: services.conductor.newId,
    ownedRoots: () => [dir],
    kick: () => undefined,
  });
}

async function call(name: string, params: Record<string, unknown> = {}): Promise<string> {
  const tool = tools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no ${name}`);
  return ((await tool.execute(params as never)) as { text: string }).text;
}

/** "Remind me when an issue is labelled in Codertocat/Hello-World", as the agent sets it up. */
async function remindOnLabel(match: unknown[] = [{ path: "subject.refs.repository", op: "equals", value: REPOSITORY }]): Promise<void> {
  await call("create_automation", { summary: "Nhắc khi issue có nhãn", topic: "github.issue.labeled", match, action: "remind", message: "xem issue" });
}

/** The token as the person stores it, for the consumers the agent names; stored at the node's clock. */
function storeToken(consumers: string[]): void {
  const principalId = services.runtime.identity.ownerPrincipalId;
  putCredential(services.runtime.db, { principalId, name: "github_token", value: TOKEN, at: now() });
  putSecretMetadata(services.runtime.db, {
    secretId: services.conductor.newId("secret"),
    principalId,
    name: "github_token",
    description: "GitHub token",
    kind: "token",
    backend: "node-store",
    backendRef: "github_token",
    allowedConsumers: consumers,
    injectionPolicy: consumers.some((consumer) => consumer.startsWith("command:")) ? "process-env" : "tool-only",
    nodeId: services.runtime.identity.nodeId,
    at: now(),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-github-polling-"));
  clock = START;
  calls = [];
  answer = () => listing([]);
  boot();
  createConversation(services.runtime.db, { conversationId: CONVERSATION_ID, homeNodeId: services.runtime.identity.nodeId, at: now() });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("which repositories a node polls", () => {
  it("asks GitHub nothing while no active GitHub automation names a repository", async () => {
    expect(await polling.pollDue()).toBe(0);
    // One about GitHub but bound to no repository, and one bound to an Enterprise server, give a poll nothing to ask for.
    await remindOnLabel([]);
    await remindOnLabel([
      { path: "subject.refs.repository", op: "equals", value: REPOSITORY },
      { path: "subject.refs.host", op: "equals", value: "github.example.com" },
    ]);
    expect(await polling.pollDue()).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("a repository's events become signals", () => {
  it("once each, across a restart, going on from the stored cursor, and a reminder answers them", async () => {
    await remindOnLabel();
    answer = () => listing(["100", "101"]);

    // The first poll finds where "now" is: what happened before the automation existed is not news.
    expect(await polling.pollDue()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${REPOSITORY}/events?per_page=100`);
    expect(getSignalPollState(services.runtime.db, "github.com/codertocat/hello-world")?.cursor).toBe("101");

    // Asked again before five minutes are up, it does not ask GitHub.
    later(GITHUB_POLL_INTERVAL_MS - 1);
    expect(await polling.pollDue()).toBe(0);
    expect(calls).toHaveLength(1);

    later(1);
    answer = () => listing(["100", "101", "102", "103"]);
    expect(await polling.pollDue()).toBe(2);
    expect(signalKeys()).toEqual(["event:102", "event:103"]);

    // The automation service matches them like any delivery: one reminder each, said in the conversation.
    const service = startAutomationService(services, { intervalMs: 3_600_000, now });
    service.tick();
    service.stop();
    expect(assistantTexts().filter((text) => text.includes("xem issue"))).toHaveLength(2);

    // A restart reads the cursor back: the same listing is nothing new, and only what came after it is recorded.
    services.runtime.close();
    boot();
    later(GITHUB_POLL_INTERVAL_MS);
    expect(await polling.pollDue()).toBe(0);
    later(GITHUB_POLL_INTERVAL_MS);
    answer = () => listing(["100", "101", "102", "103", "104"]);
    expect(await polling.pollDue()).toBe(1);
    expect(signalKeys()).toEqual(["event:102", "event:103", "event:104"]);
    expect(calls).toHaveLength(4);
  });

  it("is polled from the automation service's tick, one pass at a time, and what it records is answered at once", async () => {
    await remindOnLabel();
    answer = () => listing(["100"]);
    await polling.pollDue();
    later(GITHUB_POLL_INTERVAL_MS);
    answer = () => listing(["100", "101"]);

    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let passes = 0;
    const service = startAutomationService(services, {
      intervalMs: 3_600_000,
      now,
      pollSignals: async () => {
        passes += 1;
        await gate;
        return polling.pollDue();
      },
    });
    try {
      service.tick();
      service.tick();
      // The second tick found a pass still running and did not start another.
      expect(passes).toBe(1);
      open();
      // Recorded, then matched without waiting for the next interval.
      await vi.waitFor(() => expect(assistantTexts().filter((text) => text.includes("xem issue"))).toHaveLength(1));
    } finally {
      service.stop();
    }
  });

  it("sends GitHub's tag back, takes a 304 as nothing new, and waits as long as GitHub asks", async () => {
    await remindOnLabel();
    answer = () => listing(["100"], { etag: 'W/"first"', "x-poll-interval": "600" });
    await polling.pollDue();

    // GitHub asked for ten minutes: five is not enough.
    later(GITHUB_POLL_INTERVAL_MS);
    await polling.pollDue();
    expect(calls).toHaveLength(1);

    later(GITHUB_POLL_INTERVAL_MS);
    answer = () => new Response(null, { status: 304, headers: { "x-poll-interval": "60" } });
    expect(await polling.pollDue()).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers["if-none-match"]).toBe('W/"first"');
    const state = getSignalPollState(services.runtime.db, "github.com/codertocat/hello-world");
    expect(state).toMatchObject({ cursor: "100", etag: 'W/"first"', failures: 0 });
    // Sixty seconds is less than the floor, so the floor holds.
    expect(state?.nextPollAt).toBe(new Date(clock + GITHUB_POLL_INTERVAL_MS).toISOString());
  });

  it("leaves a repository alone while its webhook delivers, and polls it again a day after the last delivery", async () => {
    await remindOnLabel();
    const deps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now, newId: services.conductor.newId };
    const delivered = ingestSignal(deps, {
      source: { kind: "external", provider: "github", sourceId: `github:github.com/${REPOSITORY}` },
      topic: "github.issue.labeled",
      payload: {},
      occurredAt: now(),
      dedupeKey: "delivery:abc",
      provenance: { via: "github webhook" },
    });
    expect(delivered.ok).toBe(true);

    later(23 * 60 * 60_000);
    expect(await polling.pollDue()).toBe(0);
    expect(calls).toEqual([]);

    later(60 * 60_000);
    await polling.pollDue();
    expect(calls).toHaveLength(1);
  });
});

describe("a private repository, and GitHub refusing", () => {
  it("tells the person once when GitHub refuses, backs off, and goes again as soon as a token it may use is stored", async () => {
    await remindOnLabel();
    // A private repository answers 404 to a request without a token.
    answer = (request) => (request.headers.authorization === undefined ? new Response("{}", { status: 404 }) : listing(["100"]));

    await polling.pollDue();
    later(GITHUB_POLL_INTERVAL_MS);
    await polling.pollDue();
    expect(calls).toHaveLength(2);
    // Twice as long before the third try.
    later(GITHUB_POLL_INTERVAL_MS);
    await polling.pollDue();
    expect(calls).toHaveLength(2);

    const told = notices();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: `Chưa theo dõi được ${REPOSITORY}`, conversation_id: CONVERSATION_ID });
    expect(told[0]?.body).toContain("repository riêng tư");
    // It names the repository, so quieting it quiets this repository's polling and no other's.
    expect(JSON.parse(told[0]?.subject ?? "null")).toEqual({
      kind: "signal-source",
      sourceKey: "github.com/codertocat/hello-world",
      label: REPOSITORY,
      conversationId: CONVERSATION_ID,
    });
    // The agent, asked about it, reads exactly what to ask for.
    expect(await call("list_automations")).toContain(
      `GitHub polling of ${REPOSITORY} has failed 2 time(s)`,
    );
    expect(await call("list_automations")).toContain('consumer "command:gh,command:git,signals:github"');

    // A token only git and gh may use is not offered to GitHub's API.
    storeToken(["command:gh", "command:git"]);
    later(1);
    await polling.pollDue();
    expect(calls).toHaveLength(3);
    expect(calls[2]?.headers.authorization).toBeUndefined();

    // Stored again for the poller too: tried at once, and read.
    later(1);
    storeToken(["command:gh", "command:git", "signals:github"]);
    later(1);
    await polling.pollDue();
    expect(calls).toHaveLength(4);
    expect(calls[3]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(getSignalPollState(services.runtime.db, "github.com/codertocat/hello-world")).toMatchObject({ cursor: "100", failures: 0 });
    expect(notices()).toHaveLength(1);
  });

  it("never writes the token anywhere: not in a signal, the poll state, the inbox, the conversation or the log", async () => {
    await remindOnLabel();
    storeToken(["command:gh", "command:git", "signals:github"]);
    const logged: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    try {
      answer = () => listing(["100"]);
      await polling.pollDue();
      later(GITHUB_POLL_INTERVAL_MS);
      answer = () => listing(["100", "101"]);
      expect(await polling.pollDue()).toBe(1);
      // And when GitHub refuses the token, three times over.
      answer = () => new Response("{}", { status: 401 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        later(MAX_WAIT);
        await polling.pollDue();
      }
      const service = startAutomationService(services, { intervalMs: 3_600_000, now });
      service.tick();
      service.stop();
    } finally {
      stderr.mockRestore();
    }
    expect(calls.every((request) => request.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const stored = [
      ...allRows<{ document: string }>(services.runtime.db, "SELECT document FROM signal_deliveries").map((row) => row.document),
      ...allRows<Record<string, unknown>>(services.runtime.db, "SELECT * FROM signal_poll_state").map((row) => JSON.stringify(row)),
      ...allRows<Record<string, unknown>>(services.runtime.db, "SELECT * FROM notifications").map((row) => JSON.stringify(row)),
      ...allRows<{ document: string }>(services.runtime.db, "SELECT document FROM messages").map((row) => row.document),
      ...logged,
    ];
    expect(stored.length).toBeGreaterThan(3);
    for (const text of stored) expect(text).not.toContain(TOKEN);
    // The refusal of the token itself was said once, and says what to do.
    expect(notices().filter((notice) => notice.body.includes("từ chối token"))).toHaveLength(1);
  });

  it("waits until GitHub takes requests again when it limits the rate, without calling it a failure", async () => {
    await remindOnLabel();
    const reset = Math.floor((clock + 60 * 60_000) / 1000);
    answer = () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    await polling.pollDue();
    const state = getSignalPollState(services.runtime.db, "github.com/codertocat/hello-world");
    expect(state).toMatchObject({ failures: 0, nextPollAt: new Date(reset * 1000).toISOString() });
    later(30 * 60_000);
    await polling.pollDue();
    expect(calls).toHaveLength(1);
    expect(notices()).toEqual([]);
  });

  it("says so once when GitHub keeps failing for another reason, after a few tries", async () => {
    await remindOnLabel();
    answer = () => new Response("{}", { status: 502 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await polling.pollDue();
      later(MAX_WAIT);
    }
    expect(calls).toHaveLength(5);
    const told = notices();
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toContain("sau 3 lần thử");
    expect(told[0]?.body).toContain("502");
  });

  it("says a refusal at once even after other failures, and once more only after the repository has answered", async () => {
    await remindOnLabel();
    answer = () => new Response("{}", { status: 502 });
    await polling.pollDue();
    later(MAX_WAIT);
    answer = () => new Response("{}", { status: 404 });
    await polling.pollDue();
    expect(notices().map((notice) => notice.body.includes("repository riêng tư"))).toEqual([true]);

    // It answers, then refuses again: a new run of failures, told again.
    later(MAX_WAIT);
    answer = () => listing(["100"]);
    await polling.pollDue();
    later(MAX_WAIT);
    answer = () => new Response("{}", { status: 404 });
    await polling.pollDue();
    expect(notices()).toHaveLength(2);
  });
});

