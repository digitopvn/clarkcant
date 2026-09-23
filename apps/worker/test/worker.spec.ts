import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakePiAdapter } from "@clarkcant/pi-adapter";
import type { Evidence } from "@clarkcant/contracts";

import {
  runWorker,
  workerBriefEnvelopeSchema,
  type WorkerBriefEnvelope,
  type WorkerDeps,
  type WorkerTool,
} from "../src/index.ts";
import { allWorkerTools, READ_PROJECT_FILE_TOOL } from "../src/tools.ts";

/**
 * Worker run-loop tests.
 *
 * The properties under test are the ones that decide whether a report can be trusted: that an
 * ungranted capability is unreachable rather than merely unmentioned, that evidence describes
 * real tool output, and that a run which demonstrated nothing says so instead of reporting
 * success.
 */

const CAPABILITY_READ = "project.file.read@1";
const CAPABILITY_WRITE = "capability:project.write";

let root: string;
let elsewhere: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "clarkcant-worker-"));
  elsewhere = mkdtempSync(join(tmpdir(), "clarkcant-outside-"));
  writeFileSync(join(root, "report.txt"), "three records\n", "utf8");
  writeFileSync(join(elsewhere, "secret.txt"), "not for the worker\n", "utf8");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
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

/** A tool that always succeeds, so a test can assert on evidence without touching the disk. */
function stubTool(overrides: Partial<WorkerTool> = {}): WorkerTool {
  return {
    name: "read_report",
    label: "Read report",
    description: "Returns a fixed body.",
    capabilityRef: CAPABILITY_READ,
    proves: "file-version",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ text: "body-1" }),
    ...overrides,
  };
}

function deps(adapter: FakePiAdapter, tools: readonly WorkerTool[], extra: Partial<WorkerDeps> = {}): WorkerDeps {
  return { adapter, nodeId: "node_test", availableTools: tools, ...extra };
}

describe("a capability the brief does not grant is unreachable (tool registration)", () => {
  it("does not register a tool whose capability was withheld", async () => {
    const adapter = new FakePiAdapter();
    const writeTool = stubTool({
      name: "write_report",
      capabilityRef: CAPABILITY_WRITE,
      proves: "file-diff",
      execute: async () => ({ text: "wrote" }),
    });

    await runWorker(brief(), deps(adapter, [stubTool(), writeTool]));

    // The session is disposed by the time runWorker returns, so the assertion is on the record
    // of what was denied rather than on a live session.
    const result = await runWorker(brief({ runId: "run_2" }), deps(adapter, [stubTool(), writeTool]));
    expect(result.withheldCapabilities).toEqual([CAPABILITY_WRITE]);
  });

  it("registers a tool whose capability the brief grants", async () => {
    const adapter = new FakePiAdapter();
    let called = false;
    const tool = stubTool({
      execute: async () => {
        called = true;
        return { text: "body-1" };
      },
    });

    // Driving through the adapter is how the test observes what the agent could reach.
    const result = await runWorker(
      brief(),
      deps(adapter, [tool], {
        drive: async (sessionId) => {
          await adapter.callTool(sessionId, "read_report", {});
        },
      }),
    );

    expect(called).toBe(true);
    expect(result.withheldCapabilities).toEqual([]);
  });

  it("refuses to run a withheld tool even when the model asks for it by name", async () => {
    const adapter = new FakePiAdapter();
    const writeTool = stubTool({ name: "write_report", capabilityRef: CAPABILITY_WRITE });

    const result = await runWorker(
      brief(),
      deps(adapter, [stubTool(), writeTool], {
        drive: async (sessionId) => {
          await adapter.callTool(sessionId, "write_report", {});
        },
      }),
    );

    // The call failed, and the failure is reported rather than swallowed.
    expect(result.record.evidence.some((item) => item.verdict === "contradicted")).toBe(true);
  });
});

describe("evidence describes what a tool returned, not that a tool ran", () => {
  it("digests the tool's actual output", async () => {
    const adapter = new FakePiAdapter();
    const first = await runWorker(
      brief(),
      deps(adapter, [stubTool()], {
        drive: async (sessionId) => {
          await adapter.callTool(sessionId, "read_report", {});
        },
      }),
    );

    const second = await runWorker(
      brief({ runId: "run_2" }),
      deps(adapter, [stubTool({ execute: async () => ({ text: "body-2" }) })], {
        drive: async (sessionId) => {
          await adapter.callTool(sessionId, "read_report", {});
        },
      }),
    );

    const digestOf = (evidence: readonly Evidence[]): string | undefined =>
      evidence.find((item) => item.digest !== undefined)?.digest;

    expect(digestOf(first.record.evidence)).toBeDefined();
    // Same tool, same arguments, different output: the digest must move, or it would not be
    // evidence of anything.
    expect(digestOf(first.record.evidence)).not.toBe(digestOf(second.record.evidence));
  });

  it("carries the kind of evidence the tool declared", async () => {
    const adapter = new FakePiAdapter();
    const result = await runWorker(
      brief(),
      deps(adapter, [stubTool({ proves: "test-output" })], {
        drive: async (sessionId) => {
          await adapter.callTool(sessionId, "read_report", {});
        },
      }),
    );

    expect(result.record.evidence[0]?.kind).toBe("test-output");
    expect(result.record.evidence[0]?.verdict).toBe("verified");
  });
});

describe("settling is not succeeding", () => {
  it("reports not-verified when the session settles with no evidence", async () => {
    const adapter = new FakePiAdapter({ script: ["I have finished the task."] });

    // No drive override: the session runs to completion over a scripted reply that produced no
    // evidence at all. This is the case that must not be reported as success.
    const result = await runWorker(brief(), deps(adapter, [stubTool()]));

    expect(result.stopReason).toBe("settled");
    expect(result.record.evidence).toHaveLength(1);
    expect(result.record.evidence[0]?.kind).toBe("absent");
    expect(result.record.evidence[0]?.verdict).toBe("not-verified");
  });

  it("reports contradicted when a tool fails", async () => {
    const adapter = new FakePiAdapter();
    const failing = stubTool({
      execute: async () => {
        throw new Error("the file is unreadable");
      },
    });

    const result = await runWorker(
      brief(),
      deps(adapter, [failing], {
        drive: async (sessionId) => {
          await adapter.callTool(sessionId, "read_report", {}).catch(() => undefined);
        },
      }),
    );

    const contradicted = result.record.evidence.find((item) => item.verdict === "contradicted");
    expect(contradicted).toBeDefined();
    expect(contradicted?.summary).toContain("the file is unreadable");
  });
});

describe("the budget stops the run instead of being noticed afterwards", () => {
  it("stops a session that never settles and says the work is unfinished", async () => {
    const adapter = new FakePiAdapter();

    const result = await runWorker(
      brief({ maxWallClockMs: 40 }),
      deps(adapter, [stubTool()], {
        // A session that never settles: the case a wall-clock budget exists for.
        drive: () => new Promise<void>(() => undefined),
      }),
    );

    expect(result.stopReason).toBe("wall-clock-budget");
    const absent = result.record.evidence.find((item) => item.kind === "absent");
    expect(absent?.verdict).toBe("not-verified");
    expect(absent?.summary).toContain("unfinished");
  });

  it("stops a run that exceeds its token budget", async () => {
    const adapter = new FakePiAdapter();

    const result = await runWorker(
      brief({ maxTokens: 10 }),
      deps(adapter, [stubTool()], {
        drive: async (sessionId) => {
          // The fake charges one token per four characters, so this exceeds a 10-token budget.
          await adapter.prompt(sessionId, "x".repeat(400));
        },
      }),
    );

    expect(result.stopReason).toBe("token-budget");
    expect(result.record.evidence.some((item) => item.verdict === "not-verified")).toBe(true);
  });
});

describe("the run record is a record, not a task update", () => {
  it("reports lineage and the lease it held, and claims no task state", async () => {
    const adapter = new FakePiAdapter();
    const result = await runWorker(
      brief({ replacesRunId: "run_0" }),
      deps(adapter, [stubTool()], {
        drive: async (sessionId) => {
          await adapter.callTool(sessionId, "read_report", {});
        },
      }),
    );

    expect(result.record.executionNodeId).toBe("node_test");
    expect(result.record.leaseEpoch).toBe(4);
    expect(result.record.taskRevision).toBe(1);
    expect(result.record.replacesRunId).toBe("run_0");
    // The worker has no field in which to assert an outcome for the task; the home node decides.
    expect(Object.keys(result.record)).not.toContain("state");
  });
});

describe("file tools stay inside the approved roots", () => {
  it("reads a file inside a root", async () => {
    const adapter = new FakePiAdapter();
    const result = await runWorker(
      brief(),
      deps(adapter, allWorkerTools([root]), {
        drive: async (sessionId) => {
          await adapter.callTool(sessionId, READ_PROJECT_FILE_TOOL, { path: join(root, "report.txt") });
        },
      }),
    );

    expect(result.record.evidence[0]?.verdict).toBe("verified");
    expect(result.record.evidence[0]?.summary).toContain("three records");
  });

  it("refuses a file outside every root, including one reached by climbing out", async () => {
    const adapter = new FakePiAdapter();
    const outside = join(elsewhere, "secret.txt");

    for (const attempt of [outside, join(root, "..", "clarkcant-outside", "secret.txt")]) {
      const result = await runWorker(
        brief({ runId: `run_${attempt.length}` }),
        deps(adapter, allWorkerTools([root]), {
          drive: async (sessionId) => {
            await adapter.callTool(sessionId, READ_PROJECT_FILE_TOOL, { path: attempt }).catch(() => undefined);
          },
        }),
      );

      const refused = result.record.evidence.find((item) => item.verdict === "contradicted");
      expect(refused, `expected a refusal for ${attempt}`).toBeDefined();
      expect(refused?.summary).toContain("outside every approved root");
    }
  });

  it("refuses a symlink inside the root whose target is outside every root", async () => {
    const adapter = new FakePiAdapter();
    const link = join(root, "escape-link");
    await symlink(join(elsewhere, "secret.txt"), link).catch(async (cause) => {
      // Some CI sandboxes disallow symlink creation; skip rather than fail on an unrelated
      // platform restriction, since the property under test is containment, not symlink support.
      if ((cause as NodeJS.ErrnoException).code !== "EPERM") throw cause;
    });
    const linkExists = await lstat(link).then(
      () => true,
      () => false,
    );
    if (!linkExists) return;

    const result = await runWorker(
      brief({ runId: "run_symlink_escape" }),
      deps(adapter, allWorkerTools([root]), {
        drive: async (sessionId) => {
          await adapter.callTool(sessionId, READ_PROJECT_FILE_TOOL, { path: link }).catch(() => undefined);
        },
      }),
    );

    const refused = result.record.evidence.find((item) => item.verdict === "contradicted");
    expect(refused, "expected the symlink escape to be refused").toBeDefined();
    expect(refused?.summary).toContain("outside every approved root");
  });
});

describe("the brief is validated at the process boundary", () => {
  it("rejects a brief missing its revision", () => {
    const { taskRevision: _dropped, ...incomplete } = brief();
    const parsed = workerBriefEnvelopeSchema.safeParse(incomplete);
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown field rather than ignoring it", () => {
    const parsed = workerBriefEnvelopeSchema.safeParse({ ...brief(), authority: "task-owner" });
    expect(parsed.success).toBe(false);
  });

  it("accepts a well-formed brief", () => {
    expect(workerBriefEnvelopeSchema.safeParse(brief()).success).toBe(true);
  });
});
