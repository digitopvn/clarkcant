import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Instant, type MessageRecord } from "@clarkcant/contracts";
import { appendMessage, createConversation } from "@clarkcant/storage";

import { remainingBudget, type JevTransport } from "../src/jev-selector.ts";
import { indexMessages, searchSessions } from "../src/session-search.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The selector budgets the node actually wires.
 *
 * `searchDecisionBudget` returns an absolute `deadlineAt`, so a budget built once inside
 * `bootNodeServices` reads as "a two-second deadline" and behaves as "no selector, ever": from two
 * seconds of uptime every decision refuses with "the selector budget for this turn was exhausted",
 * which is indistinguishable from a provider outage and silently drops both the search decider and
 * the project finder's tie-break back to the plain ranking.
 *
 * Nothing caught it because every other test injects its own fresh budget, so all of them test the
 * decider and none of them test the wiring. These tests boot the node, advance past one deadline, and
 * then ask — which is the only shape that fails when the budget is captured at boot.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_budget" as never;
const DEADLINE_MS = 250;
const PAST_THE_DEADLINE_MS = 600;

interface Recording {
  transport: JevTransport;
  calls: () => number;
}

/** A provider that decisively picks the first result it was offered. */
function recording(): Recording {
  let calls = 0;
  return {
    calls: () => calls,
    transport: async (request) => {
      calls += 1;
      const body = request.body as {
        questions: Record<string, { type: string; criteria?: Record<string, string | null> }>;
      };
      const id = Object.keys(body.questions)[0] ?? "q";
      const question = body.questions[id];
      const options = Object.keys(question?.criteria ?? {});
      if (question?.type === "noul") {
        return { status: 200, body: { model: "jev-1.13.0", answers: { [id]: { type: "noul", noul: 0.1 } } } };
      }
      const choice = options.find((option) => option.startsWith("result:")) ?? "none";
      const probabilities: Record<string, number> = {};
      for (const option of options) probabilities[option] = option === choice ? 0.97 : 0.005;
      return { status: 200, body: { model: "jev-1.13.0", answers: { [id]: { type: "choice", choice, probabilities } } } };
    },
  };
}

let dir: string;
let services: NodeServices | undefined;
let now: number;
const envBefore: Record<string, string | undefined> = {};

function seed(text: string, id: string, at: string): void {
  const node = services;
  if (node === undefined) throw new Error("the node was not booted");
  const message: MessageRecord = {
    messageId: id as never,
    conversationId: CONVERSATION,
    role: "user",
    blocks: [{ type: "text", format: "plain", content: text, streaming: false }],
    authorNodeId: node.runtime.identity.nodeId as never,
    createdAt: at as never,
    delivery: "accepted",
  };
  appendMessage(node.runtime.db, message, 0);
  indexMessages(node.search, { conversationId: CONVERSATION, messages: [message], at: at as never });
}

function boot(jev: Recording): NodeServices {
  services = bootNodeServices({
    dataDir: dir,
    label: "budget node",
    jev: {
      config: {
        enabled: true,
        localOnly: false,
        apiKey: "sk-test-not-a-real-key",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        endpointRefusal: undefined,
        model: "jev-1.13.0",
        maxCallsPerTurn: 2,
      },
      transport: jev.transport,
    },
  });
  createConversation(services.runtime.db, {
    conversationId: CONVERSATION as never,
    homeNodeId: services.runtime.identity.nodeId as never,
    title: "budget",
    at: AT,
  });
  return services;
}

beforeEach(() => {
  now = Date.parse(AT);
  // Control deadline age without replacing the async timers used by selector requests.
  vi.spyOn(Date, "now").mockImplementation(() => now);
  dir = mkdtempSync(join(tmpdir(), "clarkcant-budget-"));
  for (const key of ["CLARKCANT_JEV_SEARCH_TIMEOUT_MS", "CLARKCANT_SEARCH_DECIDER"]) {
    envBefore[key] = process.env[key];
  }
  // The configured decision deadline is shorter than the clock advance after boot.
  process.env.CLARKCANT_JEV_SEARCH_TIMEOUT_MS = String(DEADLINE_MS);
  process.env.CLARKCANT_SEARCH_DECIDER = "jev";
});

afterEach(() => {
  vi.restoreAllMocks();
  services?.runtime.close();
  services = undefined;
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("the budgets the node wires for its selectors", () => {
  it("hands the search decider a budget that is still open long after boot", async () => {
    const jev = recording();
    const node = boot(jev);
    // Two messages a keyword search cannot separate, so the decision path is actually entered.
    seed("sửa lỗi đăng nhập token hết hạn", "msg_login_a", "2026-09-16T02:00:00.000Z");
    seed("sửa lỗi đăng nhập không vào được", "msg_login_b", "2026-09-15T02:00:00.000Z");

    now += PAST_THE_DEADLINE_MS;

    // Read through the same accessor a search uses, so a budget captured at boot is visible here.
    const decider = node.search.decider;
    expect(decider).toBeDefined();
    if (decider === undefined) return;
    expect(remainingBudget(decider.jev, decider.budget())).toBeGreaterThan(0);

    const outcome = await searchSessions(node.search, { text: "sửa lỗi đăng nhập", limit: 5 });

    // The provider was actually reached: a boot-time budget answers "budget exhausted" and never
    // calls, which is the whole defect.
    expect(jev.calls()).toBeGreaterThan(0);
    expect(outcome.mode).toBe("jev");
    expect(outcome.chosen).toBeDefined();
  });

  it("hands the project finder a budget that is still open long after boot", () => {
    const node = boot(recording());
    now += PAST_THE_DEADLINE_MS;

    // The finder's candidates depend on a scan, so this asserts the property the scan depends on:
    // the wired budget has time left, so a lookup that needs a decision can still make one.
    const decider = node.projects.decider;
    expect(decider).toBeDefined();
    if (decider === undefined) return;
    expect(remainingBudget(decider.jev, decider.budget())).toBeGreaterThan(0);
  });
});
