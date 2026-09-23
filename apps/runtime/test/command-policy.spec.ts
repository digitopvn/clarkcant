import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ExecutionPolicyConfig,
  type Instant,
  type MessageBlock,
} from "@clarkcant/contracts";
import type { CoordinationDeps } from "@clarkcant/core";
import { decideExecution, guardrailCovers } from "@clarkcant/core";
import { migrate, openDatabase, nodeStoreSecretBackend, putSecretMetadata, type Database } from "@clarkcant/storage";

import { commandDigest, type CommandOutcome } from "../src/run-command.ts";
import type { InteractionDeps } from "../src/interactions.ts";
import type { SecretBroker } from "../src/secret-broker.ts";
import { createSecretBroker } from "../src/secret-broker.ts";
import type { OperationGuardOutcome } from "../src/jev-decider.ts";
import { createRunCommandTool } from "../src/node-tools.ts";
import { ownedResources } from "../src/preflight.ts";

/**
 * The command path under the one execution policy.
 *
 * This is the change the whole architecture turns on: a command runs without a person approving it, and
 * what keeps that defensible is visible here rather than asserted in prose. Every refusal below is a case
 * where the host said no — outside the folders it owns, a node-wide refusal, a rule the user wrote, a
 * guardrail that refused, a guardrail that could not be reached on a node configured to fail closed.
 *
 * The policy the tool reads is the canonical one, supplied by the node's own reader. The cases that used to
 * assert the four-value command policy — `auto`, `guarded`, `confirm`, `deny` and the class switches — now
 * assert the canonical axes that replaced it (mode, prohibition, guardrails), because those are the settings
 * a person can actually change.
 */
let dir: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-command-"));
  work = join(dir, "work");
  mkdirSync(work, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function outcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return { exitCode: 0, stdout: "built ok", stderr: "", durationMs: 12, timedOut: false, ...overrides };
}

function policy(overrides: Partial<ExecutionPolicyConfig> = {}): ExecutionPolicyConfig {
  return { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...overrides };
}

function makeTool(options: {
  policy?: Partial<ExecutionPolicyConfig>;
  guard?: OperationGuardOutcome | ((input: unknown) => Promise<OperationGuardOutcome>);
  approvals?: () => CoordinationDeps;
  interactions?: InteractionDeps;
  broker?: SecretBroker;
  resolveFolder?: (intent: string) => Promise<
    | { status: "resolved"; cwd: string; relPath: string }
    | { status: "ask"; message: string; options: readonly string[] }
  >;
} = {}): {
  tool: ReturnType<typeof createRunCommandTool>;
  runs: { command: string; cwd: string; timeoutMs: number; maxOutputBytes: number; env?: Record<string, string> }[];
  guardCalls: () => number;
} {
  const runs: { command: string; cwd: string; timeoutMs: number; maxOutputBytes: number; env?: Record<string, string> }[] = [];
  let guardCalls = 0;
  const inForce: ExecutionPolicyConfig = {
    ...DEFAULT_EXECUTION_POLICY_CONFIG,
    ...options.policy,
    guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails, ...options.policy?.guardrails },
  };

  const tool = createRunCommandTool({
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    autonomy: () => inForce,
    resources: () => ownedResources([work]),
    fallbackCwd: () => work,
    guardrails: async (input) => {
      guardCalls += 1;
      if (typeof options.guard === "function") return await options.guard(input);
      return options.guard ?? { status: "allow" };
    },
    narrowing: [{ id: "timeout-30s", description: "chạy tối đa 30 giây", constraint: { kind: "timeout-ms", value: 30_000 } }],
    newId: () => "run_test_1",
    ...(options.broker === undefined ? {} : { broker: options.broker }),
    ...(options.interactions === undefined ? {} : { interactions: options.interactions }),
    ...(options.resolveFolder === undefined ? {} : { resolveFolder: options.resolveFolder }),
    run: async (request) => {
      runs.push(request);
      return outcome();
    },
  });
  return { tool, runs, guardCalls: () => guardCalls };
}

describe("which policy applies", () => {
  it("judges a command that changes something, and never judges a read", () => {
    // The switch is per guard class, and it is the authority for whether the judgment layer is consulted — a
    // different question from which mode is in force.
    expect(guardrailCovers(policy(), { surface: "command", effectCategory: "local-write" })).toBe(true);
    expect(guardrailCovers(policy(), { surface: "command", effectCategory: "read" })).toBe(false);
  });

  it("treats a node-wide prohibition as a refusal of every category", () => {
    const denied = policy({ prohibition: "all" });
    for (const category of ["read", "local-write", "external-write", "financial"] as const) {
      expect(
        decideExecution({
          policy: denied,
          action: { kind: "effect", category, operationDigest: "sha256:x" },
          explicitUserIntent: true,
        }).kind,
        category,
      ).toBe("deny");
    }
  });

  it("skips the judgment layer when it is switched off, and when the class is not covered", () => {
    const off = policy({ guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails, enabled: false } });
    expect(guardrailCovers(off, { surface: "command", effectCategory: "local-write" })).toBe(false);
    const otherClasses = policy({ guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails, classes: ["financial"] } });
    expect(guardrailCovers(otherClasses, { surface: "command", effectCategory: "local-write" })).toBe(false);
  });
});

describe("running a command under the default policy", () => {
  it("runs it, records what happened, and hands the output back in the same turn", async () => {
    const { tool, runs } = makeTool({ guard: { status: "allow" } });
    const answer = await tool.execute({ command: "pnpm build" });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.cwd).toBe(work);
    expect(answer.text).toContain("built ok");
    expect(answer.text).toContain("thoát với mã 0");
    // No card: nobody is being asked, which is the whole point of the default.
    expect(answer.hostCard).toBeUndefined();
    expect(answer.hostBlocks?.map((block) => block.type)).toEqual(["tool-activity", "evidence"]);
  });

  it("carries the narrowed budget into the run", async () => {
    const { tool, runs } = makeTool({ guard: { status: "constrain", constraintId: "timeout-30s", reason: "thu hẹp" } });
    const answer = await tool.execute({ command: "pnpm build" });

    expect(runs[0]?.timeoutMs).toBe(30_000);
    expect(answer.text).toContain("built ok");
  });

  it("does not consult the policy layer at all under auto", async () => {
    const { tool, runs, guardCalls } = makeTool({
      policy: { guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails, enabled: false } },
    });
    await tool.execute({ command: "pnpm build" });
    expect(guardCalls()).toBe(0);
    expect(runs).toHaveLength(1);
  });

  it("does not consult it for a class the person switched off", async () => {
    const { tool, runs, guardCalls } = makeTool({
      policy: { guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails, classes: ["financial"] } },
    });
    await tool.execute({ command: "pnpm build" });
    expect(guardCalls()).toBe(0);
    expect(runs).toHaveLength(1);
  });

  it("does not consult it for a read, even one that reaches the network", async () => {
    /*
     * What a command does decides which switch governs it. A fetch used to be classified `external-write` — one of the
     * risky categories — so the guardrail judged an ordinary read and refused it, which is what a person reported as the
     * guardrails being too strict, with nothing they could do about it. The default switches already say that reads are
     * not guarded.
     */
    const { tool, runs, guardCalls } = makeTool();
    await tool.execute({ command: "curl -s https://wttr.in/Ho+Chi+Minh+City?format=3" });

    expect(guardCalls()).toBe(0);
    expect(runs).toHaveLength(1);
  });

  it("still consults it for a command that changes something out there", async () => {
    const { tool, runs, guardCalls } = makeTool();
    await tool.execute({ command: "git push origin main" });

    expect(guardCalls()).toBe(1);
    expect(runs).toHaveLength(1);
  });

  it("says what the guardrail refused, and where to change it, rather than only that it refused", async () => {
    const { tool, runs } = makeTool({
      guard: { status: "deny", reason: "guardrail từ chối nhóm network, ảnh hưởng external-write", model: "test" },
    });
    const answer = await tool.execute({ command: "git push origin main" });

    expect(runs).toHaveLength(0);
    expect(answer.text).toContain("nhóm network");
    // The way out, because a refusal a person cannot act on reads as a broken feature.
    expect(answer.text).toContain("Settings → Control");
  });
});

describe("what stops a command", () => {
  it("refuses a folder this node does not own, before any policy exists", async () => {
    const { tool, runs, guardCalls } = makeTool();
    const answer = await tool.execute({ command: "pnpm build", cwd: dir });

    expect(runs).toHaveLength(0);
    expect(guardCalls()).toBe(0);
    expect(answer.text).toContain("ngoài những thư mục node này sở hữu");
  });

  it("refuses a folder that is not there", async () => {
    const { tool, runs } = makeTool();
    const answer = await tool.execute({ command: "pnpm build", cwd: join(work, "gone") });
    expect(runs).toHaveLength(0);
    expect(answer.text).toContain("không tồn tại");
  });

  it("refuses a class the node has switched off, and says where to switch it back on", async () => {
    const { tool, runs, guardCalls } = makeTool({ policy: { prohibition: "all" } });
    const answer = await tool.execute({ command: "pnpm build" });
    expect(runs).toHaveLength(0);
    expect(guardCalls()).toBe(0);
    expect(answer.text).toContain("Settings");
  });

  it("stops when the guardrail refuses", async () => {
    const { tool, runs } = makeTool({ guard: { status: "deny", reason: "không phù hợp" } });
    const answer = await tool.execute({ command: "rm -rf build" });
    expect(runs).toHaveLength(0);
    expect(answer.text).toContain("Guardrail từ chối");
  });

  it("asks rather than running when the guardrail cannot tell which target is meant, on a node that cannot ask", async () => {
    const { tool, runs } = makeTool({ guard: { status: "clarify", question: "Bạn muốn xoá project nào?" } });
    const answer = await tool.execute({ command: "rm -rf old" });
    expect(runs).toHaveLength(0);
    // No interaction manager on this node, so the question stays with the model. The card path is the test below.
    expect(answer.text).toContain("Bạn muốn xoá project nào?");
    expect(answer.text).toContain("Hỏi người dùng");
  });

  it("refuses a narrowing the host never offered", async () => {
    const { tool, runs } = makeTool({
      guard: { status: "constrain", constraintId: "timeout-9999", reason: "thu hẹp" },
    });
    const answer = await tool.execute({ command: "pnpm build" });
    expect(runs).toHaveLength(0);
    expect(answer.text).toContain("không nêu cách nào host đã cho phép");
  });
});

describe("when the policy layer cannot be reached", () => {
  const unavailable: OperationGuardOutcome = { status: "unavailable", reason: "429 from the provider" };

  it("runs anyway on the default fail-open setting", async () => {
    const { tool, runs } = makeTool({ guard: unavailable });
    await tool.execute({ command: "pnpm test" });
    // Fail-open means the judgment is missing, not the containment: this command is inside an owned
    // folder and nothing about it was refused, so there is nothing to refuse it with.
    expect(runs).toHaveLength(1);
  });

  it("refuses on a node configured to fail closed", async () => {
    const { tool, runs } = makeTool({
      guard: unavailable,
      policy: { guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails, whenUnavailable: "deny" } },
    });
    const answer = await tool.execute({ command: "pnpm test" });
    expect(runs).toHaveLength(0);
    expect(answer.text).toContain("từ chối khi Jev vắng");
  });
});

describe("a folder the finder cannot choose between", () => {
  const ambiguous = async (): Promise<{ status: "ask"; message: string; options: readonly string[] }> => ({
    status: "ask",
    message: "Bạn muốn dùng thư mục nào?",
    options: ["agentkit-old", "agentkit-v2"],
  });

  function interactionsFixture(): InteractionDeps {
    const blocks: MessageBlock[] = [];
    return {
      conversationId: "conv_1",
      now: () => "2026-09-19T10:00:00.000Z" as Instant,
      newId: (prefix) => `${prefix}_1`,
      blocks: () => blocks,
      append: ({ blocks: appended }) => blocks.push(...appended),
    };
  }

  it("becomes a question card rather than a question the model has to carry", async () => {
    const { tool, runs } = makeTool({ interactions: interactionsFixture(), resolveFolder: ambiguous });
    const answer = await tool.execute({ command: "pnpm test", where: "dự án agentkit" });

    expect(runs).toHaveLength(0);
    expect(answer.hostBlocks?.map((block) => block.type)).toEqual(["question-card"]);
    // The model is told the turn is over, not that it has an answer.
    expect(answer.text).toContain("Đã hỏi người dùng");
  });

  it("opens a question card when the guardrail cannot tell which target is meant", async () => {
    /*
     * The same judgement as the refusal next to it, held by the node instead of by the model. This is the difference
     * that matters in practice: a question the model is asked to repeat is a question that may never be asked, and the
     * answer to a card comes back as its own turn whether it was clicked or spoken.
     */
    const { tool, runs } = makeTool({
      guard: { status: "clarify", question: "Bạn muốn xoá project nào?" },
      interactions: interactionsFixture(),
    });
    const answer = await tool.execute({ command: "rm -rf old" });

    expect(runs).toHaveLength(0);
    expect(answer.hostBlocks?.map((block) => block.type)).toEqual(["question-card"]);
    expect((answer.hostBlocks?.[0] as { prompt?: string }).prompt).toContain("Bạn muốn xoá project nào?");
    expect(answer.text).toContain("Đừng nói là đã chạy");
  });

  it("falls back to a question for the model when the node cannot ask", async () => {
    const { tool } = makeTool({ resolveFolder: ambiguous });
    const answer = await tool.execute({ command: "pnpm test", where: "dự án agentkit" });
    expect(answer.hostBlocks).toBeUndefined();
    expect(answer.text).toContain("Hãy chọn một thư mục");
  });
});

describe("a secret injected for one command", () => {
  const SECRET_VALUE = "fixture-value-that-must-stay-in-the-child";

  function seededBroker(): { broker: SecretBroker; close: () => void } {
    const secretDir = mkdtempSync(join(tmpdir(), "clarkcant-command-secret-"));
    const database = openDatabase({ path: join(secretDir, "node.sqlite") });
    migrate(database);
    putSecretMetadata(database, {
      secretId: "secret_github_token",
      principalId: "owner_1",
      name: "github_token",
      description: "GitHub PAT",
      kind: "token",
      backend: "node-store",
      backendRef: "github_token",
      allowedConsumers: ["command:git"],
      injectionPolicy: "process-env",
      at: "2026-09-19T10:00:00.000Z" as Instant,
    });
    nodeStoreSecretBackend(database, "owner_1").write("github_token", SECRET_VALUE, "2026-09-19T10:00:00.000Z" as Instant);
    return {
      broker: createSecretBroker({ db: database, principalId: "owner_1", now: () => "2026-09-19T10:00:00.000Z" as Instant }),
      close: () => {
        database.close();
        rmSync(secretDir, { recursive: true, force: true });
      },
    };
  }

  it("puts it in the child's environment and nowhere in the receipt", async () => {
    const seeded = seededBroker();
    try {
      const { tool, runs } = makeTool({ broker: seeded.broker });
      const answer = await tool.execute({ command: "git push origin main", secretRef: "github_token" });

      // The consumer is derived from the command, so this is the injection a `command:git` allowlist permits.
      expect(runs[0]?.env).toEqual({ GITHUB_TOKEN: SECRET_VALUE });
      // And the value is nowhere in what the turn records or hands back to the model.
      expect(JSON.stringify(answer)).not.toContain(SECRET_VALUE);
    } finally {
      seeded.close();
    }
  });

  it("refuses a secret whose consumer does not cover this command", async () => {
    const seeded = seededBroker();
    try {
      const { tool, runs } = makeTool({ broker: seeded.broker });
      const answer = await tool.execute({ command: "curl https://example.test", secretRef: "github_token" });
      expect(runs).toHaveLength(0);
      expect(answer.text).toContain("không cho phép");
      expect(answer.text).not.toContain(SECRET_VALUE);
    } finally {
      seeded.close();
    }
  });
});

/**
 * An asking mode judges before it asks.
 *
 * The judgment layer runs before the card, and this is the case that makes the order matter: `ask` is the most
 * restrictive mode, so a card alone would let the categories the user wrote instructions about run un-narrowed and
 * un-refused as soon as somebody approved it. The card is therefore offered only for what the judgment allowed, and
 * it displays the envelope the command will actually run under.
 */
describe("an asking mode consults the judgment layer before it offers the card", () => {
  function approvalsFixture(): { approvals: () => CoordinationDeps; close: () => void } {
    const database = openDatabase({ path: join(dir, "node.sqlite") });
    migrate(database);
    return {
      approvals: () => ({
        db: database,
        nodeId: "node_local",
        now: () => "2026-09-19T10:00:00.000Z" as never,
        newId: (prefix: string) => `${prefix}_test`,
      }),
      close: () => database.close(),
    };
  }

  it("refuses before offering a card when the guardrail refuses", async () => {
    const approved = approvalsFixture();
    try {
      const { tool, runs } = makeTool({
        policy: { mode: "ask" },
        guard: { status: "deny", reason: "guardrail từ chối nhóm destructive" },
        approvals: approved.approvals,
      });
      const answer = await tool.execute({ command: "rm -rf build" });

      expect(runs).toHaveLength(0);
      // No card: asking a person to approve something the judgment layer already refused is not a question.
      expect(answer.hostCard).toBeUndefined();
      expect(answer.hostBlocks).toBeUndefined();
      expect(answer.text).toContain("Guardrail từ chối");
      expect(answer.text).toContain("nhóm destructive");
    } finally {
      approved.close();
    }
  });

  it("cards the narrowed envelope, so the approval is bound to what will run", async () => {
    const approved = approvalsFixture();
    try {
      const { tool, runs } = makeTool({
        policy: { mode: "ask" },
        guard: { status: "constrain", constraintId: "timeout-30s", reason: "thu hẹp" },
        approvals: approved.approvals,
      });
      const answer = await tool.execute({ command: "pnpm build" });
      const card = answer.hostCard as { type?: string; payload?: string; operationDigest?: string } | undefined;

      expect(runs).toHaveLength(0);
      expect(card?.type).toBe("approval-card");
      // The narrowing travels with the card rather than being lost between the question and the answer.
      const payload = JSON.parse(card?.payload ?? "{}") as { command?: string; cwd?: string; timeoutMs?: number };
      expect(payload.command).toBe("pnpm build");
      expect(payload.cwd).toBe(work);
      expect(payload.timeoutMs).toBe(30_000);
      expect(card?.operationDigest).toBe(commandDigest("pnpm build", work));
    } finally {
      approved.close();
    }
  });
});

describe("the confirm policy, kept whole", () => {
  it("refuses honestly when the node has no way to record a decision", async () => {
    const { tool, runs } = makeTool({ policy: { mode: "ask" } });
    const answer = await tool.execute({ command: "pnpm build" });
    expect(runs).toHaveLength(0);
    expect(answer.text).toContain("không có nơi ghi quyết định");
  });

  it("asks a person when the node can record one", async () => {
    let database: Database | undefined;
    try {
      database = openDatabase({ path: join(dir, "node.sqlite") });
      migrate(database);
      const approvals = (): CoordinationDeps => ({
        db: database as Database,
        nodeId: "node_local",
        now: () => "2026-09-19T10:00:00.000Z" as never,
        newId: (prefix: string) => `${prefix}_test`,
      });
      const { tool, runs } = makeTool({ policy: { mode: "ask" }, approvals });
      const answer = await tool.execute({ command: "pnpm build" });

      expect(runs).toHaveLength(0);
      expect(answer.hostCard?.type).toBe("approval-card");
      expect(answer.text).toContain("phải bấm duyệt");
    } finally {
      database?.close();
    }
  });
});
