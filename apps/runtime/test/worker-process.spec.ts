import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkerBriefEnvelope } from "@clarkcant/app-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWorkerProcess, workerEnvironment } from "../src/worker-process.ts";

/**
 * Dispatching a worker as a process.
 *
 * The worker host is implemented and tested on its own. What this covers is the thing the ledger
 * recorded as missing: that the runtime actually starts one, hands it a brief and gets a record back.
 * The process boundary is real — a real child process, a real brief file, a real exit code — because
 * a test that called `runWorker` in this process would prove nothing about the dispatch.
 *
 * The adapter is the fake one, because no live provider is configured here and pretending otherwise
 * would be a fixture imitating a fact. What the fake proves is the wiring: the worker ran, it said
 * which capabilities it withheld, and it claimed no task state.
 */

const CAPABILITY_READ = "project.file.read@1";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "clarkcant-worker-process-"));
  writeFileSync(join(root, "report.txt"), "three records\n", "utf8");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function brief(overrides: Partial<WorkerBriefEnvelope> = {}): WorkerBriefEnvelope {
  return {
    runId: "run_1",
    taskId: "task_1",
    taskRevision: 1,
    leaseEpoch: 4,
    goal: "Read the report and say what it contains.",
    projectRoots: [root],
    allowedCapabilityRefs: [CAPABILITY_READ],
    ...overrides,
  };
}

describe("the runtime starts a worker of its own", () => {
  it("runs it in a separate process and returns the record it produced", async () => {
    const result = await runWorkerProcess({ nodeId: "node_test", brief: brief() });

    // The record names the run it belongs to, so evidence can never be attached to the wrong task.
    expect(result.record.runId).toBe("run_1");
    expect(result.record.taskId).toBe("task_1");
    expect(result.adapter).toBe("fake");
    // The lease it held is part of the record, which is what makes a run attributable.
    expect(result.record.leaseEpoch).toBe(4);
  });

  it("reports the capability it withheld when the brief does not grant it", async () => {
    // The worker's first rule is that an ungranted capability is never registered. Crossing the
    // process boundary must not lose that: the brief is the only thing that grants anything.
    const result = await runWorkerProcess({ nodeId: "node_test", brief: brief({ allowedCapabilityRefs: [] }) });
    expect(result.withheldCapabilities).toContain(CAPABILITY_READ);
  });

  it("registers the granted capability instead of withholding it", async () => {
    const result = await runWorkerProcess({ nodeId: "node_test", brief: brief() });
    expect(result.withheldCapabilities).not.toContain(CAPABILITY_READ);
  });

  it("reports a run that demonstrated nothing as a result rather than as an error", async () => {
    // The fake adapter has no script, so it answers without calling a tool and no evidence is
    // produced. That is a result the caller has to judge, not a failure of the dispatch: exit 2 is
    // reserved for a worker that could not run at all.
    const result = await runWorkerProcess({ nodeId: "node_test", brief: brief() });
    // The worker records the absence rather than leaving the list empty, and the verdict says what it
    // means: a session that settled without demonstrating anything is not a result.
    expect(result.record.evidence.map((item) => item.verdict)).toEqual(["not-verified"]);
    expect(result.stopReason).toBeTruthy();
  });

  it("refuses a brief the worker cannot run, naming it as the worker's failure", async () => {
    // Missing taskRevision: the worker validates the brief at the process boundary and exits 2.
    const invalid = { ...brief(), taskRevision: undefined } as unknown as WorkerBriefEnvelope;
    await expect(runWorkerProcess({ nodeId: "node_test", brief: invalid })).rejects.toThrow(/could not run/);
  });

  it("refuses to run a real model it was given no model for, rather than letting one be picked", async () => {
    await expect(
      runWorkerProcess({ nodeId: "node_test", brief: brief(), adapter: "real", credential: "sk-unused-in-this-test" }),
    ).rejects.toThrow(/no model was given to this worker/);
  });

  it("starts a real-model worker without any provider key in its environment, whatever this process holds", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/person",
      OPENAI_API_KEY: "sk-in-the-node-environment",
      ANTHROPIC_API_KEY: "sk-also-here",
      CC_MODEL_PROVIDER: "openai",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      SystemRoot: "C:\\Windows",
    };
    const env = workerEnvironment("real", "/data/pi-agent", source);

    expect(Object.values(env).some((value) => value.startsWith("sk-"))).toBe(false);
    expect(env).not.toHaveProperty("CC_MODEL_PROVIDER");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["PI_CODING_AGENT_DIR"]).toBe("/data/pi-agent");
    // The scripted worker gets the build profile and nothing a model would need.
    expect(workerEnvironment("fake", "/data/pi-agent", source)).toEqual({ PATH: "/usr/bin", HOME: "/home/person" });
  });
});
