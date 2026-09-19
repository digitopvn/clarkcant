import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AutonomySettings, DEFAULT_AUTONOMY_SETTINGS, type Instant, type MessageBlock } from "@clarkcant/contracts";
import type { CoordinationDeps } from "@clarkcant/core";
import { migrate, openDatabase, nodeStoreSecretBackend, putSecretMetadata, type Database } from "@clarkcant/storage";

import type { CommandOutcome } from "../src/run-command.ts";
import type { InteractionDeps } from "../src/interactions.ts";
import type { SecretBroker } from "../src/secret-broker.ts";
import { createSecretBroker } from "../src/secret-broker.ts";
import type { OperationGuardOutcome } from "../src/jev-decider.ts";
import { createRunCommandTool, policyForEffect } from "../src/node-tools.ts";
import { ownedResources } from "../src/preflight.ts";

/**
 * The command path under the autonomy policy.
 *
 * This is the change the whole architecture turns on: a command runs without a person approving it, and
 * what keeps that defensible is visible here rather than asserted in prose. Every refusal below is a case
 * where the host said no — outside the folders it owns, a class switched off, a guardrail that refused,
 * a guardrail that could not be reached on a node configured to fail closed.
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

function makeTool(options: {
  settings?: Partial<AutonomySettings>;
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
  const settings: AutonomySettings = { ...DEFAULT_AUTONOMY_SETTINGS, ...options.settings };

  const tool = createRunCommandTool({
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    autonomy: () => settings,
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
  it("guards by default, and only for the classes a person left switched on", () => {
    expect(policyForEffect(DEFAULT_AUTONOMY_SETTINGS, "commands")).toBe("guarded");
    expect(policyForEffect(DEFAULT_AUTONOMY_SETTINGS, "reads")).toBe("auto");
  });

  it("lets the four modes through unchanged", () => {
    for (const policy of ["auto", "guarded", "confirm", "deny"] as const) {
      expect(policyForEffect({ ...DEFAULT_AUTONOMY_SETTINGS, executionPolicy: policy }, "commands")).toBe(policy);
    }
  });

  it("skips the policy layer when guardrails are switched off", () => {
    expect(policyForEffect({ ...DEFAULT_AUTONOMY_SETTINGS, jevGuardrails: false }, "commands")).toBe("auto");
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
    const { tool, runs, guardCalls } = makeTool({ settings: { executionPolicy: "auto" } });
    await tool.execute({ command: "pnpm build" });
    expect(guardCalls()).toBe(0);
    expect(runs).toHaveLength(1);
  });

  it("does not consult it for a class the person switched off", async () => {
    const { tool, runs, guardCalls } = makeTool({ settings: { guardedClasses: ["financial"] } });
    await tool.execute({ command: "pnpm build" });
    expect(guardCalls()).toBe(0);
    expect(runs).toHaveLength(1);
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
    const { tool, runs, guardCalls } = makeTool({ settings: { executionPolicy: "deny" } });
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
    const { tool, runs } = makeTool({ guard: unavailable, settings: { whenJevUnavailable: "deny" } });
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

describe("the confirm policy, kept whole", () => {
  it("refuses honestly when the node has no way to record a decision", async () => {
    const { tool, runs } = makeTool({ settings: { executionPolicy: "confirm" } });
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
      const { tool, runs } = makeTool({ settings: { executionPolicy: "confirm" }, approvals });
      const answer = await tool.execute({ command: "pnpm build" });

      expect(runs).toHaveLength(0);
      expect(answer.hostCard?.type).toBe("approval-card");
      expect(answer.text).toContain("phải bấm duyệt");
    } finally {
      database?.close();
    }
  });
});
