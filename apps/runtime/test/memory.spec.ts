import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY_BRIEF_MAX_CHARS, MEMORY_BRIEF_MAX_ROWS } from "@clarkcant/contracts";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import {
  deleteMemory,
  listMemories,
  memoryBrief,
  memoryCounts,
  rememberMemory,
  type MemoryDeps,
} from "../src/memory.ts";

/**
 * What the node remembers, and what it puts in front of the model.
 *
 * The properties worth having are about restraint. Nothing is written before it has been redacted, because a
 * secret in this table is a secret in every later prompt. The brief is capped and says so, because a brief that
 * silently dropped half of what was remembered would let a model conclude nothing else was known. And a deletion
 * takes effect on the next turn, because that is what makes the Memory tab's promise true rather than decorative.
 */

const PRINCIPAL = "prin_test";
const CONVERSATION = "conv_one";
const OTHER_CONVERSATION = "conv_two";
const NOW = "2026-09-19T12:00:00.000Z";

let db: Database;
let counter = 0;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cc-memory-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  counter = 0;
});

afterEach(() => {
  db.close();
});

function deps(): MemoryDeps {
  return {
    db,
    now: () => NOW,
    newId: (prefix: string) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

function remember(overrides: Partial<Parameters<typeof rememberMemory>[1]> = {}): ReturnType<typeof rememberMemory> {
  return rememberMemory(deps(), {
    principalId: PRINCIPAL,
    conversationId: CONVERSATION,
    kind: "decision",
    scope: "conversation",
    text: "Dùng SQLite chứ không phải Postgres cho node cục bộ.",
    ...overrides,
  });
}

describe("writing something down", () => {
  it("a secret is redacted before it is written down", () => {
    // Assembled rather than written as one literal. A key-shaped string sitting in a repository is exactly what a
    // secret scanner exists to find, and a test fixture is not a good enough reason to teach it to look away.
    const fakeKey = `sk-live-${"x".repeat(24)}`;
    const written = remember({ text: `Khoá API là ${fakeKey}` });
    expect("refused" in written).toBe(false);
    const text = "refused" in written ? "" : written.text;
    expect(text).not.toContain(fakeKey);
  });

  it("a note too long to be a memory is refused, and the refusal says the limit", () => {
    // Prose rather than one long token: a 2000-character alphanumeric run is what a secret looks like, and it
    // would be redacted down to something short enough to store - which is the redaction working, not the cap
    // failing.
    const refused = remember({ text: "điều cần nhớ ".repeat(200) });
    expect("refused" in refused).toBe(true);
    expect("refused" in refused ? refused.refused : "").toContain("2000");
  });

  it("an empty note is refused rather than stored as nothing", () => {
    const refused = remember({ text: "   " });
    expect("refused" in refused).toBe(true);
  });

  it("what was written is what is listed, newest first", () => {
    remember({ text: "Điều thứ nhất" });
    remember({ text: "Điều thứ hai" });

    const listed = listMemories(deps(), PRINCIPAL);
    expect(listed).toHaveLength(2);
    expect(listed[0]?.text).toBe("Điều thứ hai");
    expect(listed[0]?.sourceConversationId).toBe(CONVERSATION);
  });

  it("counts are per kind, so a screen can say how much there is", () => {
    remember({ text: "một", kind: "preference", scope: "node" });
    remember({ text: "hai", kind: "decision" });
    remember({ text: "ba", kind: "decision" });

    expect(memoryCounts(deps(), PRINCIPAL)).toEqual({ preference: 1, "project-fact": 0, decision: 2 });
  });
});

describe("the brief for one turn", () => {
  it("says nothing at all when nothing is remembered", () => {
    expect(memoryBrief(deps(), { principalId: PRINCIPAL, conversationId: CONVERSATION })).toBe("");
  });

  it("names the kind of each thing it carries, under a heading", () => {
    remember({ text: "Người dùng thích câu trả lời ngắn.", kind: "preference", scope: "node" });

    const brief = memoryBrief(deps(), { principalId: PRINCIPAL, conversationId: CONVERSATION });
    expect(brief).toContain("[Điều đã ghi nhớ cho người dùng này]");
    expect(brief).toContain("- (preference) Người dùng thích câu trả lời ngắn.");
  });

  it("carries this conversation's decisions and the node's own records, but not another conversation's", () => {
    remember({ text: "Quyết định của phiên này." });
    remember({ text: "Quyết định của phiên khác.", conversationId: OTHER_CONVERSATION });
    remember({ text: "Sở thích chung.", kind: "preference", scope: "node" });

    const brief = memoryBrief(deps(), { principalId: PRINCIPAL, conversationId: CONVERSATION });
    expect(brief).toContain("Quyết định của phiên này.");
    expect(brief).toContain("Sở thích chung.");
    expect(brief).not.toContain("Quyết định của phiên khác.");
  });

  it("is capped, and says how much was left out rather than dropping it quietly", () => {
    for (let index = 0; index < MEMORY_BRIEF_MAX_ROWS + 3; index += 1) {
      remember({ text: `Điều số ${index}`, kind: "preference", scope: "node" });
    }

    const brief = memoryBrief(deps(), { principalId: PRINCIPAL, conversationId: CONVERSATION });
    const lines = brief.split("\n").filter((line) => line.startsWith("- ("));
    expect(lines).toHaveLength(MEMORY_BRIEF_MAX_ROWS);
    expect(brief).toContain("[còn 3 điều đã ghi nhớ khác]");
    expect(brief.length).toBeLessThanOrEqual(MEMORY_BRIEF_MAX_CHARS + 200);
  });

  it("a record that is deleted is gone from the next turn's brief", () => {
    const written = remember({ text: "Điều sẽ bị xoá." });
    const id = "refused" in written ? "" : written.memoryId;

    expect(memoryBrief(deps(), { principalId: PRINCIPAL, conversationId: CONVERSATION })).toContain("Điều sẽ bị xoá.");
    expect(deleteMemory(deps(), PRINCIPAL, id)).toBe(true);
    expect(memoryBrief(deps(), { principalId: PRINCIPAL, conversationId: CONVERSATION })).toBe("");
  });

  it("deleting somebody else's record does nothing", () => {
    const written = remember({ text: "Điều của tôi." });
    const id = "refused" in written ? "" : written.memoryId;

    expect(deleteMemory(deps(), "prin_other", id)).toBe(false);
    expect(listMemories(deps(), PRINCIPAL)).toHaveLength(1);
  });
});
