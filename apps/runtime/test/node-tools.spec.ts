import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_AUTONOMY_SETTINGS } from "@clarkcant/contracts";
import { instantSchema } from "@clarkcant/contracts";
import type { ExecutionPolicy } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";
import { allRows } from "@clarkcant/storage";

import { createNodeTools } from "../src/node-tools.ts";
import { ownedResources } from "../src/preflight.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The tools a turn may call.
 *
 * This list is asserted rather than described because of how one entry went missing: `find_project`
 * was defined, unit-tested and required by the plan's phase 11, and the entry point never put it in
 * the list the model is given. A tool that exists and is never offered is a tool nobody has.
 */

let dir: string;
let services: NodeServices;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-tools-"));
  services = bootNodeServices({ dataDir: dir, label: "tools node" });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the node's tools", () => {
  it("offers the model every read-only report, including the project finder", () => {
    const tools = createNodeTools({ search: services.search, projects: services.projects });
    expect(tools.map((tool) => tool.name)).toEqual(["search_history", "search_files", "find_runtime", "find_project"]);

    for (const tool of tools) {
      // A tool with no description is a tool the model cannot decide to use.
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("offers read_attachment only when there is a conversation to check against", () => {
    // Two states, both correct: a turn inside a conversation can read the files attached to it, and a turn
    // with no conversation has nothing to check an id against, so it is not offered the tool at all.
    const without = createNodeTools({ search: services.search, projects: services.projects });
    expect(without.map((tool) => tool.name)).not.toContain("read_attachment");

    const with_ = createNodeTools({
      search: services.search,
      projects: services.projects,
      attachments: { dataDir: dir, conversationId: "conv_1" },
    });
    expect(with_.map((tool) => tool.name)).toContain("read_attachment");
    const tool = with_.find((candidate) => candidate.name === "read_attachment");
    expect(tool?.description.length).toBeGreaterThan(20);
    // The id and nothing else: the schema is the boundary, so a path parameter cannot be added without
    // this failing.
    expect(Object.keys(tool?.parameters.properties ?? {})).toEqual(["attachmentId"]);
  });

  it("offers run_command even when this node has no approval route", () => {
    // The change this phase makes: a node that cannot record a decision is not a node that cannot run a command.
    // Registration follows the command path now, and the approval route is only what the `confirm` policy needs —
    // which is why there is no `approvals` in this call at all.
    const withoutApproval = createNodeTools({
      search: services.search,
      projects: services.projects,
      command: {
        autonomy: () => DEFAULT_AUTONOMY_SETTINGS,
        resources: () => ownedResources([dir]),
        fallbackCwd: () => dir,
        newId: () => "run_1",
      },
    });
    expect(withoutApproval.map((tool) => tool.name)).toContain("run_command");
  });

  it("offers no command tool when this node cannot run commands at all", () => {
    const none = createNodeTools({ search: services.search, projects: services.projects });
    expect(none.map((tool) => tool.name)).not.toContain("run_command");
  });

  it("answers find_project without opening anything", async () => {
    const tool = createNodeTools({ search: services.search, projects: services.projects }).find(
      (candidate) => candidate.name === "find_project",
    );
    const result = await tool?.execute({ query: "nothing matches this on a fresh node" });
    // A report, not a side effect: no session is started and no directory is opened.
    expect(typeof result?.text).toBe("string");
    expect(result?.text).not.toContain("/Users/");
  });
});

/**
 * The command tool, under each execution policy.
 *
 * This is where the three modes stop being a setting: the same proposal produces a card, a real run, or
 * a refusal, and the audit trail says which. The command is a real one — a node that "ran" something it
 * did not run would pass a test that only checked the text.
 */
describe("the command tool obeys the execution policy", () => {
  const RAN = "policy-ran";
  const command = `node -e "process.stdout.write('${RAN}')"`;

  function now() {
    return instantSchema.parse(new Date().toISOString());
  }

  function commandTool(options: {
    policy?: ExecutionPolicy;
    audit?: boolean;
    ledger?: boolean;
  } = {}): ToolDefinition {
    const deps = {
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      now,
      newId: services.conductor.newId,
    };
    const tools = createNodeTools({
      search: services.search,
      projects: services.projects,
      command: {
        // Present, so the confirm path has somewhere to record a decision. The refusal that happens when a
        // node has no decision route at all is its own case, covered where the whole deps shape is visible.
        approvals: () => deps,
        autonomy: () => ({ ...DEFAULT_AUTONOMY_SETTINGS, executionPolicy: options.policy ?? "guarded" }),
        resources: () => ownedResources([dir, process.cwd()]),
        fallbackCwd: () => dir,
        newId: () => services.conductor.newId("tool"),
        /* The trail, written after the command ran: a summary and an outcome, never its output. */
        ...(options.audit === true ? { audit: () => ({ summary: "fixture ran", outcome: "done" as const }) } : {}),
        /*
         * The effect ledger, from main, written before the command starts: how far an external effect got is the
         * fact a reader needs after a crash between the command starting and its result arriving.
         */
        ...(options.ledger === true
          ? {
              effectAudit: () => ({
                deps,
                principalId: services.search.principalId,
                conversationId: "conv_policy",
              }),
            }
          : {}),
      },
    });
    const tool = tools.find((candidate) => candidate.name === "run_command");
    // Thrown rather than defaulted: a test that silently exercised no tool at all would pass while the
    // behaviour it claims to check was never reached.
    if (tool === undefined) throw new Error("run_command is not registered");
    return tool;
  }

  function executedEffects(): string[] {
    return allRows<{ kind: string }>(services.runtime.db, "SELECT kind FROM events").map((row) => row.kind);
  }

  it("runs a command the default policy allows, with no card anywhere", async () => {
    // The change this refactor exists for: the default is guarded, so a command a person asked for runs, and what
    // the transcript carries is its receipt rather than a question nobody wanted to answer.
    const result = await commandTool({ ledger: true }).execute({ command, cwd: dir });
    expect(result.hostCard).toBeUndefined();
    // The output, not a claim about the output: the shell actually ran.
    expect(result.text).toContain(RAN);
    expect(executedEffects()).toEqual(["effect.executed"]);
  });

  it("asks before every command under confirm, and runs nothing until a person answers", async () => {
    const result = await commandTool({ policy: "confirm" }).execute({ command, cwd: dir });
    expect(result.hostCard).toBeDefined();
    expect((result.hostCard as { type: string }).type).toBe("approval-card");
    expect(result.text).toContain("Chưa có gì chạy cả");
    expect(executedEffects()).toEqual([]);
  });

  it("refuses a class the node has turned off, and does not run it", async () => {
    const result = await commandTool({ policy: "deny" }).execute({ command, cwd: dir });
    expect(result.hostCard).toBeUndefined();
    expect(result.text).toContain("Node này đang tắt lớp");
    expect(result.text).not.toContain(RAN);
    expect(executedEffects()).toEqual([]);
  });

  it("runs under auto as well, which is the same run with the judgment layer switched off", async () => {
    const result = await commandTool({ policy: "auto", ledger: true }).execute({ command, cwd: dir });
    expect(result.hostCard).toBeUndefined();
    expect(result.text).toContain(RAN);
    expect(executedEffects()).toEqual(["effect.executed"]);
  });

  it("runs even when the node has nowhere to write the trail, because a record is not a permission", async () => {
    /*
     * Deliberately different from the policy main had here, and it is the design: the trail says who asked for
     * what, and the effect ledger says how far an effect got. Neither is the gate — preflight plus the policy is —
     * so a node whose sinks are missing still runs what a person asked for rather than quietly becoming a
     * different product.
     */
    const result = await commandTool().execute({ command, cwd: dir });
    expect(result.hostCard).toBeUndefined();
    expect(result.text).toContain(RAN);
  });
});
