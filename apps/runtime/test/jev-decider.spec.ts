import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import { migrate, openDatabase, upsertTask, type Database } from "@clarkcant/storage";

import {
  type DecideDeps,
  rankGapIsClear,
  decideRuntimeTarget,
  decideSearchResult,
  searchDeciderFromEnv,
} from "../src/jev-decider.ts";
import { type JevConfig, type JevTelemetry, type JevTransport, createJevBudget } from "../src/jev-selector.ts";
import {
  createFindRuntimeTool,
  filterRuntimeCandidates,
  listRuntimeCandidates,
  rankRuntimeCandidates,
  verifyRuntimeCandidate,
  type RuntimeCandidate,
} from "../src/runtime-candidates.ts";

/**
 * The decision layer (Phase 9).
 *
 * Every test here is about a refusal to decide. A selector that answers is easy; what has to hold is
 * that it is not asked when there is nothing to choose, that its answer is checked against what it
 * was offered and against the world as it is now, and that an undecided answer falls back rather
 * than being rounded into a choice.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;

let dir: string;
let db: Database;

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

interface Recorded {
  transport: JevTransport;
  calls: number;
  telemetry: JevTelemetry[];
}

/** Answers the first question with a Choice, and the second with a Noul when given one. */
function responder(script: { choice?: string; probabilities?: Record<string, number>; noul?: number }): Recorded {
  const state: Recorded = {
    calls: 0,
    telemetry: [],
    transport: async (request) => {
      state.calls += 1;
      const body = request.body as { questions: Record<string, { type: string }> };
      const id = Object.keys(body.questions)[0] ?? "q";
      const question = body.questions[id];
      if (question?.type === "noul") {
        return {
          status: 200,
          body: { model: "jev-1.13.0", answers: { [id]: { type: "noul", noul: script.noul ?? 0.9 } } },
        };
      }
      return {
        status: 200,
        body: {
          model: "jev-1.13.0",
          answers: {
            [id]: {
              type: "choice",
              choice: script.choice ?? "none",
              probabilities: script.probabilities ?? { none: 1 },
            },
          },
        },
      };
    },
  };
  return state;
}

function deps(recorded: Recorded, overrides: Partial<JevConfig> = {}): DecideDeps {
  const conf = config(overrides);
  return {
    jev: { config: conf, transport: recorded.transport, onTelemetry: (event) => recorded.telemetry.push(event) },
    budget: createJevBudget(conf),
  };
}

function candidate(overrides: Partial<RuntimeCandidate> = {}): RuntimeCandidate {
  return {
    id: "runtime:lease:lease_1",
    kind: "lease",
    label: "đang giữ workspace agentkit",
    capabilities: [],
    live: true,
    load: 1,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-decider-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES ('conv_1', NULL, 'node_local', ?, ?)",
  ).run(AT, AT);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("runtime target decisions", () => {
  it("does not call the provider when nothing or only one thing is running", async () => {
    const none = responder({});
    expect(await decideRuntimeTarget(deps(none), { intent: "x", candidates: [] })).toEqual({
      status: "none",
      reason: "nothing is running on this node",
    });

    const single = responder({});
    const outcome = await decideRuntimeTarget(deps(single), { intent: "x", candidates: [candidate()] });
    expect(outcome.status).toBe("selected");
    if (outcome.status === "selected") expect(outcome.id).toBe("runtime:lease:lease_1");
    expect(single.calls).toBe(0);
  });

  it("takes a decisive choice and refuses to dispatch when the target has gone", async () => {
    const decisive = responder({
      choice: "runtime:lease:lease_2",
      probabilities: { "runtime:lease:lease_1": 0.03, "runtime:lease:lease_2": 0.95, none: 0.02 },
    });
    const candidates = [
      candidate(),
      candidate({ id: "runtime:lease:lease_2", label: "đang giữ workspace khác", load: 0 }),
    ];

    const verified = await decideRuntimeTarget(deps(decisive), {
      intent: "tiếp tục việc ở workspace khác",
      candidates,
      verify: () => true,
    });
    expect(verified.status).toBe("selected");
    if (verified.status === "selected") expect(verified.id).toBe("runtime:lease:lease_2");

    // The world moved while the selector was thinking: a lease can be released, a tab closed.
    const gone = await decideRuntimeTarget(deps(decisive), {
      intent: "tiếp tục việc ở workspace khác",
      candidates,
      verify: () => false,
    });
    expect(gone.status).toBe("fallback");
    if (gone.status === "fallback") {
      expect(gone.reason).toContain("stopped being live");
      // The fallback carries the ranked order so the caller has something to use.
      expect(gone.ordered).toHaveLength(2);
    }
  });

  it("falls back on a tie, on none, and when the provider is unavailable", async () => {
    const candidates = [
      candidate(),
      candidate({ id: "runtime:lease:lease_2", label: "đang giữ workspace khác" }),
    ];

    const tie = responder({
      choice: "runtime:lease:lease_1",
      probabilities: { "runtime:lease:lease_1": 0.9, "runtime:lease:lease_2": 0.85, none: 0.05 },
    });
    const tied = await decideRuntimeTarget(deps(tie), { intent: "x", candidates });
    expect(tied.status).toBe("fallback");
    if (tied.status === "fallback") expect(tied.reason).toContain("margin");

    const declined = responder({ choice: "none", probabilities: { "runtime:lease:lease_1": 0.1, "runtime:lease:lease_2": 0.1, none: 0.8 } });
    const none = await decideRuntimeTarget(deps(declined), { intent: "thời tiết hôm nay thế nào", candidates });
    expect(none.status).toBe("none");

    const down = responder({});
    const unavailable = await decideRuntimeTarget(deps(down, { enabled: false, apiKey: undefined }), {
      intent: "x",
      candidates,
    });
    expect(unavailable.status).toBe("fallback");
    if (unavailable.status === "fallback") expect(unavailable.reason).toContain("disabled");
    expect(down.calls).toBe(0);
  });

  it("never sends a path or a raw goal to the selector", async () => {
    let seen = "";
    const conf = config();
    const recording: JevTransport = async (request) => {
      seen = JSON.stringify(request.body);
      return {
        status: 200,
        body: {
          model: "jev-1.13.0",
          answers: {
            runtime: {
              type: "choice",
              choice: "runtime:lease:lease_1",
              probabilities: { "runtime:lease:lease_1": 0.9, "runtime:lease:lease_2": 0.05, none: 0.05 },
            },
          },
        },
      };
    };
    await decideRuntimeTarget(
      { jev: { config: conf, transport: recording }, budget: createJevBudget(conf) },
      {
        intent: "dùng key sk-live-abcdef1234567890 để mở /Users/duynguyen/www/secret",
        candidates: [candidate(), candidate({ id: "runtime:lease:lease_2" })],
      },
    );

    expect(seen).not.toContain("sk-live-abcdef1234567890");
    expect(seen).not.toContain("/Users/duynguyen");
    // The candidate ids and kinds travel; the labels never do.
    expect(seen).toContain("runtime:lease:lease_1");
    expect(seen).not.toContain("agentkit");
  });
});

describe("search decisions", () => {
  const results = [
    { ref: "msg_a", snippet: "sửa lỗi đăng nhập", score: -0.000002, source: "message" },
    { ref: "msg_b", snippet: "thêm nhãn trục cho biểu đồ", score: -0.00000195, source: "message" },
  ];

  it("does not call the provider for one result or for a ranking that already separated them", async () => {
    const noCall = responder({});
    expect(await decideSearchResult(deps(noCall), { query: "x", results: [] })).toEqual({
      status: "rank",
      reason: "there was nothing to choose between",
    });
    expect(await decideSearchResult(deps(noCall), { query: "x", results: [results[0]!] })).toEqual({
      status: "rank",
      reason: "one result is already unambiguous",
    });

    const separated = [
      { ...results[0]!, score: -0.000002 },
      { ...results[1]!, score: -0.000001 },
    ];
    const gap = await decideSearchResult(deps(noCall), { query: "x", results: separated });
    expect(gap.status).toBe("rank");
    expect(noCall.calls).toBe(0);

    // The rule is relative, and stated rather than implied: these two raw scores differ by a tiny
    // absolute amount, which is what a real BM25 score looks like.
    expect(rankGapIsClear(separated[0]!.score, separated[1]!.score)).toBe(true);
    expect(rankGapIsClear(results[0]!.score, results[1]!.score)).toBe(false);
  });

  it("reorders close results around a decisive choice without dropping the others", async () => {
    const decisive = responder({
      choice: "result:msg_b",
      probabilities: { "result:msg_a": 0.05, "result:msg_b": 0.9, none: 0.05 },
    });
    const outcome = await decideSearchResult(deps(decisive), { query: "nhãn trục", results });
    expect(outcome.status).toBe("chosen");
    if (outcome.status !== "chosen") return;
    expect(outcome.ref).toBe("msg_b");
    expect(decisive.calls).toBe(1);
  });

  it("asks the user when the selector is unsure and Noul agrees, and falls back when it does not", async () => {
    const unsureThenAsk = (noul: number): Recorded => {
      const state: Recorded = {
        calls: 0,
        telemetry: [],
        transport: async (request) => {
          state.calls += 1;
          const body = request.body as { questions: Record<string, { type: string }> };
          const id = Object.keys(body.questions)[0] ?? "q";
          if (body.questions[id]?.type === "noul") {
            return { status: 200, body: { model: "jev-1.13.0", answers: { [id]: { type: "noul", noul } } } };
          }
          return {
            status: 200,
            body: {
              model: "jev-1.13.0",
              answers: {
                [id]: {
                  type: "choice",
                  choice: "none",
                  probabilities: { "result:msg_a": 0.45, "result:msg_b": 0.45, none: 0.1 },
                },
              },
            },
          };
        },
      };
      return state;
    };

    const ask = unsureThenAsk(0.9);
    const clarified = await decideSearchResult(deps(ask), { query: "gì đó", results });
    expect(clarified.status).toBe("clarify");
    if (clarified.status === "clarify") expect(clarified.question).toContain("kết quả");
    expect(ask.calls).toBe(2);

    const proceed = unsureThenAsk(0.05);
    const ranked = await decideSearchResult(deps(proceed), { query: "gì đó", results });
    expect(ranked.status).toBe("rank");
    if (ranked.status === "rank") expect(ranked.reason).toContain("declined");
  });

  it("falls back to the ranking when the provider is off", async () => {
    const recorded = responder({});
    const outcome = await decideSearchResult(deps(recorded, { enabled: false, apiKey: undefined }), {
      query: "gì đó",
      results,
    });
    expect(outcome.status).toBe("rank");
    expect(recorded.calls).toBe(0);
  });
});

describe("the decider's default", () => {
  it("is the measured baseline unless a node opts in", () => {
    expect(searchDeciderFromEnv({})).toBe("rank");
    expect(searchDeciderFromEnv({ CLARKCANT_SEARCH_DECIDER: "rank" })).toBe("rank");
    expect(searchDeciderFromEnv({ CLARKCANT_SEARCH_DECIDER: "jev" })).toBe("jev");
    // Anything unrecognised is the safe path, not a crash and not an accidental provider call.
    expect(searchDeciderFromEnv({ CLARKCANT_SEARCH_DECIDER: "maybe" })).toBe("rank");
  });
});

/* ------------------------------------------------------------------ *
 * Runtime candidates
 * ------------------------------------------------------------------ */

describe("runtime candidates", () => {
  /**
   * A live owner has a foreign key to its instance, which is enforced.
   *
   * Written by hand rather than through `captureCompositeSurface` because these tests are about what
   * the candidate reader finds in the tables, not about how a surface is composed.
   */
  function seedInstance(instanceId: string): void {
    db.prepare(
      `INSERT INTO widget_instances
         (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
          revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
       VALUES (?, 'canvas.overview@1', '1.0.0', 'sha256:x', 'node_local', 'prin_owner', 1, 1, 1, 1, 'ready', '{}', ?)`,
    ).run(instanceId, AT);
  }

  function seedTask(id: string, state: string, goal: string): void {
    upsertTask(db, {
      taskId: id,
      conversationId: "conv_1",
      homeNodeId: "node_local",
      state: state as never,
      revision: 1,
      goal,
      createdAt: AT,
      updatedAt: AT,
    });
  }

  it("reads what is running from state tables rather than from a text index", () => {
    seedTask("task_running", "running", "việc đang chạy dở");
    seedTask("task_done", "succeeded", "việc đã xong");
    db.prepare(
      `INSERT INTO leases (lease_id, resource_node_id, resource_id, resource_kind, holder_task_id, epoch, acquired_at, expires_at)
       VALUES ('lease_live', 'node_local', 'agentkit', 'workspace', 'task_running', 1, ?, ?)`,
    ).run(AT, "2026-09-17T06:00:00.000Z");
    seedInstance("winst_1");
    db.prepare(
      `INSERT INTO widget_live_owners (instance_id, owner_token, owner_surface, claimed_at, lease_expires_at)
       VALUES ('winst_1', 'tok', 'pin', ?, '2026-09-17T05:30:00.000Z')`,
    ).run(AT);
    db.prepare(
      `INSERT INTO voice_sessions (voice_session_id, node_id, principal_id, state, provider, media_focus, started_at, document)
       VALUES ('voice_1', 'node_local', 'prin_owner', 'listening', 'gemini', 'microphone', ?, '{}')`,
    ).run(AT);

    const deps_ = { db, nodeId: "node_local", now: () => AT };
    const candidates = listRuntimeCandidates(deps_);
    const kinds = candidates.map((entry) => entry.kind).sort();
    expect(kinds).toEqual(["lease", "live-owner", "node", "task", "voice-session"]);
    // A finished task is not running and must not appear.
    expect(candidates.some((entry) => entry.id.includes("task_done"))).toBe(false);
    // Every candidate is live as of this read.
    expect(candidates.every((entry) => entry.live)).toBe(true);

    // Structured filters, including one that must not match.
    expect(filterRuntimeCandidates(candidates, { kind: "lease" })).toHaveLength(1);
    expect(filterRuntimeCandidates(candidates, { labelContains: "agentkit" })).toHaveLength(1);
    // A filter typed without diacritics matches a label written with them, which is how a user
    // actually types, and a phrase that is not there matches nothing.
    expect(filterRuntimeCandidates(candidates, { labelContains: "dang chay" }).some((entry) => entry.kind === "task")).toBe(true);
    expect(filterRuntimeCandidates(candidates, { labelContains: "không có gì" })).toHaveLength(0);
    expect(filterRuntimeCandidates(candidates, { requiredCapability: "workspace.write@1" })).toHaveLength(0);

    // Ranking puts an idle thing before a busy one.
    const ranked = rankRuntimeCandidates(candidates);
    expect(ranked[0]?.load).toBe(0);
  });

  it("treats an expired live claim and a released lease as gone", () => {
    db.prepare(
      `INSERT INTO leases (lease_id, resource_node_id, resource_id, resource_kind, epoch, acquired_at, expires_at, released_at)
       VALUES ('lease_gone', 'node_local', 'ws', 'workspace', 1, ?, '2026-09-17T05:10:00.000Z', ?)`,
    ).run(AT, AT);
    seedInstance("winst_expired");
    db.prepare(
      `INSERT INTO widget_live_owners (instance_id, owner_token, owner_surface, claimed_at, lease_expires_at)
       VALUES ('winst_expired', 'tok', 'inline', ?, '2026-09-17T04:00:00.000Z')`,
    ).run(AT);

    const deps_ = { db, nodeId: "node_local", now: () => AT };
    const ids = listRuntimeCandidates(deps_).map((entry) => entry.id);
    expect(ids).not.toContain("runtime:lease:lease_gone");
    expect(ids).not.toContain("runtime:surface:winst_expired");

    // Verification re-reads, so a claim that has expired since a selection does not verify.
    expect(verifyRuntimeCandidate(deps_, `runtime:node:node_local`)).toBe(true);
    expect(verifyRuntimeCandidate(deps_, "runtime:surface:winst_expired")).toBe(false);
  });

  it("describes candidates without paths or goals", () => {
    const deps_ = { db, nodeId: "node_local", now: () => AT };
    const described = listRuntimeCandidates(deps_).map((entry) => `${entry.label} ${entry.id}`);
    const text = described.join("\n");
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("sk-");
  });

  it("exposes find_runtime as a read-only report", async () => {
    seedTask("task_running", "running", "việc đang chạy dở");
    const tool = createFindRuntimeTool({ db, nodeId: "node_local", now: () => AT });
    const result = await tool.execute({});
    expect(result.text).toContain("việc đang chạy dở");
    // No opaque ids in the sentence the model reads to the user.
    expect(result.text).not.toContain("runtime:task:");

    const filtered = await tool.execute({ labelContains: "không có gì" });
    expect(filtered.text).toContain("Nothing matching");
  });
});
