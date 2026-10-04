import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import { FakePiAdapter, type WorkerBrief } from "@clarkcant/pi-adapter";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import { BUNDLE_DATA_HEADER, BUNDLE_LIMITS, READ_CONTEXT_TOOL, contextBundlesFor, createContextBundles } from "../src/context-bundle.ts";
import { deleteMemory, rememberMemory } from "../src/memory.ts";
import { createModelTurn } from "../src/model-turn.ts";
import { seedMessage } from "./conversation-message-seed.ts";

/**
 * Shared retrieval for background runs.
 *
 * What has to hold: runs started from the same request at the same point share one pass; a bundle is references only
 * and is read for the principal it was made for and nobody else; a reference whose row is gone or changed is dropped,
 * not sent stale, even halfway through a run; reads are on demand and bounded; and the worker gets it as data, with no
 * root or capability added and only the read-only `read_context` tool.
 */

const PRINCIPAL = "prin_owner";
const STRANGER = "prin_other";
const CONVERSATION = "conv_one";
const AT = "2026-10-04T08:00:00.000Z";

let dir: string;
let db: Database;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-context-bundle-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  counter = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function remember(text: string, principalId = PRINCIPAL): string {
  const outcome = rememberMemory(
    {
      db,
      now: () => AT,
      newId: (prefix) => {
        counter += 1;
        return `${prefix}_${String(counter)}`;
      },
    },
    { principalId, conversationId: CONVERSATION, kind: "decision", scope: "node", text },
  );
  if ("refused" in outcome) throw new Error(outcome.refused);
  return outcome.memoryId;
}

function index(ref: string, text: string, principalId = PRINCIPAL): void {
  seedMessage(db, { messageId: ref, role: "user", text, principalId, conversationId: CONVERSATION, createdAt: AT });
}

const QUERY = "tổng hợp quyết định về cơ sở dữ liệu của dự án";

describe("a context bundle", () => {
  it("is built once for runs started from the same request, and holds references only", async () => {
    remember("Dự án dùng SQLite làm cơ sở dữ liệu.");
    index("msg_1", "Mình chốt cơ sở dữ liệu của dự án là SQLite.");
    const bundles = createContextBundles({ db });

    const [first, second] = await Promise.all([
      bundles.bundleFor({ principalId: PRINCIPAL, conversationId: CONVERSATION, query: QUERY }),
      bundles.bundleFor({ principalId: PRINCIPAL, conversationId: CONVERSATION, query: QUERY }),
    ]);
    expect(second).toBe(first);
    expect(bundles.stats()).toMatchObject({ built: 1, reused: 1 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.refs.map((ref) => ref.ref).sort()).toEqual(["memory:mem_1", "message:msg_1"]);
    // Nothing in a bundle is authority: references and digests, no roots, no capabilities, no tools.
    expect(Object.keys(first).sort()).toEqual(["bundleId", "conversationId", "createdAtMs", "principalId", "refs", "sourceRevision"]);

    const reader = bundles.reader(first, PRINCIPAL);
    expect(reader.items).toBe(2);
    // The list is previews by label; nothing is read in full until it is asked for.
    const listed = reader.answer({});
    expect(listed.kind).toBe("done");
    expect(listed.text.split("\n")[0]).toBe(BUNDLE_DATA_HEADER);
    expect(listed.text).toContain("c1 · ghi nhớ (decision): Dự án dùng SQLite làm cơ sở dữ liệu.");
    expect(listed.text).toContain("c2 · Người dùng: Mình chốt cơ sở dữ liệu của dự án là SQLite.");
    expect(reader.answer({ item: "c2" })).toEqual({
      kind: "done",
      text: `${BUNDLE_DATA_HEADER}\nc2 · Người dùng: Mình chốt cơ sở dữ liệu của dự án là SQLite.`,
    });
    expect(reader.answer({ item: "c9" }).kind).toBe("refused");
  });

  it("is one per database, shared by every caller of it", () => {
    expect(contextBundlesFor(db)).toBe(contextBundlesFor(db));
  });

  it("previews a long item in the list, reads it whole on request, and bounds how often one worker reads", async () => {
    const long = `Dự án dùng SQLite làm cơ sở dữ liệu. ${"chi tiết ".repeat(200)}`.trim();
    remember(long);
    const bundles = createContextBundles({ db });
    const reader = bundles.reader(
      await bundles.bundleFor({ principalId: PRINCIPAL, conversationId: CONVERSATION, query: QUERY }),
      PRINCIPAL,
    );
    const listed = reader.answer({});
    expect(listed.text.length).toBeLessThan(BUNDLE_DATA_HEADER.length + 40 + BUNDLE_LIMITS.previewMax);
    expect(listed.text.endsWith("…")).toBe(true);
    expect(reader.answer({ item: "c1" }).text).toContain(long);
    // Two read so far; the last allowed read is the limit-th.
    for (let read = 3; read < BUNDLE_LIMITS.maxReads; read += 1) reader.answer({});
    expect(reader.answer({}).kind).toBe("done");
    expect(reader.answer({}).kind).toBe("refused");
  });

  it("is never another person's, and reads nothing for anyone else", async () => {
    remember("Dự án dùng PostgreSQL làm cơ sở dữ liệu.", STRANGER);
    index("msg_s", "Cơ sở dữ liệu của dự án là PostgreSQL.", STRANGER);
    remember("Dự án dùng SQLite làm cơ sở dữ liệu.");
    const bundles = createContextBundles({ db });

    const mine = await bundles.bundleFor({ principalId: PRINCIPAL, conversationId: CONVERSATION, query: QUERY });
    const theirs = await bundles.bundleFor({ principalId: STRANGER, conversationId: CONVERSATION, query: QUERY });
    expect(theirs).not.toBe(mine);
    expect(bundles.reader(mine, PRINCIPAL).answer({}).text).not.toContain("PostgreSQL");
    const stranger = bundles.reader(mine, STRANGER);
    expect(stranger.items).toBe(0);
    expect(stranger.answer({})).toEqual({ kind: "done", text: `${BUNDLE_DATA_HEADER}\n(không còn mục nào)` });
    expect(stranger.answer({ item: "c1" }).kind).toBe("refused");
  });

  it("drops a reference whose row was deleted or changed since the bundle was made", async () => {
    const memoryId = remember("Dự án dùng SQLite làm cơ sở dữ liệu.");
    index("msg_1", "Mình chốt cơ sở dữ liệu của dự án là SQLite.");
    const bundles = createContextBundles({ db });
    const bundle = await bundles.bundleFor({ principalId: PRINCIPAL, conversationId: CONVERSATION, query: QUERY });

    const reader = bundles.reader(bundle, PRINCIPAL);
    expect(reader.answer({ item: "c1" }).kind).toBe("done");

    // Halfway through the run: what changed since is not read back.
    deleteMemory({ db, now: () => AT, newId: () => "unused" }, PRINCIPAL, memoryId);
    index("msg_1", "Đổi ý: cơ sở dữ liệu của dự án là Postgres.");
    expect(reader.answer({ item: "c1" }).kind).toBe("refused");
    expect(reader.answer({})).toEqual({ kind: "done", text: `${BUNDLE_DATA_HEADER}\n(không còn mục nào)` });
    expect(bundles.stats().dropped).toBe(2);
  });

  it("expires, so a later request retrieves again", async () => {
    remember("Dự án dùng SQLite làm cơ sở dữ liệu.");
    let clock = 0;
    const bundles = createContextBundles({ db, now: () => clock });
    const first = await bundles.bundleFor({ principalId: PRINCIPAL, conversationId: CONVERSATION, query: QUERY });
    clock += BUNDLE_LIMITS.ttlMs;
    const second = await bundles.bundleFor({ principalId: PRINCIPAL, conversationId: CONVERSATION, query: QUERY });
    expect(second).not.toBe(first);
    expect(bundles.stats()).toMatchObject({ built: 2, reused: 0, held: 1 });
  });
});

describe("a background run", () => {
  const OWNER: Principal = { principalId: PRINCIPAL as Principal["principalId"], kind: "user", nodeId: "n1" as Principal["nodeId"] };
  const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;

  class BriefRecordingAdapter extends FakePiAdapter {
    readonly briefs: WorkerBrief[] = [];
    // Recorded here because a background session is disposed once it answers, and the fake forgets it then.
    readonly prompts: string[] = [];
    override async prompt(sessionId: string, text: string): Promise<void> {
      this.prompts.push(text);
      await super.prompt(sessionId, text);
    }
    override async createWorkerSession(brief: WorkerBrief): ReturnType<FakePiAdapter["createWorkerSession"]> {
      this.briefs.push(brief);
      return await super.createWorkerSession(brief);
    }
  }

  it("is given the list of what was retrieved as data after the caller's own, and only a tool to read it", async () => {
    remember("Dự án dùng SQLite làm cơ sở dữ liệu.");
    const bundles = createContextBundles({ db });
    const adapter = new BriefRecordingAdapter({ script: ["xong"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      backgroundContext: async ({ conversationId, principalId, text }) =>
        bundles.reader(await bundles.bundleFor({ principalId, conversationId, query: text }), principalId),
    });

    await turn!.runInBackground({
      conversationId: CONVERSATION as ConversationId,
      principal: OWNER,
      text: QUERY,
      data: "[Dữ liệu từ thẻ]\nhàng 1",
    });
    const prompt = adapter.prompts[0] ?? "";
    expect(prompt.startsWith(QUERY)).toBe(true);
    expect(prompt.indexOf("[Dữ liệu từ thẻ]")).toBeLessThan(prompt.indexOf("[Ngữ cảnh đã truy xuất"));
    expect(prompt).toContain("c1 · ghi nhớ (decision): Dự án dùng SQLite làm cơ sở dữ liệu.");
    // The goal is the request; the worker gains no folder or capability, and its one tool only reads this bundle.
    expect(adapter.briefs[0]).toMatchObject({ goal: QUERY, projectRoots: [], allowedCapabilityRefs: [] });
    const tools = adapter.briefs[0]?.customTools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([READ_CONTEXT_TOOL]);
    await expect(tools[0]!.execute({ item: "c1" })).resolves.toEqual({
      text: `${BUNDLE_DATA_HEADER}\nc1 · ghi nhớ (decision): Dự án dùng SQLite làm cơ sở dữ liệu.`,
    });
    await expect(tools[0]!.execute({ item: "c7" })).rejects.toThrow(/c7/);
  });

  it("is given no tool when nothing was retrieved", async () => {
    const bundles = createContextBundles({ db });
    const adapter = new BriefRecordingAdapter({ script: ["xong"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      backgroundContext: async ({ conversationId, principalId, text }) =>
        bundles.reader(await bundles.bundleFor({ principalId, conversationId, query: text }), principalId),
    });
    await turn!.runInBackground({ conversationId: CONVERSATION as ConversationId, principal: OWNER, text: QUERY });
    expect(adapter.prompts[0]).toBe(QUERY);
    expect(adapter.briefs[0]?.customTools).toBeUndefined();
  });

  it("still runs when retrieval fails", async () => {
    const adapter = new BriefRecordingAdapter({ script: ["xong"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      backgroundContext: async () => {
        throw new Error("index unavailable");
      },
    });
    await expect(
      turn!.runInBackground({ conversationId: CONVERSATION as ConversationId, principal: OWNER, text: QUERY }),
    ).resolves.toBe("xong");
    expect(adapter.prompts[0]).toBe(QUERY);
  });
});
