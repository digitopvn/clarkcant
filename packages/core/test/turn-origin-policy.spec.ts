import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  TURN_ORIGINS,
  type EffectCategory,
  type ExecutionMode,
  type ExecutionPolicyConfig,
  type IntentOrigin,
  type TurnOrigin,
  parseExecutionPolicyConfig,
} from "@clarkcant/contracts";

import { decideExecution, executionIntentOf, turnOriginOfIntent } from "../src/execution-policy.ts";

/**
 * Who started a turn, as the policy sees it.
 *
 * The owner's decision is "treat it like the person, only record the origin": with the default policy a turn an AI
 * client started over MCP, a relay, or a script over the CLI or API decides exactly as the person's own message does.
 * The stricter choice is opt-in, and asks only before a risky effect such a turn causes.
 */

const DIGEST = "sha256:0123456789abcdef0123456789abcdef01234567";
const CATEGORIES: readonly EffectCategory[] = [
  "read",
  "local-write",
  "external-write",
  "destructive",
  "financial",
  "communication",
  "media-capture",
];
const RISKY: readonly EffectCategory[] = ["external-write", "destructive", "financial", "communication", "media-capture"];
const MODES: readonly ExecutionMode[] = ["autonomous", "guarded", "ask"];
const MACHINE: readonly TurnOrigin[] = ["mcp", "relay", "cli-api"];

function policy(overrides: Partial<ExecutionPolicyConfig> = {}): ExecutionPolicyConfig {
  return { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...overrides };
}

function decide(config: ExecutionPolicyConfig, category: EffectCategory, origin: TurnOrigin | undefined) {
  return decideExecution({
    policy: config,
    action: { kind: "effect", category, operationDigest: DIGEST },
    intent: origin === undefined ? { kind: "interactive" } : { kind: "interactive", origin },
  });
}

describe("with the default policy, every origin on this node decides as the person does", () => {
  it("answers the same for every mode, category and origin", () => {
    for (const mode of MODES) {
      for (const category of CATEGORIES) {
        const person = decide(policy({ mode }), category, "person");
        // An external channel's sender is not someone at this node; their turns are decided below.
        for (const origin of TURN_ORIGINS.filter((each) => each !== "channel")) {
          expect(decide(policy({ mode }), category, origin), `${mode} ${category} ${origin}`).toEqual(person);
        }
        // An interactive turn with no recorded origin is the person's too.
        expect(decide(policy({ mode }), category, undefined), `${mode} ${category} unrecorded`).toEqual(person);
      }
    }
  });

  it("is the default an absent or explicit `as-person` setting means", () => {
    expect(DEFAULT_EXECUTION_POLICY_CONFIG.machineTurns).toBeUndefined();
    const explicit = policy({ machineTurns: "as-person", mode: "autonomous" });
    for (const category of CATEGORIES) {
      expect(decide(explicit, category, "mcp")).toEqual(decide(policy({ mode: "autonomous" }), category, "person"));
    }
  });
});

describe("with the opt-in, a machine-surface turn asks before a risky effect", () => {
  it("asks for every risky category from MCP, a relay and the CLI or API, in a mode that would have run it", () => {
    for (const origin of MACHINE) {
      for (const category of RISKY) {
        const decision = decide(policy({ mode: "autonomous", machineTurns: "ask" }), category, origin);
        expect(decision.kind, `${origin} ${category}`).toBe("ask");
      }
    }
  });

  it("names who asked in the reason", () => {
    const decision = decide(policy({ mode: "autonomous", machineTurns: "ask" }), "external-write", "mcp");
    expect(decision.kind).toBe("ask");
    expect(JSON.stringify(decision)).toMatch(/MCP/);
  });

  it("leaves a read and a local write alone, as the person's own turn would", () => {
    for (const origin of MACHINE) {
      for (const category of ["read", "local-write"] as const) {
        expect(decide(policy({ mode: "autonomous", machineTurns: "ask" }), category, origin).kind).toBe("execute");
      }
    }
  });

  it("does not change the person's own turns, automations or peers", () => {
    const strict = policy({ mode: "autonomous", machineTurns: "ask" });
    for (const category of RISKY) {
      expect(decide(strict, category, "person").kind).toBe("execute");
      expect(decide(strict, category, undefined).kind).toBe("execute");
      expect(decide(strict, category, "automation")).toEqual(decide(policy({ mode: "autonomous" }), category, "automation"));
      expect(decide(strict, category, "peer")).toEqual(decide(policy({ mode: "autonomous" }), category, "peer"));
    }
  });

  it("never loosens a deny or a prohibition", () => {
    const denied = policy({
      mode: "autonomous",
      machineTurns: "ask",
      rules: [{ effectCategory: "destructive", decision: "deny" }],
    });
    expect(decide(denied, "destructive", "mcp").kind).toBe("deny");
    const prohibited = policy({ mode: "autonomous", machineTurns: "ask", prohibition: "all" });
    expect(decide(prohibited, "external-write", "cli-api").kind).toBe("deny");
  });
});

describe("the setting is part of the one policy", () => {
  it("is kept only when it asks for more", () => {
    expect(parseExecutionPolicyConfig({ ...DEFAULT_EXECUTION_POLICY_CONFIG, machineTurns: "ask" }).machineTurns).toBe("ask");
    expect(parseExecutionPolicyConfig({ ...DEFAULT_EXECUTION_POLICY_CONFIG, machineTurns: "as-person" }).machineTurns).toBeUndefined();
    expect(parseExecutionPolicyConfig({ ...DEFAULT_EXECUTION_POLICY_CONFIG, machineTurns: "never" }).machineTurns).toBeUndefined();
  });
});

describe("a task carries its turn's origin to the policy", () => {
  it("reads the origin out of an interactive task, and names automations and peers", () => {
    const interactive = { kind: "interactive", principalId: "p", turnOrigin: "mcp" } as IntentOrigin;
    expect(executionIntentOf(interactive)).toEqual({ kind: "interactive", origin: "mcp" });
    expect(turnOriginOfIntent(interactive)).toBe("mcp");
    expect(executionIntentOf({ kind: "interactive", principalId: "p" } as IntentOrigin)).toEqual({ kind: "interactive" });
    expect(turnOriginOfIntent({ kind: "persistent", allowedCategories: [] } as unknown as IntentOrigin)).toBe("automation");
    expect(turnOriginOfIntent({ kind: "delegated", allowedCategories: [] } as unknown as IntentOrigin)).toBe("peer");
    expect(turnOriginOfIntent(undefined)).toBeUndefined();
  });
});

describe("a turn a message on an external channel started", () => {
  function channel(config: ExecutionPolicyConfig, category: EffectCategory, granted?: readonly EffectCategory[]) {
    return decideExecution({
      policy: config,
      action: { kind: "effect", category, operationDigest: DIGEST },
      intent: { kind: "interactive", origin: "channel", ...(granted === undefined ? {} : { channelAllowedCategories: granted }) },
    });
  }

  it("asks the owner before a risky effect no grant on the channel covers, in every mode", () => {
    for (const mode of MODES) {
      for (const category of RISKY) {
        const decision = channel(policy({ mode }), category);
        expect(decision.kind, `${mode} ${category}`).toBe("ask");
        expect(JSON.stringify(decision)).toMatch(/external channel/);
      }
    }
  });

  it("is not refused for who sent it: reads and local work decide as the person's own turn", () => {
    for (const mode of MODES) {
      for (const category of ["read", "local-write"] as const) {
        expect(channel(policy({ mode }), category)).toEqual(decide(policy({ mode }), category, "person"));
      }
    }
  });

  it("runs a risky effect a standing grant on the channel covers as the mode would", () => {
    expect(channel(policy({ mode: "autonomous" }), "external-write", ["external-write"]).kind).toBe("execute");
    expect(channel(policy({ mode: "autonomous" }), "financial", ["external-write"]).kind).toBe("ask");
  });

  it("never loosens a deny or a prohibition, granted or not", () => {
    const denied = policy({ mode: "autonomous", rules: [{ effectCategory: "communication", decision: "deny" }] });
    expect(channel(denied, "communication", ["communication"]).kind).toBe("deny");
    expect(channel(policy({ mode: "autonomous", prohibition: "all" }), "external-write", ["external-write"]).kind).toBe("deny");
  });
});
