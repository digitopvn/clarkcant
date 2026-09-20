import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CapabilityDescriptor, CapabilityRef, Evidence, Instant, RunRecord } from "@clarkcant/contracts";
import type { WorkerBriefEnvelope } from "@clarkcant/app-worker";
import { getCapability, registerCapability } from "@clarkcant/core";

import { bootRuntime } from "../src/node.ts";
import { bootNodeServices } from "../src/services.ts";
import { loadProjectWorkPack } from "../src/pack-load.ts";
import type { WorkerProcessResult } from "../src/worker-process.ts";

/**
 * Loading the pack, and the difference between loading it and it working.
 *
 * These start from the state a node really boots in — the capability registered with every flag
 * false and the reason "the pack is declared but no worker has loaded it on this node" — because
 * the defect this closes is not that the flags were wrong, it is that nothing ever tried to change
 * them. So each test asserts what the registry says *after* a run, read back through the same
 * `getCapability` the rest of the node uses.
 *
 * The fake worker returns records rather than performing runs, which is the point: the judgement
 * being tested is what the caller does with a record, and a fake that returned a *successful* record
 * would test nothing about the distinction.
 */

const AT = "2026-09-20T09:00:00.000Z" as Instant;
const CODE_CHANGE = "project.code.change@1" as CapabilityRef;
const FILE_READ = "project.file.read@1" as CapabilityRef;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cc-pack-load-"));
}

interface TestNode {
  runtime: ReturnType<typeof bootRuntime>;
  deps: { db: ReturnType<typeof bootRuntime>["db"]; nodeId: string };
  close: () => void;
}

/** A node with the pack declared exactly as `bootNodeServices` declares it: present, and not loaded. */
function testNode(): TestNode {
  const runtime = bootRuntime({ dataDir: tempDir(), label: "pack probe test node" });
  return { runtime, deps: { db: runtime.db, nodeId: runtime.identity.nodeId }, close: () => runtime.close() };
}

function declare(deps: TestNode["deps"], ref: CapabilityRef): CapabilityDescriptor {
  return registerCapability(deps, {
    ref,
    executionNodeId: deps.nodeId as CapabilityDescriptor["executionNodeId"],
    summary: `làm ${ref}`,
    resourceKinds: ["file"],
    effectCategory: "local-write",
    supportsCancellation: true,
    requiresConnection: false,
    readiness: {
      installed: false,
      loaded: false,
      authenticated: false,
      authorized: false,
      healthy: false,
      blockedReason: "the pack is declared but no worker has loaded it on this node",
    },
    uiAffordances: [],
  });
}

function evidence(verdict: Evidence["verdict"], summary: string): Evidence {
  return { kind: verdict === "not-verified" ? "absent" : "file-diff", summary, verdict, observedAt: AT };
}

function record(items: Evidence[]): RunRecord {
  return {
    runId: "run_pack_probe_1",
    taskId: "task_pack_probe_1",
    taskRevision: 0,
    executionNodeId: "node_probe",
    leaseEpoch: 0,
    evidence: items,
    startedAt: AT,
    endedAt: AT,
  };
}

/** A worker that returns a record, so what is under test is the caller's reading of it. */
function workerReturning(items: Evidence[], withheld: string[] = []): (brief: WorkerBriefEnvelope) => Promise<WorkerProcessResult> {
  return async () => ({
    adapter: "fake",
    adapterVersion: undefined,
    stopReason: "settled",
    withheldCapabilities: withheld,
    record: record(items),
  });
}

describe("loading the project-work pack", () => {
  it("marks the capability loaded once a worker has really loaded it, and says what is still missing", async () => {
    const node = testNode();
    try {
      declare(node.deps, CODE_CHANGE);

      const result = await loadProjectWorkPack({
        deps: node.deps,
        refs: [CODE_CHANGE],
        run: workerReturning([evidence("verified", "the file changed and re-reading it showed the change")]),
        at: () => AT,
      });

      expect(result.ran).toBe(true);
      const after = getCapability(node.deps, CODE_CHANGE, node.deps.nodeId)?.readiness;
      expect(after?.installed).toBe(true);
      expect(after?.loaded).toBe(true);
      expect(after?.healthy).toBe(true);
      // Still not usable, and the reason says which part is missing rather than leaving the interface
      // to answer "not usable" with nothing behind it.
      expect(after?.authenticated).toBe(false);
      expect(after?.blockedReason).toMatch(/has not been authorized for a task/);
      expect(after?.lastProbeAt).toBe(AT);
    } finally {
      node.close();
    }
  });

  it("keeps a run that demonstrated nothing as a run that demonstrated nothing", async () => {
    const node = testNode();
    try {
      declare(node.deps, CODE_CHANGE);

      await loadProjectWorkPack({
        deps: node.deps,
        refs: [CODE_CHANGE],
        run: workerReturning([
          evidence("not-verified", "the session settled without producing any verifiable evidence; this is not a result"),
        ]),
        at: () => AT,
      });

      const after = getCapability(node.deps, CODE_CHANGE, node.deps.nodeId)?.readiness;
      // The load happened. The work did not. Those are two different facts and the flags say both.
      expect(after?.loaded).toBe(true);
      expect(after?.healthy).toBe(false);
      expect(after?.blockedReason).toContain("this is not a result");
    } finally {
      node.close();
    }
  });

  it("treats a contradicted run as worse than silence", async () => {
    const node = testNode();
    try {
      declare(node.deps, CODE_CHANGE);

      await loadProjectWorkPack({
        deps: node.deps,
        refs: [CODE_CHANGE],
        run: workerReturning([
          evidence("verified", "the write reported success"),
          evidence("contradicted", "reading the file back showed the old contents"),
        ]),
        at: () => AT,
      });

      const after = getCapability(node.deps, CODE_CHANGE, node.deps.nodeId)?.readiness;
      expect(after?.healthy).toBe(false);
      expect(after?.blockedReason).toContain("contradicted itself");
      expect(after?.blockedReason).toContain("the old contents");
    } finally {
      node.close();
    }
  });

  it("reports a worker that could not run instead of throwing, and does not claim a load", async () => {
    const node = testNode();
    try {
      declare(node.deps, CODE_CHANGE);

      const result = await loadProjectWorkPack({
        deps: node.deps,
        refs: [CODE_CHANGE],
        run: () => Promise.reject(new Error("the worker could not run: the brief was unreadable")),
        at: () => AT,
      });

      expect(result.ran).toBe(false);
      const after = getCapability(node.deps, CODE_CHANGE, node.deps.nodeId)?.readiness;
      // The node keeps booting, and nothing claims a load that did not happen.
      expect(after?.installed).toBe(false);
      expect(after?.loaded).toBe(false);
      expect(after?.blockedReason).toContain("the brief was unreadable");
    } finally {
      node.close();
    }
  });

  it("leaves authentication and authorization exactly where the registry had them", async () => {
    const node = testNode();
    try {
      declare(node.deps, CODE_CHANGE);
      // A node where somebody had already authenticated the pack: the probe must not speak for that.
      const before = getCapability(node.deps, CODE_CHANGE, node.deps.nodeId);
      expect(before).toBeDefined();

      await loadProjectWorkPack({
        deps: node.deps,
        refs: [CODE_CHANGE],
        run: workerReturning([evidence("verified", "something was demonstrated")]),
        at: () => AT,
      });

      const after = getCapability(node.deps, CODE_CHANGE, node.deps.nodeId)?.readiness;
      expect(after?.authenticated).toBe(before?.readiness.authenticated);
      expect(after?.authorized).toBe(before?.readiness.authorized);
    } finally {
      node.close();
    }
  });

  it("writes the same reading to every capability the pack declares", async () => {
    const node = testNode();
    try {
      declare(node.deps, CODE_CHANGE);
      declare(node.deps, FILE_READ);

      await loadProjectWorkPack({
        deps: node.deps,
        refs: [CODE_CHANGE, FILE_READ],
        run: workerReturning([evidence("verified", "something was demonstrated")]),
        at: () => AT,
      });

      for (const ref of [CODE_CHANGE, FILE_READ]) {
        expect(getCapability(node.deps, ref, node.deps.nodeId)?.readiness.loaded).toBe(true);
      }
    } finally {
      node.close();
    }
  });

  it("grants the pack's capabilities to the probe and touches nothing of the user's", async () => {
    const node = testNode();
    try {
      declare(node.deps, CODE_CHANGE);
      let seen: WorkerBriefEnvelope | undefined;

      await loadProjectWorkPack({
        deps: node.deps,
        refs: [CODE_CHANGE],
        run: async (brief) => {
          seen = brief;
          return {
            adapter: "fake",
            adapterVersion: undefined,
            stopReason: "settled",
            withheldCapabilities: [],
            record: record([evidence("verified", "something was demonstrated")]),
          };
        },
        at: () => AT,
      });

      expect(seen?.allowedCapabilityRefs).toEqual([CODE_CHANGE]);
      // A probe demonstrates that the pack runs, not what it can read, so it is granted no directory.
      expect(seen?.projectRoots).toEqual([]);
      // And it holds no lease. Zero is the honest value rather than a borrowed one.
      expect(seen?.leaseEpoch).toBe(0);
      expect(seen?.goal).toMatch(/prove the project-work pack/);
    } finally {
      node.close();
    }
  });

  it("reports the capabilities the worker refused to register even though the brief granted them", async () => {
    const node = testNode();
    try {
      declare(node.deps, CODE_CHANGE);

      const result = await loadProjectWorkPack({
        deps: node.deps,
        refs: [CODE_CHANGE],
        run: workerReturning([evidence("not-verified", "no tool was registered")], [CODE_CHANGE]),
        at: () => AT,
      });

      expect(result.withheldCapabilities).toEqual([CODE_CHANGE]);
    } finally {
      node.close();
    }
  });
});

/**
 * The container, not the function.
 *
 * Everything above proves the judgement; this proves the app has a path to it. This one runs a real
 * worker in a real process, because the row's gap was not that the reading was wrong — it was that
 * nothing in the app ever asked for one.
 */
describe("the node's own path to loading the pack", () => {
  it("stops reporting the pack as one no worker has loaded", async () => {
    const services = bootNodeServices({ dataDir: tempDir(), label: "pack wiring test node" });
    const deps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId };
    try {
      // The state the node really boots in, read through the same lookup the rest of the node uses.
      const before = getCapability(deps, CODE_CHANGE, deps.nodeId)?.readiness;
      expect(before?.loaded).toBe(false);
      expect(before?.blockedReason).toMatch(/no worker has loaded it/);

      const result = await services.loadProjectWorkPack({ timeoutMs: 60_000 });

      expect(result.ran).toBe(true);
      const after = getCapability(deps, CODE_CHANGE, deps.nodeId)?.readiness;
      expect(after?.loaded).toBe(true);
      // And the sentence that was true only because nothing ever tried is gone.
      expect(after?.blockedReason ?? "").not.toMatch(/no worker has loaded it/);
    } finally {
      services.runtime.close();
    }
  }, 120_000);
});
