import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type MessageRecord } from "@clarkcant/contracts";
import { appendMessage, migrate, openDatabase, type Database } from "@clarkcant/storage";

import {
  ensureSessionsDirectory,
  registerSessionFile,
  type SessionStoreDeps,
  sessionsDirectory,
} from "../src/session-store.ts";
import {
  type SessionSearchDeps,
  createSearchHistoryTool,
  indexMessages,
  ingestSessionEntries,
  searchSessions,
  textOfSessionEntry,
} from "../src/session-search.ts";
import { SEARCH_TOTAL_BUDGET_MS } from "../src/jev-decider.ts";
import type { JevConfig, JevTransport } from "../src/jev-selector.ts";
import { parseTemporal, stripDiacritics } from "../src/temporal-parse.ts";

/**
 * Retrieval over history (Phase 8).
 *
 * The tests fall into three groups, and the last one is the one that matters for the plan: a
 * labelled corpus of thirty Vietnamese and English queries, scored for whether the top result is the
 * message a human would have chosen. Everything above it exists to make that score trustworthy —
 * scope, windows and syntax safety.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;
const TZ = "Asia/Saigon";
const PRINCIPAL = "prin_owner";

let dir: string;
let db: Database;
let search: SessionSearchDeps;

function userMessage(text: string, id: string, at: string): MessageRecord {
  return {
    messageId: id as never,
    conversationId: "conv_1" as never,
    role: "user",
    blocks: [{ type: "text", format: "plain", content: text, streaming: false }],
    authorNodeId: "node_local" as never,
    createdAt: at as never,
    delivery: "accepted",
  };
}

/** Write a message the way the gateway does: append, then index. */
function seed(text: string, id: string, at: string, conversationId = "conv_1"): void {
  const message = userMessage(text, id, at);
  appendMessage(db, { ...message, conversationId: conversationId as never }, 0);
  indexMessages(search, { conversationId, messages: [{ ...message, conversationId: conversationId as never }], at: at as never });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-search-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES ('conv_1', NULL, 'node_local', ?, ?)",
  ).run(AT, AT);
  db.prepare(
    "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES ('conv_other', NULL, 'node_local', ?, ?)",
  ).run(AT, AT);
  search = { db, nodeId: "node_local", principalId: PRINCIPAL, timezone: TZ, now: () => AT };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("temporal parser", () => {
  const now = new Date("2026-09-17T05:00:00.000Z"); // Thursday, 12:00 in Saigon

  it("resolves Vietnamese phrases with and without diacritics to the same local day", () => {
    const withMarks = parseTemporal("bug login hôm qua", { now, timezone: TZ });
    const without = parseTemporal("bug login hom qua", { now, timezone: TZ });
    expect(withMarks.kind).toBe("range");
    expect(without.kind).toBe("range");
    if (withMarks.kind !== "range" || without.kind !== "range") return;
    // 16 September in Saigon runs from 17:00 UTC on the 15th.
    expect(withMarks.from).toBe("2026-09-15T17:00:00.000Z");
    expect(withMarks.to).toBe("2026-09-16T17:00:00.000Z");
    expect(without.from).toBe(withMarks.from);
  });

  it("removes the time phrase from the searched text", () => {
    const parsed = parseTemporal("bug login hôm qua", { now, timezone: TZ });
    expect(parsed.rest).toBe("bug login");
    expect(parsed.matched).toBe("hôm qua");
  });

  it("covers English, counts, weeks and months", () => {
    const yesterday = parseTemporal("yesterday deploy", { now, timezone: TZ });
    expect(yesterday.kind).toBe("range");

    const threeDays = parseTemporal("3 ngày trước", { now, timezone: TZ });
    expect(threeDays.kind).toBe("range");
    if (threeDays.kind === "range") expect(threeDays.label).toBe("3 ngày trước");

    const lastWeek = parseTemporal("last week", { now, timezone: TZ });
    if (lastWeek.kind === "range") {
      // The week of 7–13 September.
      expect(new Date(lastWeek.from).toISOString()).toBe("2026-09-06T17:00:00.000Z");
    } else {
      throw new Error("expected a week range");
    }

    const lastMonth = parseTemporal("tháng trước", { now, timezone: TZ });
    if (lastMonth.kind === "range") {
      // August in Saigon starts at 17:00 UTC on 31 July and ends at 17:00 UTC on 31 August.
      expect(lastMonth.from).toBe("2026-07-31T17:00:00.000Z");
      expect(lastMonth.to).toBe("2026-08-31T17:00:00.000Z");
    } else {
      throw new Error("expected a month range");
    }

    const twoWeeks = parseTemporal("2 weeks ago", { now, timezone: TZ });
    expect(twoWeeks.kind).toBe("range");
  });

  it("resolves an ISO date as a single local day", () => {
    const parsed = parseTemporal("2026-09-10", { now, timezone: TZ });
    expect(parsed.kind).toBe("range");
    if (parsed.kind !== "range") return;
    expect(parsed.from).toBe("2026-09-09T17:00:00.000Z");
    expect(parsed.to).toBe("2026-09-10T17:00:00.000Z");
  });

  it("says nothing rather than guessing when it does not recognise the phrase", () => {
    const parsed = parseTemporal("sửa lỗi đăng nhập", { now, timezone: TZ });
    expect(parsed.kind).toBe("none");
    expect(parsed.rest).toBe("sửa lỗi đăng nhập");
    expect(stripDiacritics("Đăng nhập")).toBe("Dang nhap");
  });
});

describe("indexing and search", () => {
  it("finds a message by its words, ranked, with a snippet and provenance", async () => {
    seed("Sửa lỗi đăng nhập: token hết hạn không được làm mới", "msg_a", "2026-09-16T02:00:00.000Z");
    seed("Nâng cấp giao diện biểu đồ", "msg_b", "2026-09-16T03:00:00.000Z");

    const outcome = await searchSessions(search, { text: "đăng nhập" });
    expect(outcome.mode).toBe("rank");
    expect(outcome.results[0]?.ref).toBe("msg_a");
    // SQLite highlights per token, so the phrase arrives as two marked words rather than one.
    expect(outcome.results[0]?.snippet).toContain("[đăng]");
    expect(outcome.results[0]?.snippet).toContain("[nhập]");
    expect(outcome.results[0]?.provenance.conversationId).toBe("conv_1");
    expect(outcome.indexSize).toBe(2);
  });

  it("matches text written without diacritics and vice versa", async () => {
    seed("Sửa lỗi đăng nhập", "msg_diacritics", "2026-09-16T02:00:00.000Z");
    expect((await searchSessions(search, { text: "dang nhap" })).results).toHaveLength(1);
    expect((await searchSessions(search, { text: "ĐĂNG NHẬP" })).results).toHaveLength(1);
  });

  it("returns nothing for another principal instead of filtering afterwards", async () => {
    seed("bí mật của người khác", "msg_secret", "2026-09-16T02:00:00.000Z");
    const other = { ...search, principalId: "prin_other" };
    expect((await searchSessions(other, { text: "bí mật" })).results).toHaveLength(0);
    // The index exists; it is simply not this principal's.
    expect((await searchSessions(search, { text: "bí mật" })).results).toHaveLength(1);
  });

  it("narrows by time window and by conversation", async () => {
    seed("deploy lên staging", "msg_recent", "2026-09-16T02:00:00.000Z");
    seed("deploy lên production", "msg_old", "2026-09-01T02:00:00.000Z");
    seed("deploy khác conversation", "msg_other", "2026-09-16T04:00:00.000Z", "conv_other");

    const windowed = await searchSessions(search, { text: "deploy hôm qua" });
    expect(windowed.results.map((hit) => hit.ref).sort()).toEqual(["msg_other", "msg_recent"]);
    expect(windowed.temporal.kind).toBe("range");

    const scoped = await searchSessions(search, { text: "deploy", conversationId: "conv_1" });
    expect(scoped.results.map((hit) => hit.ref).sort()).toEqual(["msg_old", "msg_recent"]);
  });

  it("answers a query that is only a time phrase with the window's contents, newest first", async () => {
    seed("việc hôm qua", "msg_yesterday", "2026-09-16T02:00:00.000Z");
    seed("việc tuần trước", "msg_last_week", "2026-09-09T02:00:00.000Z");

    const outcome = await searchSessions(search, { text: "hôm qua" });
    expect(outcome.results.map((hit) => hit.ref)).toEqual(["msg_yesterday"]);
    expect(outcome.temporal.label).toBe("hôm qua");
  });

  it("treats FTS syntax as words rather than as an expression", async () => {
    seed("login bug", "msg_login", "2026-09-16T02:00:00.000Z");
    // A user typing these characters is not composing a query; a thrown syntax error would be a
    // failure the user cannot act on.
    for (const text of ['NEAR( OR "', "*", "AND OR NOT", '""']) {
      await expect(searchSessions(search, { text })).resolves.toBeDefined();
    }
    expect((await searchSessions(search, { text: "*" })).results).toHaveLength(0);
  });

  it("does not return content that was redacted before it was indexed", async () => {
    const token = `sk${"-live-"}${"c".repeat(20)}`;
    // Redaction runs before indexing: this is what the message holds after the pass.
    seed(`dùng [redacted] để gọi API`, "msg_redacted", "2026-09-16T02:00:00.000Z");
    expect((await searchSessions(search, { text: token })).results).toHaveLength(0);
    expect((await searchSessions(search, { text: "gọi API" })).results).toHaveLength(1);
  });

  it("distinguishes an empty index from no matches", async () => {
    const empty = await searchSessions(search, { text: "bất kỳ" });
    expect(empty.indexSize).toBe(0);
    seed("một điều gì đó", "msg_one", "2026-09-16T02:00:00.000Z");
    const missing = await searchSessions(search, { text: "không có từ này" });
    expect(missing.indexSize).toBe(1);
    expect(missing.results).toHaveLength(0);
  });

  it("reports truncation and pages with offset", async () => {
    for (let index = 0; index < 5; index += 1) {
      seed(`báo cáo tuần ${index}`, `msg_p${index}`, `2026-09-1${index}T02:00:00.000Z`);
    }
    const limited = await searchSessions(search, { text: "báo cáo", limit: 2 });
    expect(limited.results).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });
});

describe("session transcript ingest", () => {
  let sessions: SessionStoreDeps;

  beforeEach(() => {
    ensureSessionsDirectory(dir);
    sessions = { db, nodeId: "node_local", dataDir: dir, now: () => AT };
  });

  it("indexes what a worker did, resumably and without duplicating", async () => {
    const path = join(sessionsDirectory(dir), "work.jsonl");
    const lines = [
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "đã sửa lỗi đăng nhập" }] } },
      { type: "tool_call", command: "pnpm exec vitest run", output: "12 tests passed" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "tiếp tục" }] } },
    ];
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const registered = registerSessionFile(sessions, { sessionId: "sess_work", principalId: PRINCIPAL, path, taskId: "task_1" });
    expect(registered.ok).toBe(true);

    const first = ingestSessionEntries(search, { sessionId: "sess_work", batchSize: 2 });
    if ("error" in first) throw new Error(first.error);
    expect(first.ingested).toBe(2);
    expect(first.nextOffset).toBeGreaterThan(0);

    const second = ingestSessionEntries(search, { sessionId: "sess_work", batchSize: 2 });
    if ("error" in second) throw new Error(second.error);
    expect(second.ingested).toBe(1);

    const third = ingestSessionEntries(search, { sessionId: "sess_work" });
    if ("error" in third) throw new Error(third.error);
    // Nothing left: the cursor is at the end, so a repeat pass is a no-op rather than a duplicate.
    expect(third.ingested).toBe(0);

    const hits = await await searchSessions(search, { text: "đăng nhập", source: "session_entry" });
    expect(hits.results).toHaveLength(1);
    expect(hits.results[0]?.ref).toBe("sess_work:0");
    expect(hits.results[0]?.provenance.taskId).toBe("task_1");

    const toolHit = await searchSessions(search, { text: "vitest passed" });
    expect(toolHit.results.some((hit) => hit.source === "session_entry")).toBe(true);
  });

  it("refuses to ingest another principal's session", async () => {
    const path = join(sessionsDirectory(dir), "other.jsonl");
    writeFileSync(path, `${JSON.stringify({ text: "không phải của bạn" })}\n`);
    registerSessionFile(sessions, { sessionId: "sess_other", principalId: "prin_other", path });

    const outcome = ingestSessionEntries(search, { sessionId: "sess_other" });
    expect("error" in outcome).toBe(true);
    const unknown = ingestSessionEntries(search, { sessionId: "sess_missing" });
    expect("error" in unknown).toBe(true);
  });

  it("extracts prose and commands, and ignores identifiers", () => {
    const text = textOfSessionEntry({
      type: "tool_call",
      toolCallId: "call_0123456789abcdef",
      command: "rg login src/",
      output: "found 3 matches",
      digest: "a".repeat(64),
    });
    expect(text).toContain("rg login src/");
    expect(text).toContain("found 3 matches");
    // An id or a digest in the index would make every query match every entry.
    expect(text).not.toContain("call_0123456789abcdef");
    expect(text).not.toContain("a".repeat(64));
    expect(textOfSessionEntry({ type: "turn_end" })).toBe("");
  });
});

describe("the tool the main model sees", () => {
  it("returns readable context and no ids it could act on", async () => {
    seed("chúng ta đã sửa lỗi đăng nhập ở middleware", "msg_ctx", "2026-09-16T02:00:00.000Z");
    const tool = createSearchHistoryTool(search);
    const result = await tool.execute({ query: "đăng nhập" });
    expect(result.text).toContain("đăng nhập");
    expect(result.text).toContain("conv_1");
    // The snippet is context; the message id is not something the model needs in order to answer.
    expect(result.text).not.toContain("msg_ctx");

    const nothing = await tool.execute({ query: "không tồn tại" });
    expect(nothing.text).toContain("No matches");

    const empty = await tool.execute({ query: "" });
    expect(empty.text).toContain("No query");
  });
});

/* ------------------------------------------------------------------ *
 * Baseline corpus
 * ------------------------------------------------------------------ */

interface CorpusCase {
  query: string;
  /** The message a human would choose, or undefined when the correct answer is "nothing". */
  expected: string | undefined;
  /**
   * Whether the target shares vocabulary with the query.
   *
   * A lexical baseline is only being measured fairly on the cases where it can, in principle,
   * succeed. The `lexical: false` cases are synonyms and cross-language phrasings, and their current
   * failure rate is the number Phase 10 has to move — counting them in the floor would have meant
   * either lowering the floor until it meant nothing or relabelling them until the test passed.
   */
  lexical?: boolean;
}

/** Thirty-one cases the lexical layer should answer, with the words present in the target. */
const LEXICAL_CORPUS: readonly CorpusCase[] = [
  { query: "lỗi đăng nhập", expected: "msg_login" },
  { query: "dang nhap", expected: "msg_login" },
  { query: "token hết hạn", expected: "msg_login" },
  { query: "làm mới token", expected: "msg_login" },
  { query: "biểu đồ doanh thu", expected: "msg_chart" },
  { query: "nhãn trục", expected: "msg_chart" },
  { query: "migration thêm cột", expected: "msg_migration" },
  { query: "chạy migration", expected: "msg_migration" },
  { query: "cuộc họp với khách hàng", expected: "msg_meeting" },
  { query: "lịch tuần sau", expected: "msg_meeting" },
  { query: "nhập ảnh", expected: "msg_image" },
  { query: "sơ đồ kiến trúc", expected: "msg_image" },
  { query: "tối ưu truy vấn chậm", expected: "msg_slow" },
  { query: "bảng events", expected: "msg_slow" },
  { query: "xoay khoá api", expected: "msg_security" },
  { query: "secret trong lịch sử", expected: "msg_security" },
  { query: "deploy lên staging", expected: "msg_deploy" },
  { query: "tag v0.2.0", expected: "msg_deploy" },
  { query: "kiểm thử giao diện", expected: "msg_ui_test" },
  { query: "playwright trên chromium", expected: "msg_ui_test" },
  { query: "login bug", expected: "msg_login_en" },
  { query: "expired token refresh", expected: "msg_login_en" },
  { query: "revenue chart axis", expected: "msg_chart_en" },
  { query: "database migration column", expected: "msg_migration_en" },
  { query: "customer meeting schedule", expected: "msg_meeting_en" },
  { query: "slow query on events table", expected: "msg_slow_en" },
  // The correct answers to these are "nothing", which a retrieval system must also be able to say.
  { query: "hoá đơn điện tử", expected: undefined },
  { query: "kubernetes ingress", expected: undefined },
  { query: "kế hoạch nghỉ phép", expected: undefined },
  { query: "phân tích cảm xúc khách hàng", expected: undefined },
  { query: "webhook thanh toán", expected: undefined },
];

/** The gap: same meaning, different words, and one of them in another language. */
const SEMANTIC_CORPUS: readonly CorpusCase[] = [
  { query: "sửa lỗi không đăng nhập được", expected: "msg_login", lexical: false },
  { query: "di trú cơ sở dữ liệu", expected: "msg_migration", lexical: false },
  { query: "bảo mật và khoá bí mật", expected: "msg_security", lexical: false },
  { query: "security review", expected: "msg_security", lexical: false },
  { query: "revenue chart", expected: "msg_chart", lexical: false },
  { query: "customer meeting", expected: "msg_meeting", lexical: false },
  { query: "architecture image", expected: "msg_image", lexical: false },
  { query: "ui test", expected: "msg_ui_test", lexical: false },
];

const CORPUS: readonly CorpusCase[] = [...LEXICAL_CORPUS, ...SEMANTIC_CORPUS];

function seedCorpus(): void {
  const seeds: [string, string, string][] = [
    ["Sửa lỗi đăng nhập: token hết hạn không được làm mới", "msg_login", "2026-09-16T02:00:00.000Z"],
    ["Biểu đồ doanh thu theo tuần bị thiếu nhãn trục", "msg_chart", "2026-09-15T02:00:00.000Z"],
    ["Chạy migration thêm cột owner_principal_id vào datasets", "msg_migration", "2026-09-14T02:00:00.000Z"],
    ["Cuộc họp với khách hàng về lịch tuần sau", "msg_meeting", "2026-09-13T02:00:00.000Z"],
    ["Nhập ảnh sơ đồ kiến trúc vào máy này", "msg_image", "2026-09-12T02:00:00.000Z"],
    ["Tối ưu truy vấn chậm trên bảng events", "msg_slow", "2026-09-11T02:00:00.000Z"],
    ["Bảo mật: xoay khoá api và kiểm tra secret trong lịch sử", "msg_security", "2026-09-10T02:00:00.000Z"],
    ["deploy lên staging bằng tag v0.2.0", "msg_deploy", "2026-09-09T02:00:00.000Z"],
    ["kiểm thử giao diện bằng Playwright trên Chromium", "msg_ui_test", "2026-09-08T02:00:00.000Z"],
    ["login bug: expired token refresh was not retried", "msg_login_en", "2026-09-07T02:00:00.000Z"],
    ["revenue chart is missing its axis label", "msg_chart_en", "2026-09-06T02:00:00.000Z"],
    ["database migration adds a column to datasets", "msg_migration_en", "2026-09-05T02:00:00.000Z"],
    ["customer meeting to schedule next week", "msg_meeting_en", "2026-09-04T02:00:00.000Z"],
    ["slow query on the events table needs an index", "msg_slow_en", "2026-09-03T02:00:00.000Z"],
  ];
  for (const [text, id, at] of seeds) seed(text, id, at);
}

async function score(cases: readonly CorpusCase[]): Promise<{ acceptable: number; failures: string[] }> {
  let acceptable = 0;
  const failures: string[] = [];
  for (const entry of cases) {
    const outcome = await searchSessions(search, { text: entry.query, limit: 3 });
    const refs = outcome.results.map((hit) => hit.ref);
    const ok = entry.expected === undefined ? refs.length === 0 : refs.includes(entry.expected);
    if (ok) acceptable += 1;
    else failures.push(`${entry.query} → expected ${entry.expected ?? "(nothing)"}, got ${refs.join(",") || "(nothing)"}`);
  }
  return { acceptable, failures };
}

describe("baseline over a labelled corpus", () => {
  it("answers at least 90% of the thirty-one lexical cases", async () => {
    seedCorpus();
    const lexical = await score(LEXICAL_CORPUS);
    const rate = lexical.acceptable / LEXICAL_CORPUS.length;

    // The number reported here is the one the Phase 6 report quotes, so it names both groups.
    const semantic = await score(SEMANTIC_CORPUS);
    process.stderr.write(
      `[fts-baseline] lexical ${lexical.acceptable}/${LEXICAL_CORPUS.length} (${(rate * 100).toFixed(1)}%); ` +
        `semantic-only ${semantic.acceptable}/${SEMANTIC_CORPUS.length} ` +
        `(${((semantic.acceptable / SEMANTIC_CORPUS.length) * 100).toFixed(1)}%) — the gap Phase 10 must close\n` +
        (lexical.failures.length === 0 ? "" : `lexical failures:\n  ${lexical.failures.join("\n  ")}\n`),
    );

    expect(LEXICAL_CORPUS.length).toBeGreaterThanOrEqual(30);
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });

  it("records what a lexical baseline cannot do, so the next layer has a number to beat", async () => {
    seedCorpus();
    const semantic = await score(SEMANTIC_CORPUS);
    // Not asserted as a floor: a synonym query failing is the expected behaviour of BM25, and the
    // only thing worth keeping is the measurement itself.
    expect(semantic.acceptable).toBeLessThan(SEMANTIC_CORPUS.length);
    expect(CORPUS.length).toBe(LEXICAL_CORPUS.length + SEMANTIC_CORPUS.length);
  });
});

describe("the search deadline", () => {
  const config = (): JevConfig => ({
    enabled: true,
    localOnly: false,
    apiKey: "sk-test-not-a-real-key",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    endpointRefusal: undefined,
    model: "jev-1.13.0",
    timeoutMs: 2000,
    maxCallsPerTurn: 2,
    policyVersion: "2026-09-17",
    confidenceFloor: 0.85,
    marginFloor: 0.2,
    noulOnFloor: 0.85,
    noulOffFloor: 0.15,
  });

  it("answers from the ranking inside the total budget when the selector is slower than its deadline", async () => {
    // Two messages that a keyword search cannot separate, so the decision path is actually entered.
    seed("sửa lỗi đăng nhập token hết hạn", "msg_login_a", "2026-09-16T02:00:00.000Z");
    seed("sửa lỗi đăng nhập không vào được", "msg_login_b", "2026-09-15T02:00:00.000Z");

    let calls = 0;
    const slow: JevTransport = async (request) => {
      calls += 1;
      // Honours the signal, like fetch: a transport that ignored it would prove nothing about a
      // deadline that is enforced by aborting.
      return await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the provider never answered")), 5_000);
        request.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    };

    const started = Date.now();
    const outcome = await searchSessions(
      {
        ...search,
        decider: { jev: { config: config(), transport: slow }, budget: { deadlineAt: Date.now() + 30, timeoutMs: 30 } },
        deciderMode: "jev",
      },
      { text: "sửa lỗi đăng nhập", limit: 5 },
    );
    const elapsed = Date.now() - started;

    // The plan's rule: an unavailable or slow selector returns the ranking, and never reports the
    // fallback as though the selector had chosen.
    expect(outcome.mode).toBe("rank");
    expect(outcome.chosen).toBeUndefined();
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.decider?.reason ?? "").toContain("30 ms");
    expect(calls).toBe(1);
    // The whole search — ranking plus the decision that timed out — stays inside the plan's ceiling.
    expect(elapsed).toBeLessThan(SEARCH_TOTAL_BUDGET_MS);
    void SEARCH_TOTAL_BUDGET_MS;
  });
});
