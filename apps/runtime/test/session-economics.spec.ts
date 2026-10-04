import { describe, expect, it } from "vitest";

import { SESSION_POLICY_LIMITS, decideSessionReuse, topicShift } from "../src/session-policy.ts";

/**
 * What the session policy costs and saves against always reusing a session and rebuilding one every turn, offline.
 *
 * A turn sends the session's whole context. While the provider's cache is warm, the part it has seen is read at a
 * discount; once it has gone cold, it is written again at a premium. A fresh session sends only the base prompt and a
 * short recap, but it loses the verbatim context, and it too is written at the premium. So this simulates the cache over
 * scripted conversations and compares:
 *
 * - `reuse`: one session for the whole conversation (the default, and the policy's `off`);
 * - `policy`: the shipped decision, a rebuild only when the cache is cold, the context large and the subject new;
 * - `per-turn`: a fresh session every turn, the rebuild-always the issue measured as more expensive.
 *
 * Every number is an estimate under the labelled assumptions, printed with the table. The test asserts only what must
 * hold whatever the numbers are. Real cache lifetimes, latency and whether a recap loses something a turn needed are
 * what a live A/B with provider credentials would measure; none of it is measured here.
 */

/** Labelled assumptions, not measurements; the prices match the context-economics harness. */
const ASSUMED = {
  baseSystemTokens: 2500,
  replyTokens: 250,
  /** What a fresh session's recap costs: the planner's recap is bounded, so a fixed ceiling is a fair estimate. */
  recapTokens: 1200,
  inputPerM: 3,
  cacheWritePerM: 3.75,
  cacheReadPerM: 0.3,
  charsPerToken: 4,
} as const;

/** One turn: how long after the last one it starts, what the person says, and what the tools it runs add to context. */
interface ScriptedTurn {
  afterMs: number;
  text: string;
  toolTokens: number;
}

const MINUTE = 60_000;

function warmCoding(): ScriptedTurn[] {
  const texts = [
    "sửa lỗi migration SQLite trong packages storage",
    "chạy lại test migration SQLite",
    "migration 0042 vẫn lỗi khi thêm cột",
    "thêm test cho cột mới trong migration",
    "chạy pnpm verify cho storage",
    "commit thay đổi migration storage",
  ];
  return texts.map((text, index) => ({ afterMs: index === 0 ? 0 : 2 * MINUTE, text, toolTokens: 6000 }));
}

function coldSameSubject(): ScriptedTurn[] {
  return [
    { afterMs: 0, text: "viết hàm phân tích log nginx thành JSON", toolTokens: 8000 },
    { afterMs: MINUTE, text: "thêm trường latency vào phân tích log nginx", toolTokens: 8000 },
    { afterMs: MINUTE, text: "test phân tích log nginx với file mẫu", toolTokens: 8000 },
    { afterMs: 40 * MINUTE, text: "phân tích log nginx bỏ sót dòng lỗi 502", toolTokens: 4000 },
    { afterMs: MINUTE, text: "sửa phân tích log nginx cho dòng 502", toolTokens: 4000 },
  ];
}

function coldNewSubject(): ScriptedTurn[] {
  return [
    { afterMs: 0, text: "refactor module thanh toán stripe webhook", toolTokens: 9000 },
    { afterMs: MINUTE, text: "stripe webhook cần kiểm tra chữ ký", toolTokens: 9000 },
    { afterMs: MINUTE, text: "viết test chữ ký stripe webhook", toolTokens: 9000 },
    { afterMs: 3 * 60 * MINUTE, text: "lên lịch họp nhóm thiết kế thứ năm", toolTokens: 1000 },
    { afterMs: MINUTE, text: "gửi lời mời họp thiết kế cho cả nhóm", toolTokens: 1000 },
    { afterMs: MINUTE, text: "đặt phòng họp tầng ba", toolTokens: 1000 },
  ];
}

const CORPUS: { name: string; turns: ScriptedTurn[] }[] = [
  { name: "warm coding", turns: warmCoding() },
  { name: "cold, same subject", turns: coldSameSubject() },
  { name: "cold, new subject", turns: coldNewSubject() },
];

type Strategy = "reuse" | "policy" | "per-turn";

interface Outcome {
  costUsd: number;
  rebuilds: number;
  /** Tokens the model was sent across the conversation: what latency roughly follows. */
  sentTokens: number;
}

const tokensOf = (text: string): number => Math.ceil(text.length / ASSUMED.charsPerToken);

function simulate(turns: readonly ScriptedTurn[], strategy: Strategy): Outcome {
  let context = 0;
  let answered = 0;
  let recent: string[] = [];
  let costUsd = 0;
  let rebuilds = 0;
  let sentTokens = 0;
  for (const turn of turns) {
    const sinceUse = turn.afterMs;
    const firstTurn = answered === 0;
    let rebuild = false;
    if (!firstTurn && strategy === "per-turn") rebuild = true;
    if (!firstTurn && strategy === "policy") {
      const decision = decideSessionReuse(
        { ageMs: 0, idleMs: sinceUse, turns: answered, contextTokens: context, topicShift: topicShift(recent, turn.text) },
        { firstTurn, inFlight: false },
      );
      rebuild = decision.decision === "rebuild";
    }
    // The prefix the provider may have cached, and whether it is still warm.
    let cachedPrefix = context;
    let warm = !firstTurn && sinceUse < SESSION_POLICY_LIMITS.cacheTtlMs;
    if (firstTurn) context = ASSUMED.baseSystemTokens;
    if (rebuild) {
      rebuilds += 1;
      context = ASSUMED.baseSystemTokens + ASSUMED.recapTokens;
      cachedPrefix = 0;
      warm = false;
      answered = 0;
      recent = [];
    }
    const message = tokensOf(turn.text);
    const prefix = firstTurn || rebuild ? context : cachedPrefix;
    // The prefix is read when warm and written when not; the new message is written either way.
    costUsd += warm ? (prefix * ASSUMED.cacheReadPerM) / 1e6 : (prefix * ASSUMED.cacheWritePerM) / 1e6;
    costUsd += (message * ASSUMED.cacheWritePerM) / 1e6;
    sentTokens += prefix + message;
    // Tool results land in the context and are sent again by the next step of the same turn: priced as input once.
    costUsd += (turn.toolTokens * ASSUMED.inputPerM) / 1e6;
    sentTokens += turn.toolTokens;
    context = prefix + message + turn.toolTokens + ASSUMED.replyTokens;
    answered += 1;
    recent.push(turn.text);
    if (recent.length > SESSION_POLICY_LIMITS.recentTexts) recent.shift();
  }
  return { costUsd, rebuilds, sentTokens };
}

describe("session reuse economics (offline, estimated)", () => {
  const results = CORPUS.map((conversation) => ({
    name: conversation.name,
    reuse: simulate(conversation.turns, "reuse"),
    policy: simulate(conversation.turns, "policy"),
    perTurn: simulate(conversation.turns, "per-turn"),
  }));

  it("prints its assumptions and a table", () => {
    const rows = results.map(
      (row) =>
        `${row.name.padEnd(20)} reuse $${row.reuse.costUsd.toFixed(4)} | policy $${row.policy.costUsd.toFixed(4)} ` +
        `(${String(row.policy.rebuilds)} rebuild) | per-turn $${row.perTurn.costUsd.toFixed(4)} (${String(row.perTurn.rebuilds)} rebuilds)` +
        ` | tokens sent ${String(row.reuse.sentTokens)}/${String(row.policy.sentTokens)}/${String(row.perTurn.sentTokens)}`,
    );
    console.log(
      [
        "Session reuse economics — estimates, not measurements",
        `assumptions: ${JSON.stringify(ASSUMED)}, cache lifetime ${String(SESSION_POLICY_LIMITS.cacheTtlMs / MINUTE)} min`,
        ...rows,
        "not measured: real cache lifetimes, latency, and whether a recap loses something a turn needed (live A/B).",
      ].join("\n"),
    );
    expect(rows).toHaveLength(CORPUS.length);
  });

  it("never rebuilds a warm conversation, so it costs what reuse costs there", () => {
    const warm = results.find((row) => row.name === "warm coding")!;
    expect(warm.policy.rebuilds).toBe(0);
    expect(warm.policy.costUsd).toBe(warm.reuse.costUsd);
  });

  it("finds rebuilding every turn dearer than reuse on a warm conversation", () => {
    const warm = results.find((row) => row.name === "warm coding")!;
    expect(warm.perTurn.costUsd).toBeGreaterThan(warm.reuse.costUsd);
  });

  it("keeps a session across a cold gap when the subject stays, and rebuilds one when it changes", () => {
    expect(results.find((row) => row.name === "cold, same subject")!.policy.rebuilds).toBe(0);
    expect(results.find((row) => row.name === "cold, new subject")!.policy.rebuilds).toBe(1);
  });

  it("never costs more than reuse, under these assumptions", () => {
    for (const row of results) expect(row.policy.costUsd).toBeLessThanOrEqual(row.reuse.costUsd);
  });
});
