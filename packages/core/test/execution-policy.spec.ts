import { beforeEach, describe, expect, it } from "vitest";

import type { EffectCategory, ExecutionMode, ExecutionRule } from "@clarkcant/contracts";
import { migrate, openDatabase, allRows } from "@clarkcant/storage";

import { decideExecution, recordEffectExecution } from "../src/execution-policy.ts";

/**
 * The execution policy (V18).
 *
 * The table below is the whole policy, and it is asserted as a table on purpose: the failure this
 * guards against is a mode that behaves differently from what the settings surface promises, which is
 * a difference nobody notices one cell at a time. Ask mode is asserted against the behaviour that
 * existed before this module: every effect produces an approval card, unchanged.
 */

const DIGEST = "sha256:0123456789abcdef0123456789abcdef01234567";

const RISKY: readonly EffectCategory[] = [
  "external-write",
  "destructive",
  "financial",
  "communication",
  "media-capture",
];
const ALL_CATEGORIES: readonly EffectCategory[] = ["read", "local-write", ...RISKY];

function effect(category: EffectCategory) {
  return { kind: "effect" as const, category, operationDigest: DIGEST };
}

function outcome(
  mode: ExecutionMode,
  category: EffectCategory,
  options: { explicitUserIntent?: boolean; rules?: readonly ExecutionRule[] } = {},
): string {
  return decideExecution({
    mode,
    rules: options.rules ?? [],
    action: effect(category),
    explicitUserIntent: options.explicitUserIntent ?? false,
  }).kind;
}

describe("a local view action is not an effect", () => {
  it("never asks, in any mode", () => {
    for (const mode of ["autonomous", "guarded", "ask"] as const) {
      const decision = decideExecution({ mode, rules: [], action: { kind: "view" }, explicitUserIntent: false });
      expect(decision.kind, mode).toBe("execute");
      if (decision.kind !== "execute") throw new Error("expected an execution");
      // A filter change is not an effect, so it leaves no audit trail to wade through.
      expect(decision.audit).toBe(false);
    }
  });
});

describe("ask mode asks before every effect", () => {
  it("produces an approval card for every category, asked for or not", () => {
    for (const category of ALL_CATEGORIES) {
      expect(outcome("ask", category), category).toBe("ask");
      expect(outcome("ask", category, { explicitUserIntent: true }), `${category} explicit`).toBe("ask");
    }
  });

  it("binds the approval to the digest and the category", () => {
    const decision = decideExecution({
      mode: "ask",
      rules: [],
      action: effect("local-write"),
      explicitUserIntent: true,
    });
    if (decision.kind !== "ask") throw new Error("expected an approval");
    expect(decision.approvalSpec).toMatchObject({
      effectCategory: "local-write",
      operationDigest: DIGEST,
    });
    expect(decision.approvalSpec.hardBoundary).toBeUndefined();
  });

  it("is not loosened by a rule that allows", () => {
    // Ask every time is the strictest mode. A rule may refuse; nothing may make it stop asking.
    const rules: ExecutionRule[] = [{ effectCategory: "destructive", decision: "execute" }];
    expect(outcome("ask", "destructive", { rules })).toBe("ask");
  });
});

describe("guarded mode asks where the category or a rule requires it", () => {
  it("performs the two categories that stay on this machine", () => {
    expect(outcome("guarded", "read")).toBe("execute");
    expect(outcome("guarded", "local-write")).toBe("execute");
  });

  it("asks before every category that reaches past it", () => {
    for (const category of RISKY) {
      expect(outcome("guarded", category), category).toBe("ask");
      expect(outcome("guarded", category, { explicitUserIntent: true }), `${category} explicit`).toBe("ask");
    }
  });

  it("lets a rule allow a category it would otherwise ask about", () => {
    const rules: ExecutionRule[] = [{ effectCategory: "external-write", decision: "execute" }];
    expect(outcome("guarded", "external-write", { rules })).toBe("execute");
  });

  it("lets a rule ask about a category it would otherwise perform", () => {
    const rules: ExecutionRule[] = [{ effectCategory: "local-write", decision: "ask" }];
    expect(outcome("guarded", "local-write", { rules })).toBe("ask");
  });
});

describe("autonomous mode executes the user's own instruction", () => {
  it("performs everything that stays on this machine", () => {
    for (const category of ["read", "local-write"] as const) {
      const decision = decideExecution({
        mode: "autonomous",
        rules: [],
        action: effect(category),
        explicitUserIntent: false,
      });
      expect(decision.kind, category).toBe("execute");
      if (decision.kind !== "execute") throw new Error("expected an execution");
      expect(decision.audit, category).toBe(true);
    }
  });

  it("performs a risky effect the user asked for", () => {
    for (const category of RISKY) {
      expect(outcome("autonomous", category, { explicitUserIntent: true }), category).toBe("execute");
    }
  });

  it("asks before a risky effect the agent chose on its own", () => {
    // The difference between carrying out an instruction and taking an initiative: autonomy is not a
    // promise to send mail nobody asked for.
    for (const category of RISKY) {
      expect(outcome("autonomous", category, { explicitUserIntent: false }), category).toBe("ask");
    }
  });

  it("honours a rule that asks, even for a category it would perform", () => {
    const rules: ExecutionRule[] = [{ effectCategory: "local-write", decision: "ask" }];
    expect(outcome("autonomous", "local-write", { rules })).toBe("ask");
  });
});

describe("two decisions hold in every mode", () => {
  it("refuses what a rule refuses", () => {
    const rules: ExecutionRule[] = [{ effectCategory: "destructive", decision: "deny" }];
    for (const mode of ["autonomous", "guarded", "ask"] as const) {
      expect(outcome(mode, "destructive", { rules }), mode).toBe("deny");
    }
  });

  it("asks at a hard boundary even when the user asked and a rule allows", () => {
    // An OS permission prompt, an OAuth grant, a browser device permission and a vendor's consent
    // screen are not this application's decisions to make, so no mode lifts them.
    const rules: ExecutionRule[] = [{ effectCategory: "media-capture", decision: "execute" }];
    for (const mode of ["autonomous", "guarded", "ask"] as const) {
      const decision = decideExecution({
        mode,
        rules,
        action: effect("media-capture"),
        explicitUserIntent: true,
        hardBoundary: { kind: "os-permission", because: "macOS asks before a microphone is used" },
      });
      expect(decision.kind, mode).toBe("ask");
      if (decision.kind !== "ask") throw new Error("expected an approval");
      expect(decision.approvalSpec.hardBoundary).toBe("os-permission");
      expect(decision.approvalSpec.because).toContain("microphone");
    }
  });
});

describe("the audit is the record autonomy would otherwise not leave", () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    migrate(db);
  });

  it("appends one event naming the mode, the category and the digest", () => {
    const decision = decideExecution({
      mode: "autonomous",
      rules: [],
      action: effect("local-write"),
      explicitUserIntent: true,
    });
    if (decision.kind !== "execute") throw new Error("expected an execution");

    let counter = 0;
    recordEffectExecution(
      { db, nodeId: "node_1", newId: (prefix) => `${prefix}_${++counter}`, now: () => "2026-09-16T06:00:00.000Z" as never },
      {
        principalId: "prin_owner",
        mode: "autonomous",
        decision,
        category: "local-write",
        operationDigest: DIGEST,
        conversationId: "conv_1",
        description: "git status",
      },
    );

    const rows = allRows<{ kind: string; stream: string; document: string; conversation_id: string }>(
      db,
      "SELECT kind, stream, document, conversation_id FROM events",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("effect.executed");
    expect(rows[0]?.stream).toBe("activity");
    expect(rows[0]?.conversation_id).toBe("conv_1");
    expect(JSON.parse(rows[0]?.document ?? "{}")).toMatchObject({
      principalId: "prin_owner",
      mode: "autonomous",
      category: "local-write",
      operationDigest: DIGEST,
      approvedBy: "policy",
      description: "git status",
    });
  });
});
