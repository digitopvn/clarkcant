import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG, type ExecutionPolicyConfig } from "@clarkcant/contracts";

import { ownedResources } from "../src/preflight.ts";
import type { TerminalInfo, TerminalRegistry, TerminalRunResult } from "../src/terminal-sessions.ts";
import { createTerminalTools } from "../src/terminal-tools.ts";

/**
 * What the agent may do to a terminal, under the one execution policy.
 *
 * The registry is a recording stand-in: these assert which of "refuse", "prefill" and "run" the tools chose, and a
 * real shell adds nothing to that question (the registry's own spec drives a real one).
 */
let dir: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-terminal-tools-"));
  work = join(dir, "work");
  mkdirSync(work, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeRegistry(): { registry: TerminalRegistry; prefills: string[]; runs: string[] } {
  const prefills: string[] = [];
  const runs: string[] = [];
  const info: TerminalInfo = {
    terminalId: "term_1",
    title: "work",
    cwd: work,
    shell: "/bin/bash",
    integration: "osc133",
    status: "running",
    exitCode: null,
    startedAt: "2026-09-24T00:00:00.000Z",
    lastActivityAt: "2026-09-24T00:00:00.000Z",
    running: null,
    cols: 80,
    rows: 24,
    driver: null,
  };
  const registry: TerminalRegistry = {
    availability: async () => ({ ok: true }),
    open: async (input) => ({ ok: true, info: { ...info, cwd: input.cwd } }),
    get: (id) => (id === info.terminalId ? info : undefined),
    list: () => [info],
    replay: () => "",
    write: () => true,
    resize: () => true,
    ready: async () => true,
    prefill: (_id, text) => {
      prefills.push(text);
      return { ok: true };
    },
    run: async (_id, command): Promise<TerminalRunResult> => {
      runs.push(command);
      return {
        status: "finished",
        record: { id: "cmd_1", command, startedAt: info.startedAt, endedAt: info.startedAt, exitCode: 0, output: "ok", truncated: false },
      };
    },
    commands: () => [],
    subscribe: () => () => undefined,
    claimDriver: () => true,
    releaseDriver: () => undefined,
    kill: () => true,
    stopAll: () => 0,
  };
  return { registry, prefills, runs };
}

function tools(policy: Partial<ExecutionPolicyConfig> = {}) {
  const fake = fakeRegistry();
  const inForce: ExecutionPolicyConfig = {
    ...DEFAULT_EXECUTION_POLICY_CONFIG,
    ...policy,
    guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails, enabled: false },
  };
  const list = createTerminalTools({
    autonomy: () => inForce,
    resources: () => ownedResources([work]),
    fallbackCwd: () => work,
    newId: () => "run_1",
    terminals: fake.registry,
    newCardId: (prefix) => `${prefix}_1`,
  });
  const byName = (name: string) => {
    const tool = list.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(name);
    return tool;
  };
  return { ...fake, open: byName("terminal_open"), run: byName("terminal_run"), read: byName("terminal_read") };
}

describe("opening a terminal", () => {
  it("puts a host card in the conversation and types nothing", async () => {
    const { open, prefills, runs } = tools();
    const answer = await open.execute({});
    expect(answer.hostBlocks?.[0]).toMatchObject({ type: "terminal-session-card", owner: "host", terminalId: "term_1", cwd: work });
    expect(prefills).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("only prefills a command unless asked to run it", async () => {
    const { open, prefills, runs } = tools();
    const answer = await open.execute({ command: "pnpm test" });
    expect(prefills).toEqual(["pnpm test"]);
    expect(runs).toEqual([]);
    expect(answer.hostBlocks?.[0]).toMatchObject({ prefill: "pnpm test" });
  });

  it("runs it under the default policy when asked, and hands the output back", async () => {
    const { open, runs } = tools();
    const answer = await open.execute({ command: "pnpm test", run: true });
    expect(runs).toEqual(["pnpm test"]);
    expect(answer.text).toContain("exit 0");
    expect(answer.hostBlocks?.[0]).toMatchObject({ ran: "pnpm test" });
  });

  it("prefills instead of running when the policy asks every time, and says so", async () => {
    const { open, prefills, runs } = tools({ mode: "ask" });
    const answer = await open.execute({ command: "touch file", run: true });
    expect(runs).toEqual([]);
    expect(prefills).toEqual(["touch file"]);
    expect(answer.text).toContain("Đừng nói là đã chạy");
  });

  it("opens nothing when the policy refuses the command", async () => {
    const { open, prefills, runs } = tools({ prohibition: "all" });
    const answer = await open.execute({ command: "touch file", run: true });
    expect(answer.hostBlocks).toBeUndefined();
    expect(prefills).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("refuses a directory this node does not own", async () => {
    const { open, runs } = tools();
    const answer = await open.execute({ cwd: "/", command: "ls", run: true });
    expect(answer.hostBlocks).toBeUndefined();
    expect(runs).toEqual([]);
  });
});

describe("running in an open terminal", () => {
  it("runs under the default policy", async () => {
    const { run, runs } = tools();
    const answer = await run.execute({ terminalId: "term_1", command: "git status" });
    expect(runs).toEqual(["git status"]);
    expect(answer.text).toContain("$ git status — exit 0");
  });

  it("only prefills under ask-every-time", async () => {
    const { run, runs, prefills } = tools({ mode: "ask" });
    await run.execute({ terminalId: "term_1", command: "touch x" });
    expect(runs).toEqual([]);
    expect(prefills).toEqual(["touch x"]);
  });

  it("says a terminal is missing rather than guessing another one", async () => {
    const { run, runs } = tools();
    const answer = await run.execute({ terminalId: "term_nope", command: "ls" });
    expect(runs).toEqual([]);
    expect(answer.text).toContain("term_nope");
  });
});

describe("reading terminals", () => {
  it("lists what each terminal is doing", async () => {
    const { read } = tools();
    const answer = await read.execute({});
    expect(answer.text).toContain("term_1");
    expect(answer.text).toContain("ở prompt");
  });
});
