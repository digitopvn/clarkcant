import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityDescriptor, Instant, MessageRecord } from "@clarkcant/contracts";
import { registerCapability } from "@clarkcant/core";
import { createConversation } from "@clarkcant/storage";

import type { JevConfig, JevTransport } from "../src/jev-selector.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { handleUserMessage } from "@clarkcant/core";

/**
 * Route A, wired (Phase 9).
 *
 * `decideRuntimeTarget` was written, tested and calibrated, and then never asked anything in
 * production: the conductor's `chooseExecutionNode` seam existed and `services.ts` never filled it.
 * Every test here goes through `bootNodeServices` and a real `handleUserMessage`, so the seam being
 * empty is the failure this file exists to catch.
 *
 * The three things that have to hold are the ones the plan names: a real choice is asked about and
 * the answer is used, an unavailable selector leaves the deterministic order alone, and a target
 * that cannot be re-read from the registry when the answer arrives is never dispatched to.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;

/** A capability that is genuinely usable, so the conductor has a choice rather than a shortage. */
function capability(ref: string, executionNodeId: string): CapabilityDescriptor {
  return {
    ref: ref as CapabilityDescriptor["ref"],
    executionNodeId: executionNodeId as CapabilityDescriptor["executionNodeId"],
    summary: `làm ${ref}`,
    resourceKinds: ["file"],
    effectCategory: "read",
    supportsCancellation: true,
    requiresConnection: false,
    readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
    uiAffordances: [],
  };
}

interface FakeProvider {
  transport: JevTransport;
  calls: number;
  bodies: unknown[];
}

interface ProviderScript {
  /** Which option to answer with, given the options actually offered. */
  choose: (options: string[]) => string;
  /** Runs before the response is returned, so a test can move the world mid-decision. */
  whileThinking?: () => void;
  /** A non-200 status, to exercise the unavailable path. */
  status?: number;
  /** Delay before answering, to exercise the deadline. */
  delayMs?: number;
}

/**
 * A provider that answers the routing question from the request it was actually sent.
 *
 * Probabilities are built from the question's own criteria rather than hardcoded, because a Choice
 * whose distribution omits an option is reported as an abstention — a fake that only lists the
 * winner would silently test the fallback path instead of the decision path.
 */
function provider(script: ProviderScript): FakeProvider {
  const fake: FakeProvider = {
    calls: 0,
    bodies: [],
    transport: async (request) => {
      fake.calls += 1;
      fake.bodies.push(request.body);
      const body = request.body as { questions: Record<string, { type: string; criteria?: Record<string, string | null> }> };
      const id = Object.keys(body.questions)[0] ?? "q";
      const criteria = body.questions[id]?.criteria ?? {};
      const options = Object.keys(criteria);
      const choice = script.choose(options);
      script.whileThinking?.();
      if (script.delayMs !== undefined) {
        // Honours the signal the selector passes, like fetch does. A transport that ignored the abort
        // would leave the request running and the test would prove nothing about the deadline.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, script.delayMs);
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      }
      if (script.status !== undefined && script.status !== 200) {
        return { status: script.status, body: { error: "refused" } };
      }
      const probabilities: Record<string, number> = {};
      for (const option of options) {
        probabilities[option] = option === choice ? 0.97 : options.length > 1 ? 0.005 : 0.5;
      }
      return {
        status: 200,
        body: { model: "jev-1.13.0", answers: { [id]: { type: "choice", choice, probabilities } } },
      };
    },
  };
  return fake;
}

let dir: string;
let services: NodeServices | undefined;
let timeoutBefore: string | undefined;

function boot(fake: FakeProvider, overrides: Partial<JevConfig> = {}): NodeServices {
  services = bootNodeServices({
    dataDir: dir,
    label: "routing node",
    jev: {
      config: {
        enabled: true,
        localOnly: false,
        apiKey: "sk-test-not-a-real-key",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        endpointRefusal: undefined,
        model: "jev-1.13.0",
        maxCallsPerTurn: 2,
        ...overrides,
      },
      transport: fake.transport,
    },
  });
  return services;
}

/**
 * Two capabilities on two different nodes, so the dispatch message names which one was chosen.
 *
 * `listCapabilitySummaries` orders by capability ref, so the deterministic first candidate is
 * `project.code.change@1` on this node and the selector's answer is only visible if the other one
 * wins.
 */
function registerBoth(node: NodeServices): { thisNode: string; otherNode: string } {
  const thisNode = node.runtime.identity.nodeId;
  const otherNode = "node_other";
  const db = node.runtime.db;
  registerCapability({ db, nodeId: thisNode }, capability("project.code.change@1", thisNode));
  registerCapability({ db, nodeId: thisNode }, capability("project.file.read@1", otherNode));
  createConversation(db, { conversationId: "conv_route" as never, homeNodeId: thisNode as never, title: "route A", at: AT });
  return { thisNode, otherNode };
}

async function ask(node: NodeServices, text = "sửa file này giúp tui"): Promise<MessageRecord[]> {
  const outcome = await handleUserMessage(node.conductor, {
    conversationId: "conv_route" as never,
    principal: {
      principalId: node.runtime.identity.ownerPrincipalId as never,
      kind: "user",
      nodeId: node.runtime.identity.nodeId as never,
    },
    text,
    at: AT,
  });
  return outcome.messages;
}

function rendered(messages: MessageRecord[]): string {
  return JSON.stringify(messages);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-routing-"));
  timeoutBefore = process.env.CLARKCANT_JEV_SEARCH_TIMEOUT_MS;
});

afterEach(() => {
  services?.runtime.close();
  services = undefined;
  if (timeoutBefore === undefined) delete process.env.CLARKCANT_JEV_SEARCH_TIMEOUT_MS;
  else process.env.CLARKCANT_JEV_SEARCH_TIMEOUT_MS = timeoutBefore;
  rmSync(dir, { recursive: true, force: true });
});

describe("route A: choosing between usable capabilities", () => {
  it("asks the selector when there is a real choice, and dispatches to what it chose", async () => {
    const fake = provider({ choose: (options) => options.find((option) => option.endsWith("@node_other")) ?? "none" });
    const node = boot(fake);
    const { otherNode } = registerBoth(node);

    const messages = await ask(node);

    // Asked exactly once, and the answer decided where the work went.
    expect(fake.calls).toBe(1);
    expect(rendered(messages)).toContain(otherNode);
  });

  it("describes candidates with registry metadata only, never user text", async () => {
    const fake = provider({ choose: (options) => options.find((option) => option.endsWith("@node_other")) ?? "none" });
    const node = boot(fake);
    registerBoth(node);

    await ask(node, "sửa file /Users/someone/secret-project giúp tui");
    const sent = JSON.stringify(fake.bodies);

    // The capability summary and effect class are what the selector chooses with; the user's own
    // sentence is redacted down to the intent and no path, goal or label travels with it.
    expect(sent).toContain("project.file.read@1");
    expect(sent).toContain("read");
    expect(sent).not.toContain("/Users/someone/secret-project");
    expect(sent).not.toContain("đang giữ");
  });

  it("keeps the deterministic order when the selector is unavailable", async () => {
    const fake = provider({ choose: () => "none", status: 429 });
    const node = boot(fake);
    const { thisNode, otherNode } = registerBoth(node);

    const messages = await ask(node);

    // It tried, was refused, and the ranking stands — a fallback is not reported as a choice.
    expect(fake.calls).toBe(1);
    expect(rendered(messages)).toContain(thisNode);
    expect(rendered(messages)).not.toContain(otherNode);
  });

  it("does not call the provider at all when it is switched off", async () => {
    const fake = provider({ choose: () => "none" });
    const node = boot(fake, { enabled: false, apiKey: undefined });
    const { thisNode, otherNode } = registerBoth(node);

    const messages = await ask(node);

    expect(fake.calls).toBe(0);
    expect(rendered(messages)).toContain(thisNode);
    expect(rendered(messages)).not.toContain(otherNode);
  });

  it("keeps the deterministic order when the selector is slower than the deadline", async () => {
    process.env.CLARKCANT_JEV_SEARCH_TIMEOUT_MS = "25";
    const fake = provider({
      choose: (options) => options.find((option) => option.endsWith("@node_other")) ?? "none",
      delayMs: 250,
    });
    const node = boot(fake);
    const { thisNode, otherNode } = registerBoth(node);

    const messages = await ask(node);

    // The decision deadline is a real deadline: a slow selector costs the ranking, not the turn.
    expect(rendered(messages)).toContain(thisNode);
    expect(rendered(messages)).not.toContain(otherNode);
  });

  it("does not dispatch to something the selector named but was never offered", async () => {
    const fake = provider({ choose: () => "project.file.write@1@node_other" });
    const node = boot(fake);
    const { thisNode, otherNode } = registerBoth(node);

    const messages = await ask(node);

    expect(fake.calls).toBe(1);
    expect(rendered(messages)).toContain(thisNode);
    expect(rendered(messages)).not.toContain(otherNode);
  });

  it("does not dispatch to a candidate that stopped being usable while the selector was thinking", async () => {
    const fake = provider({
      choose: (options) => options.find((option) => option.endsWith("@node_other")) ?? "none",
      // The world moves mid-decision: the capability the selector is about to name is unloaded.
      whileThinking: () => {
        const node = services;
        if (node === undefined) return;
        registerCapability(
          { db: node.runtime.db, nodeId: node.runtime.identity.nodeId },
          {
            ...capability("project.file.read@1", "node_other"),
            readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: false },
          },
        );
      },
    });
    const node = boot(fake);
    const { thisNode, otherNode } = registerBoth(node);

    const messages = await ask(node);

    // Re-read from the registry, so a selection that is no longer real falls back instead of
    // dispatching work to a capability the node no longer offers.
    expect(fake.calls).toBe(1);
    expect(rendered(messages)).toContain(thisNode);
    expect(rendered(messages)).not.toContain(otherNode);
  });
});
