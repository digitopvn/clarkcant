import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";
import { indexHistory, migrate, openDatabase, type Database } from "@clarkcant/storage";

import {
  contextDeciderFromEnv,
  contextPlannerFromEnv,
  contextTerms,
  earlierMessagesFor,
  focusedMemoryBrief,
  legacyRecap,
  planRecap,
  recapWindow,
  relevance,
  rerankTop,
  type RecapMessage,
} from "../src/context-planner.ts";
import { type DecideDeps, decideContextFocus } from "../src/jev-decider.ts";
import { type JevConfig, type JevTransport, createJevBudget } from "../src/jev-selector.ts";
import { deleteMemory, memoryBrief, rememberMemory, type MemoryDeps } from "../src/memory.ts";
import { createModelTurn } from "../src/model-turn.ts";

/**
 * The context planner chooses what a turn is told from what the node already keeps.
 *
 * What has to hold: a record the turn may not see is never a candidate; what matches the turn comes first within the
 * same caps; nothing matching means the old brief byte for byte; a deletion is gone on the next turn; and the selector
 * can only reorder.
 */

const PRINCIPAL = "prin_owner";
const STRANGER = "prin_other";
const CONVERSATION = "conv_one";
const OTHER_CONVERSATION = "conv_two";
const AT = "2026-10-04T08:00:00.000Z";

let dir: string;
let db: Database;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-context-planner-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  counter = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function memoryDeps(): MemoryDeps {
  return {
    db,
    // Strictly increasing, so newest-first is a stated order rather than an accident of insertion.
    now: () => new Date(Date.parse(AT) + counter * 1000).toISOString(),
    newId: (prefix: string) => {
      counter += 1;
      return `${prefix}_${String(counter).padStart(3, "0")}`;
    },
  };
}

function remember(text: string, overrides: { principalId?: string; conversationId?: string; scope?: "node" | "conversation" } = {}): string {
  const outcome = rememberMemory(memoryDeps(), {
    principalId: overrides.principalId ?? PRINCIPAL,
    conversationId: overrides.conversationId ?? CONVERSATION,
    kind: "decision",
    scope: overrides.scope ?? "node",
    text,
  });
  if ("refused" in outcome) throw new Error(outcome.refused);
  return outcome.memoryId;
}

function config(overrides: Partial<JevConfig> = {}): JevConfig {
  return {
    enabled: true,
    localOnly: false,
    apiKey: "sk-test-not-a-real-key",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    endpointRefusal: undefined,
    model: "jev-1.13.0",
    timeoutMs: 4000,
    maxCallsPerTurn: 2,
    policyVersion: "2026-09-17",
    confidenceFloor: 0.85,
    marginFloor: 0.2,
    noulOnFloor: 0.85,
    noulOffFloor: 0.15,
    ...overrides,
  };
}

/** A distribution over every offered option, nearly all of it on `choice`. */
function distribution(options: readonly string[], choice: string): Record<string, number> {
  const all = [...new Set([...options, "none", choice])];
  const rest = 0.03 / (all.length - 1);
  return Object.fromEntries(all.map((option) => [option, option === choice ? 0.97 : rest]));
}

/** A selector that always picks `choice`, and remembers what it was offered. */
function selector(choice: string): { deps: DecideDeps; calls: () => number; offered: () => Record<string, unknown>[] } {
  let calls = 0;
  const offered: Record<string, unknown>[] = [];
  const transport: JevTransport = async (request) => {
    calls += 1;
    const body = request.body as { questions: Record<string, { criteria?: Record<string, unknown> }> };
    const id = Object.keys(body.questions)[0] ?? "q";
    offered.push(body.questions[id]?.criteria ?? {});
    return {
      status: 200,
      body: {
        model: "jev-1.13.0",
        answers: { [id]: { type: "choice", choice, probabilities: distribution(Object.keys(body.questions[id]?.criteria ?? {}), choice) } },
      },
    };
  };
  const conf = config();
  return {
    deps: { jev: { config: conf, transport }, budget: () => createJevBudget(conf) },
    calls: () => calls,
    offered: () => offered,
  };
}

describe("query terms", () => {
  it("folds Vietnamese diacritics and drops words that carry no subject", () => {
    expect([...contextTerms("Dự án Clark dùng PostgreSQL hay là SQLite?")]).toEqual(["du", "an", "clark", "dung", "postgresql", "sqlite"]);
    expect(contextTerms("có không là gì").size).toBe(0);
  });

  it("needs two shared terms before calling a long question relevant", () => {
    const query = contextTerms("chọn cơ sở dữ liệu cho dự án clark");
    expect(relevance(query, "Clark là tên trợ lý").relevant).toBe(false);
    expect(relevance(query, "Dự án Clark dùng SQLite làm cơ sở dữ liệu").relevant).toBe(true);
  });
});

describe("the memory brief for one turn", () => {
  it("is the unfocused brief byte for byte when nothing matches the turn", async () => {
    remember("Người dùng thích câu trả lời ngắn.");
    remember("Dự án Clark dùng SQLite.");
    const before = memoryBrief(memoryDeps(), { principalId: PRINCIPAL, conversationId: CONVERSATION });
    const planned = await focusedMemoryBrief({ db }, { principalId: PRINCIPAL, conversationId: CONVERSATION, query: "thời tiết hôm nay" });
    expect(planned.text).toBe(before);
    expect(planned.plan.focused).toBe(false);
  });

  it("puts what matches the turn first, ahead of newer records", async () => {
    remember("Dự án Clark dùng SQLite làm cơ sở dữ liệu.");
    for (let index = 0; index < 14; index += 1) remember(`Ghi chú không liên quan số ${String(index)}.`);
    const unfocused = memoryBrief(memoryDeps(), { principalId: PRINCIPAL, conversationId: CONVERSATION });
    // Fourteen newer records push it out of the newest-twelve brief.
    expect(unfocused).not.toContain("SQLite");

    const planned = await focusedMemoryBrief(
      { db },
      { principalId: PRINCIPAL, conversationId: CONVERSATION, query: "dự án clark dùng cơ sở dữ liệu nào?" },
    );
    const lines = planned.text.split("\n");
    expect(lines[0]).toBe("[Điều đã ghi nhớ cho người dùng này]");
    expect(lines[1]).toContain("SQLite");
    // Same caps as before: twelve rows, and the rest is counted rather than dropped silently.
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(12);
    expect(planned.text).toContain("[còn 3 điều đã ghi nhớ khác]");
    expect(planned.plan.focused).toBe(true);
  });

  it("stops sending a deleted record on the very next turn", async () => {
    const id = remember("Dự án Clark dùng SQLite làm cơ sở dữ liệu.");
    const query = "clark dùng cơ sở dữ liệu nào";
    expect((await focusedMemoryBrief({ db }, { principalId: PRINCIPAL, conversationId: CONVERSATION, query })).text).toContain("SQLite");
    expect(deleteMemory(memoryDeps(), PRINCIPAL, id)).toBe(true);
    expect((await focusedMemoryBrief({ db }, { principalId: PRINCIPAL, conversationId: CONVERSATION, query })).text).toBe("");
  });

  it("never offers another person's record or another conversation's, however well it matches", async () => {
    remember("Dự án Clark dùng PostgreSQL làm cơ sở dữ liệu.", { principalId: STRANGER });
    remember("Dự án Clark dùng MySQL làm cơ sở dữ liệu.", { scope: "conversation", conversationId: OTHER_CONVERSATION });
    remember("Người dùng thích câu trả lời ngắn.");
    const planned = await focusedMemoryBrief(
      { db },
      { principalId: PRINCIPAL, conversationId: CONVERSATION, query: "dự án clark dùng cơ sở dữ liệu nào" },
    );
    expect(planned.text).not.toContain("PostgreSQL");
    expect(planned.text).not.toContain("MySQL");
    expect(planned.text).toContain("câu trả lời ngắn");
  });

  it("lets the selector reorder a close top-K, and nothing more", async () => {
    remember("Dự án Clark chọn SQLite cho cơ sở dữ liệu cục bộ.");
    remember("Dự án Clark chọn Postgres cho cơ sở dữ liệu máy chủ.");
    const jev = selector("item:1");
    const planned = await focusedMemoryBrief(
      { db, decider: jev.deps },
      { principalId: PRINCIPAL, conversationId: CONVERSATION, query: "dự án clark chọn cơ sở dữ liệu" },
    );
    expect(jev.calls()).toBe(1);
    expect(planned.plan.reranked).toBe(true);
    const lines = planned.text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(2);
    // Newest first on a tie; the selector moved the older one ahead without dropping the other.
    expect(lines[0]).toContain("SQLite");
    expect(lines[1]).toContain("Postgres");
    // Offered by position, redacted and clipped: ids never leave the node.
    expect(Object.keys(jev.offered()[0] ?? {})).toEqual(expect.arrayContaining(["item:0", "item:1"]));
  });
});

describe("the selector is asked only when the ranking is close", () => {
  it("answers with the candidate it chose, by id", async () => {
    const jev = selector("item:1");
    const decision = await decideContextFocus(jev.deps, {
      query: "q",
      candidates: [
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ],
    });
    expect(decision).toMatchObject({ status: "chosen", id: "b" });
  });

  it("does not ask when the top candidate is clearly ahead", async () => {
    const jev = selector("item:1");
    const result = await rerankTop(
      [
        { id: "a", text: "a", score: 1 },
        { id: "b", text: "b", score: 0.2 },
      ],
      "q",
      jev.deps,
    );
    expect(jev.calls()).toBe(0);
    expect(result.ordered.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("keeps the order when the selector chooses none", async () => {
    const jev = selector("none");
    const result = await rerankTop(
      [
        { id: "a", text: "a", score: 1 },
        { id: "b", text: "b", score: 1 },
      ],
      "q",
      jev.deps,
    );
    expect(jev.calls()).toBe(1);
    expect(result).toEqual({ ordered: [expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "b" })], reranked: false });
  });
});

describe("the recap for a fresh session", () => {
  const thread: RecapMessage[] = Array.from({ length: 14 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: index === 4 ? "Mình chốt dùng SQLite cho cơ sở dữ liệu của dự án Clark nhé." : `Tin nhắn số ${String(index)} ${"x".repeat(300)}`,
    messageId: `msg_${String(index)}`,
  }));

  it("is the fixed newest-twelve recap when nothing matches", () => {
    const planned = planRecap({ messages: thread, query: "thời tiết hôm nay", earlier: [] });
    expect(planned.text).toBe(legacyRecap(thread));
    expect(planned.plan.focused).toBe(false);
  });

  it("keeps the newest two whole, shortens unrelated older lines and keeps matching ones whole", () => {
    const planned = planRecap({ messages: thread, query: "cơ sở dữ liệu của dự án clark là gì", earlier: [], total: 14 });
    const lines = planned.text.split("\n");
    expect(lines[0]).toBe("Mạch hội thoại trước đó, để bạn tiếp tục đúng việc đang làm:");
    expect(planned.text).toContain("Mình chốt dùng SQLite cho cơ sở dữ liệu của dự án Clark nhé.");
    const last = lines.filter((line) => line.startsWith("Người dùng:") || line.startsWith("Trợ lý:")).slice(-2);
    for (const line of last) expect(line.length).toBeGreaterThan(300);
    const shortened = lines.find((line) => line.includes("Tin nhắn số 2 "));
    expect(shortened?.endsWith("…")).toBe(true);
    expect(shortened!.length).toBeLessThan(200);
    expect(planned.text).toContain("[Còn 2 tin cũ hơn không nhắc lại ở đây; dùng search_history nếu cần đọc lại.]");
  });

  it("adds matching earlier messages under their own heading, before the newest ones", () => {
    const planned = planRecap({
      messages: thread.slice(-12),
      query: "chốt cơ sở dữ liệu nào",
      earlier: [{ id: "message:old", text: "Đã chốt cơ sở dữ liệu là SQLite.", score: 3 }],
    });
    expect(planned.text.indexOf("[Đoạn cũ hơn")).toBeLessThan(planned.text.indexOf("[Gần nhất:]"));
    expect(planned.text).toContain("- Đã chốt cơ sở dữ liệu là SQLite.");
  });
});

describe("earlier messages of this conversation", () => {
  function index(ref: string, text: string, overrides: { principalId?: string; conversationId?: string } = {}): void {
    indexHistory(db, {
      source: "message",
      ref,
      text,
      principalId: overrides.principalId ?? PRINCIPAL,
      conversationId: overrides.conversationId ?? CONVERSATION,
      createdAt: AT,
    });
  }

  it("finds only this person's messages in this conversation, outside the recap's window", async () => {
    index("msg_old", "Mình chốt dùng SQLite cho cơ sở dữ liệu.");
    index("msg_recent", "Cơ sở dữ liệu SQLite đã được tạo.");
    index("msg_other_conv", "Cơ sở dữ liệu bên kia là MySQL.", { conversationId: OTHER_CONVERSATION });
    index("msg_stranger", "Cơ sở dữ liệu của tôi là PostgreSQL.", { principalId: STRANGER });
    index("msg_noise", "Hôm nay trời đẹp.");

    const { earlier } = await earlierMessagesFor(
      { db },
      { principalId: PRINCIPAL, conversationId: CONVERSATION, query: "cơ sở dữ liệu chốt là gì", exclude: new Set(["msg_recent"]) },
    );
    expect(earlier.map((entry) => entry.id)).toEqual(["message:msg_old"]);
  });

  it("is searched past the recap's window, not past everything read", () => {
    // Forty read, twelve repeated: the twenty-eight in between are not in the recap and must stay findable.
    const read = Array.from({ length: 40 }, (_, index) => index);
    expect(recapWindow(read)).toEqual(read.slice(28));
  });
});

describe("environment switches", () => {
  it("is on unless turned off, and asks no selector unless one is opted in", () => {
    expect(contextPlannerFromEnv({})).toBe("on");
    expect(contextPlannerFromEnv({ CLARKCANT_CONTEXT_PLANNER: "OFF" })).toBe("off");
    expect(contextDeciderFromEnv({})).toBe("rank");
    expect(contextDeciderFromEnv({ CLARKCANT_CONTEXT_DECIDER: "jev" })).toBe("jev");
    expect(contextDeciderFromEnv({ CLARKCANT_CONTEXT_DECIDER: "jevv" })).toBe("rank");
  });
});

describe("the model turn hands the turn's text to the planner", () => {
  const PRINCIPAL_: Principal = { principalId: "p_owner" as Principal["principalId"], kind: "user", nodeId: "n1" as Principal["nodeId"] };
  const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;

  it("passes the message to the memory brief and the recap planner, and falls back when the planner fails", async () => {
    const adapter = new FakePiAdapter({ script: ["một", "hai"] });
    const seen: string[] = [];
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      history: async () => [{ role: "user", text: "trước đó" }],
      recapPlanner: async () => {
        throw new Error("planner broke");
      },
      memoryBrief: async (_conversationId, query) => {
        seen.push(query);
        return `[Điều đã ghi nhớ cho người dùng này]\n- (decision) về ${query}`;
      },
    });
    await turn!.answer({ conversationId: "c1" as ConversationId, principal: PRINCIPAL_, text: "cơ sở dữ liệu", messageId: "m1" });
    expect(seen).toEqual(["cơ sở dữ liệu"]);
    const prompt = adapter.promptsFor("fake-session-1")[0] ?? "";
    // The planner's failure is the fixed recap, not a failed turn.
    expect(prompt).toContain("Mạch hội thoại trước đó");
    expect(prompt).toContain("Người dùng: trước đó");
    expect(prompt).toContain("- (decision) về cơ sở dữ liệu");
  });
});
