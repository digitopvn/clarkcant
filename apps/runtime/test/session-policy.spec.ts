import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";

import { decideSessionRebuild } from "../src/jev-decider.ts";
import { type JevConfig, type JevTransport, createJevBudget } from "../src/jev-selector.ts";
import { createModelTurn } from "../src/model-turn.ts";
import {
  SESSION_POLICY_LIMITS,
  type SessionTelemetry,
  decideSession,
  decideSessionReuse,
  linesChanged,
  sessionPolicyFromEnv,
  topicShift,
} from "../src/session-policy.ts";

/**
 * When a conversation's next turn reuses its session and when it starts a fresh one.
 *
 * What has to hold: the decision is the same for the same numbers; it never rebuilds a session's first turn or one with a
 * turn running; it rebuilds only when the cache is cold, the context large and the subject new; the selector is asked
 * only in the unclear band, is shown counts, and anything it does not decide is reuse; and a rebuild keeps the
 * conversation: the fresh session is briefed by the recap and the old one is let go.
 */

const COLD = SESSION_POLICY_LIMITS.cacheTtlMs + 60_000;
const LARGE = SESSION_POLICY_LIMITS.largeContextTokens * 2;

function telemetry(overrides: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { ageMs: COLD, idleMs: COLD, turns: 4, contextTokens: LARGE, topicShift: 1, ...overrides };
}

const STEADY = { firstTurn: false, inFlight: false };

describe("how new a message's subject is", () => {
  it("is the share of its terms the recent messages do not have", () => {
    expect(topicShift(["cơ sở dữ liệu SQLite"], "SQLite migrations")).toBe(0.5);
    expect(topicShift(["cơ sở dữ liệu SQLite"], "thời tiết Hà Nội")).toBe(1);
    expect(topicShift([], "bất kỳ")).toBe(1);
  });

  it("is no change for a message with no subject words", () => {
    expect(topicShift(["cơ sở dữ liệu"], "ok")).toBe(0);
  });
});

describe("what changed between two briefs", () => {
  it("counts the lines one has and the other does not", () => {
    expect(linesChanged("a\nb", "a\nc")).toBe(2);
    expect(linesChanged("", "a\n\nb")).toBe(2);
    expect(linesChanged("a", "a")).toBe(0);
  });
});

describe("the decision", () => {
  it("never rebuilds a first turn or a running one", () => {
    expect(decideSessionReuse(telemetry(), { firstTurn: true, inFlight: false })).toEqual({ decision: "reuse", reason: "first-turn" });
    expect(decideSessionReuse(telemetry(), { firstTurn: false, inFlight: true })).toEqual({ decision: "reuse", reason: "in-flight" });
  });

  it("reuses a warm cache and a small context, whatever the subject", () => {
    expect(decideSessionReuse(telemetry({ idleMs: 10_000 }), STEADY).reason).toBe("cache-warm");
    expect(decideSessionReuse(telemetry({ contextTokens: 500 }), STEADY).reason).toBe("context-small");
    // A provider that reports no context size is treated as small: reuse is the safe default.
    const { contextTokens: _omitted, ...unknownSize } = telemetry();
    expect(decideSessionReuse(unknownSize, STEADY).reason).toBe("context-small");
  });

  it("rebuilds a cold, large session on a new subject, asks in the unclear band, and reuses on the same one", () => {
    expect(decideSessionReuse(telemetry({ topicShift: 0.9 }), STEADY)).toEqual({ decision: "rebuild", reason: "cold-large-new-subject" });
    expect(decideSessionReuse(telemetry({ topicShift: 0.6 }), STEADY)).toEqual({ decision: "ask", reason: "subject-unclear" });
    expect(decideSessionReuse(telemetry({ topicShift: 0.2 }), STEADY)).toEqual({ decision: "reuse", reason: "same-subject" });
  });

  it("is the same for the same numbers", () => {
    const decisions = Array.from({ length: 5 }, () => decideSessionReuse(telemetry({ topicShift: 0.6 }), STEADY));
    expect(new Set(decisions.map((decision) => decision.decision))).toEqual(new Set(["ask"]));
  });

  it("asks the selector only in the unclear band, and anything it does not decide is reuse", async () => {
    const ask = vi.fn(async () => true as boolean | undefined);
    expect(await decideSession(telemetry({ topicShift: 0.9 }), STEADY, ask)).toMatchObject({ decision: "rebuild" });
    expect(await decideSession(telemetry({ topicShift: 0.2 }), STEADY, ask)).toMatchObject({ decision: "reuse" });
    expect(ask).not.toHaveBeenCalled();
    expect(await decideSession(telemetry({ topicShift: 0.6 }), STEADY, ask)).toEqual({ decision: "rebuild", reason: "selector-rebuild" });
    expect(await decideSession(telemetry({ topicShift: 0.6 }), STEADY, async () => false)).toEqual({ decision: "reuse", reason: "selector-reuse" });
    expect(await decideSession(telemetry({ topicShift: 0.6 }), STEADY, async () => undefined)).toMatchObject({ decision: "reuse" });
    expect(
      await decideSession(telemetry({ topicShift: 0.6 }), STEADY, async () => {
        throw new Error("selector down");
      }),
    ).toMatchObject({ decision: "reuse" });
    // Without a selector the unclear band is reuse.
    expect(await decideSession(telemetry({ topicShift: 0.6 }), STEADY)).toEqual({ decision: "reuse", reason: "subject-unclear" });
  });
});

describe("the switch", () => {
  it("is off unless set to observe or rebuild", () => {
    expect(sessionPolicyFromEnv({})).toBe("off");
    expect(sessionPolicyFromEnv({ CLARKCANT_SESSION_POLICY: "Observe" })).toBe("observe");
    expect(sessionPolicyFromEnv({ CLARKCANT_SESSION_POLICY: "rebuild" })).toBe("rebuild");
    expect(sessionPolicyFromEnv({ CLARKCANT_SESSION_POLICY: "always" })).toBe("off");
  });
});

describe("the selector, when asked", () => {
  function config(): JevConfig {
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
    };
  }

  function selector(choice: string, top = 0.97): { deps: Parameters<typeof decideSessionRebuild>[0]; seen: unknown[] } {
    const seen: unknown[] = [];
    const transport: JevTransport = async (request) => {
      const body = request.body as { state: unknown; questions: Record<string, { criteria?: Record<string, unknown> }> };
      const id = Object.keys(body.questions)[0] ?? "q";
      seen.push(body.state);
      const options = Object.keys(body.questions[id]?.criteria ?? {});
      const all = [...new Set([...options, "none", choice])];
      const rest = (1 - top) / (all.length - 1);
      const probabilities = Object.fromEntries(all.map((option) => [option, option === choice ? top : rest]));
      return { status: 200, body: { model: "jev-1.13.0", answers: { [id]: { type: "choice", choice, probabilities } } } };
    };
    const conf = config();
    return { deps: { jev: { config: conf, transport }, budget: () => createJevBudget(conf) }, seen };
  }

  const input = { idleSeconds: 612.4, contextTokens: 41_000, topicShift: 0.6123, turns: 7 };

  it("is shown counts only, and its decisive answer is the decision", async () => {
    const rebuild = selector("rebuild");
    expect(await decideSessionRebuild(rebuild.deps, input)).toBe(true);
    expect(rebuild.seen).toEqual([{ idleSeconds: 612, contextTokens: 41_000, newTermShare: 0.61, turnsSoFar: 7 }]);
    expect(await decideSessionRebuild(selector("reuse").deps, input)).toBe(false);
  });

  it("decides nothing when it is not sure or picks neither", async () => {
    expect(await decideSessionRebuild(selector("rebuild", 0.5).deps, input)).toBeUndefined();
    expect(await decideSessionRebuild(selector("none").deps, input)).toBeUndefined();
  });
});

describe("a conversation's sessions", () => {
  const OWNER: Principal = { principalId: "p_owner" as Principal["principalId"], kind: "user", nodeId: "n1" as Principal["nodeId"] };
  const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;
  const CONVERSATION = "c1" as ConversationId;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function conversation(mode: "observe" | "rebuild") {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T08:00:00Z"));
    const adapter = new FakePiAdapter({ script: ["một", "hai", "ba"] });
    // The fake adapter reports no context size; a real one does, and a large one is what makes a rebuild worth it.
    vi.spyOn(adapter, "usage").mockImplementation(() => ({ turns: 1, contextTokens: LARGE }));
    const disposed = vi.spyOn(adapter, "dispose");
    const transcript = [{ role: "user" as const, text: "cơ sở dữ liệu SQLite" }];
    const reported: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === "string" && chunk.includes('"session-policy"')) reported.push(chunk);
      return true;
    });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      history: async () => transcript,
      sessionPolicy: { mode },
    });
    const ask = async (text: string, id: string): Promise<void> => {
      await turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text, messageId: id });
      transcript.push({ role: "user", text });
    };
    return { adapter, disposed, ask, reported, transcript };
  }

  it("rebuilds a cold, large session on a new subject, briefs the fresh one with the recap, and lets the old one go", async () => {
    const { adapter, disposed, ask, reported, transcript } = await conversation("rebuild");
    await ask("cơ sở dữ liệu SQLite", "m1");
    await ask("SQLite migrations", "m2");
    expect(adapter.promptsFor("fake-session-1")).toHaveLength(2);
    // Ten minutes later, about something else entirely.
    vi.setSystemTime(new Date("2026-10-04T08:10:00Z"));
    await ask("thời tiết Hà Nội cuối tuần", "m3");

    const fresh = adapter.promptsFor("fake-session-2");
    expect(fresh).toHaveLength(1);
    // The fresh session hears the conversation so far, from the transcript, which the rebuild did not touch.
    expect(fresh[0]).toContain("Mạch hội thoại trước đó");
    expect(fresh[0]).toContain("SQLite migrations");
    expect(fresh[0]).toContain("thời tiết Hà Nội cuối tuần");
    expect(transcript.map((message) => message.text)).toEqual([
      "cơ sở dữ liệu SQLite",
      "cơ sở dữ liệu SQLite",
      "SQLite migrations",
      "thời tiết Hà Nội cuối tuần",
    ]);
    expect(disposed).toHaveBeenCalledWith("fake-session-1");

    const decisions = reported.map((line) => JSON.parse(line) as { reason: string; rebuilt: boolean; conversationId: string });
    expect(decisions.map((line) => [line.reason, line.rebuilt])).toEqual([
      ["first-turn", false],
      ["cache-warm", false],
      ["cold-large-new-subject", true],
    ]);
    // Counts and times only: the report carries no text of the conversation.
    expect(reported.join("")).not.toContain("thời tiết");
  });

  it("only reports in observe mode: the session is kept", async () => {
    const { adapter, disposed, ask, reported } = await conversation("observe");
    await ask("cơ sở dữ liệu SQLite", "m1");
    await ask("SQLite migrations", "m2");
    vi.setSystemTime(new Date("2026-10-04T08:10:00Z"));
    await ask("thời tiết Hà Nội cuối tuần", "m3");

    expect(adapter.promptsFor("fake-session-1")).toHaveLength(3);
    expect(adapter.promptsFor("fake-session-2")).toHaveLength(0);
    expect(disposed).not.toHaveBeenCalled();
    const last = JSON.parse(reported.at(-1) ?? "{}") as { decision: string; rebuilt: boolean };
    expect(last).toMatchObject({ decision: "rebuild", rebuilt: false });
  });

  it("keeps the session when a rebuild fails", async () => {
    const { adapter, ask } = await conversation("rebuild");
    await ask("cơ sở dữ liệu SQLite", "m1");
    await ask("SQLite migrations", "m2");
    vi.setSystemTime(new Date("2026-10-04T08:10:00Z"));
    vi.spyOn(adapter, "createWorkerSession").mockRejectedValueOnce(new Error("provider down"));
    await ask("thời tiết Hà Nội cuối tuần", "m3");
    expect(adapter.promptsFor("fake-session-1")).toHaveLength(3);
  });
});
