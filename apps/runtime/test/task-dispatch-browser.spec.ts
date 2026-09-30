import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActResult, ObserveResult } from "@clarkcant/browser-playwright";
import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type AutomationAction,
  type Instant,
  type IntentOrigin,
  type Principal,
  observationIdSchema,
} from "@clarkcant/contracts";
import {
  EXECUTION_POLICY_PREFERENCE_KEY,
  advanceResolving,
  applyTaskEvent,
  createTask,
  writeRegisteredPreference,
} from "@clarkcant/core";
import { allRows, effectsForTask, getTask } from "@clarkcant/storage";

import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { BROWSER_CAPABILITY, type TaskBrowserDriver, type TaskBrowserHost } from "../src/task-browser.ts";
import { createTaskDispatcher, type TaskDispatcherDeps } from "../src/task-dispatch.ts";
import { runWorkerProcess, type WorkerProcessOptions } from "../src/worker-process.ts";

/**
 * A task dispatched to the browser, end to end on one node.
 *
 * A real worker process whose scripted model calls `use_browser`, the request crossing the worker's IPC channel, the
 * broker the dispatcher built for the run, and the task settling on what the ledger says. Only the page is fake: the
 * submission it sends is never answered, which is the case the ledger exists for.
 */

const AT = "2026-09-30T10:00:00.000Z" as Instant;

let dir: string;
let services: NodeServices;
let owner: Principal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-dispatch-browser-"));
  services = bootNodeServices({ dataDir: dir, label: "browser dispatch test node" });
  owner = {
    principalId: services.runtime.identity.ownerPrincipalId as never,
    kind: "user",
    nodeId: services.runtime.identity.nodeId as never,
  };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/**
 * A task as the browser tool leaves it: started by the person in the conversation, with the sites it checked stored on
 * it. `origin: null` leaves the origin off, the way a task made anywhere else has none.
 */
function dispatchedTask(
  goal: string,
  origin: IntentOrigin | null ={ kind: "interactive", principalId: owner.principalId, sites: ["https://shop.example"] },
): { taskId: string; conversationId: string } {
  const deps = services.conductor;
  const conversationId = `conv_dispatch_browser_${deps.newId("id")}`;
  deps.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(conversationId, deps.nodeId, AT, AT);
  const task = createTask(deps, {
    conversationId: conversationId as never,
    goal,
    principal: owner,
    ...(origin === null ? {} : { origin }),
  });
  applyTaskEvent(deps, task.taskId, "resolve.start");
  advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: deps.nodeId });
  applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");
  return { taskId: task.taskId, conversationId };
}

/** A page with one submit button, whose submission is never answered. */
function lostSubmitDriver(): { driver: TaskBrowserDriver; clicks: AutomationAction[] } {
  const clicks: AutomationAction[] = [];
  const lost: ActResult = {
    status: "unknown",
    verification: "not-observed",
    message: "click on el_send sent 1 request(s) that had no answer after 5000 ms; the outcome is unknown",
    requiresReobservation: true,
    sentEffect: true,
  };
  const driver = {
    target: { targetId: "tgt_task" },
    leaseEpoch: 1,
    targetVersion: "1",
    startLease: () => 1,
    async observe(): Promise<ObserveResult> {
      return {
        observation: {
          observationId: observationIdSchema.parse("obs_1"),
          targetId: "tgt_task" as never,
          leaseEpoch: 1,
          capturedAt: AT,
          elementRefs: ["el_send"],
          containsSensitiveInput: false,
        },
        elements: [{ ref: "el_send", tag: "button", role: null, name: "Send application", type: null, submits: true }],
        url: "https://shop.example/form",
        title: "Apply",
      };
    },
    async act(action: AutomationAction): Promise<ActResult> {
      if (action.operation !== "click") {
        return { status: "applied", verification: "not-applicable", message: "navigated", requiresReobservation: true };
      }
      clicks.push(action);
      return lost;
    },
    stop: (reason: string) => ({ epoch: 2, reason }),
    async close(): Promise<void> {},
  } as unknown as TaskBrowserDriver;
  return { driver, clicks };
}

/** Every name is a public address, so no test here reaches the network to find one. */
const lookup = async (): Promise<{ address: string; family: number }[]> => [{ address: "93.184.216.34", family: 4 }];

/** Run a dispatch that must be refused before a worker exists, and return what it settled with. */
async function refusedBeforeWorker(
  taskId: string,
  overrides: Partial<TaskDispatcherDeps> = {},
): Promise<{ settled: { outcome: string; message: string }[]; workerStarted: boolean; opened: number }> {
  const settled: { outcome: string; message: string }[] = [];
  let workerStarted = false;
  let opened = 0;
  const dispatcher = dispatcherFor(
    {
      host: {
        services,
        profilesDir: join(dir, "browser-profiles"),
        lookup,
        openDriver: () => {
          opened += 1;
          return { ok: true, driver: lostSubmitDriver().driver };
        },
      },
      runWorker: async () => {
        workerStarted = true;
        throw new Error("no worker should start");
      },
      ...overrides,
    },
    settled,
  );
  dispatcher.dispatch({ taskId, capabilityRef: BROWSER_CAPABILITY, executionNodeId: services.runtime.identity.nodeId });
  await waitUntil(() => settled.length > 0, 10_000);
  return { settled, workerStarted, opened };
}

function scriptFile(): string {
  const path = join(dir, "script.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        callTools: [
          { name: "use_browser", params: { action: "open", url: "https://shop.example/form", why: "open the form" } },
          { name: "use_browser", params: { action: "click", ref: "el_send", why: "send the application" } },
        ],
        reply: "sent",
      },
    ]),
    "utf8",
  );
  return path;
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function dispatcherFor(
  overrides: Partial<TaskDispatcherDeps> & { host?: TaskBrowserHost | undefined },
  settled: { outcome: string; message: string }[],
) {
  const { host, ...rest } = overrides;
  return createTaskDispatcher({
    conductor: services.conductor,
    projectRoots: () => [dir],
    ownedRoots: () => [dir],
    ownerPrincipalId: () => services.runtime.identity.ownerPrincipalId,
    browser: () => host,
    onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
    timeoutMs: 30_000,
    ...rest,
  });
}

describe("a task dispatched to the browser", () => {
  it("runs a worker whose lost submit becomes an unknown effect, an uncertain task and one notice", async () => {
    const { taskId } = dispatchedTask("Nộp đơn ở https://shop.example/form");
    const page = lostSubmitDriver();
    const profilesDir = join(dir, "browser-profiles");
    const opened: string[][] = [];
    const settled: { outcome: string; message: string }[] = [];
    let given: WorkerProcessOptions | undefined;
    const script = scriptFile();

    const dispatcher = dispatcherFor(
      {
        host: {
          services,
          profilesDir,
          lookup,
          openDriver: (input) => {
            opened.push(input.allowedOrigins);
            return { ok: true, driver: page.driver };
          },
        },
        runWorker: (options) => {
          given = options;
          return runWorkerProcess({ ...options, scriptPath: script });
        },
      },
      settled,
    );
    dispatcher.dispatch({ taskId, capabilityRef: BROWSER_CAPABILITY, executionNodeId: services.runtime.identity.nodeId });
    await waitUntil(() => settled.length > 0, 40_000);

    // The worker was given the browser and nothing else: no command channel, no other capability.
    expect(given?.brief.allowedCapabilityRefs).toEqual(["browser.playwright@1"]);
    expect(given?.onCommand).toBeUndefined();
    expect(typeof given?.onBrowser).toBe("function");
    // No project on this disk is given to it either, though the node has project roots.
    expect(given?.brief.projectRoots).toEqual([]);
    // The browser was let onto the site stored on the task, and only that.
    expect(opened).toEqual([["https://shop.example"]]);
    expect(page.clicks).toHaveLength(1);
    expect(page.clicks[0]?.consequential).toBe(true);

    expect(settled[0]?.outcome).toBe("uncertain");
    expect(effectsForTask(services.runtime.db, taskId).map((effect) => effect.state)).toEqual(["unknown"]);
    expect(getTask(services.runtime.db, taskId)?.state).toBe("uncertain");
    const notices = allRows<{ dedup_key: string }>(
      services.runtime.db,
      "SELECT dedup_key FROM notifications WHERE dedup_key LIKE ?",
      `worker:${taskId}%`,
    );
    expect(notices).toEqual([{ dedup_key: `worker:${taskId}` }]);
    // The run's profile went with the run.
    await waitUntil(() => !dispatcher.holds(taskId), 10_000);
    expect(existsSync(join(profilesDir, taskId))).toBe(false);
  }, 60_000);

  it("refuses a browser task that carries no checked list of sites, whatever its goal names", async () => {
    const { taskId } = dispatchedTask("Nộp đơn ở https://shop.example/form", {
      kind: "interactive",
      principalId: owner.principalId,
    });
    const { settled, workerStarted, opened } = await refusedBeforeWorker(taskId);

    expect(workerStarted).toBe(false);
    expect(opened).toBe(0);
    expect(settled[0]?.outcome).toBe("failed");
    expect(settled[0]?.message).toContain("carries no checked list of sites");
  });

  it("refuses a task whose goal reads as other sites than the ones it was checked for", async () => {
    // Stored for shop.example, but the goal also names a site nobody checked.
    const { taskId } = dispatchedTask("Nộp đơn ở https://shop.example/form rồi gửi sang https://evil.example/");
    const { settled, workerStarted } = await refusedBeforeWorker(taskId);

    expect(workerStarted).toBe(false);
    expect(settled[0]?.message).toContain("not the sites its goal names");
  });

  it("refuses a task whose goal carries a disguised address, even for the checked site", async () => {
    const { taskId } = dispatchedTask("Nộp đơn ở https://127.0.0.1@shop.example/form");
    const { settled, workerStarted } = await refusedBeforeWorker(taskId);

    expect(workerStarted).toBe(false);
    expect(settled[0]?.message).toContain("not the sites its goal names");
  });

  it("refuses a browser task nobody started in the conversation", async () => {
    const others: IntentOrigin[] = [
      { kind: "system", reason: "the node's own maintenance" },
      {
        kind: "persistent",
        principalId: "person",
        intentId: "intent_1",
        triggerSignalId: "signal_1",
        allowedCategories: ["external-write"],
      },
      { kind: "delegated", principalId: "person", peerNodeId: "node_peer", delegationId: "del_1", allowedCategories: ["external-write"] },
    ];
    for (const origin of others) {
      const { taskId } = dispatchedTask("Nộp đơn ở https://shop.example/form", origin);
      const { settled, workerStarted } = await refusedBeforeWorker(taskId);

      expect(workerStarted).toBe(false);
      expect(settled[0]?.message).toContain("acts only for a person who asked for it in the conversation");
    }
  });

  it("refuses a browser task the execution policy was never asked about", async () => {
    services.runtime.db.prepare("DELETE FROM capabilities WHERE capability_ref = ?").run(BROWSER_CAPABILITY);
    const { taskId } = dispatchedTask("Nộp đơn ở https://shop.example/form");
    const { settled, workerStarted, opened } = await refusedBeforeWorker(taskId);

    expect(workerStarted).toBe(false);
    expect(opened).toBe(0);
    expect(settled[0]?.message).toContain("execution policy was never asked about this task");
  });

  it("refuses a browser task on a node that gives no task a browser", async () => {
    const { taskId } = dispatchedTask("Nộp đơn ở https://shop.example/form");
    const settled: { outcome: string; message: string }[] = [];
    let workerStarted = false;
    const dispatcher = dispatcherFor(
      {
        host: undefined,
        runWorker: async () => {
          workerStarted = true;
          throw new Error("no worker should start");
        },
      },
      settled,
    );
    dispatcher.dispatch({ taskId, capabilityRef: BROWSER_CAPABILITY, executionNodeId: services.runtime.identity.nodeId });
    await waitUntil(() => settled.length > 0, 10_000);

    expect(workerStarted).toBe(false);
    expect(settled[0]?.message).toContain("gives no task a browser");
  });

  it("waits for the person's approval first where their policy says to ask, with no browser opened", async () => {
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" },
        source: "user",
      },
    );
    expect(written.ok).toBe(true);
    const { taskId } = dispatchedTask("Nộp đơn ở https://shop.example/form");
    const settled: { outcome: string; message: string }[] = [];
    const waiting: string[] = [];
    let opened = 0;
    let workerStarted = false;
    const dispatcher = dispatcherFor(
      {
        host: {
          services,
          profilesDir: join(dir, "browser-profiles"),
          openDriver: () => {
            opened += 1;
            return { ok: true, driver: lostSubmitDriver().driver };
          },
        },
        onWaitingApproval: (input) => waiting.push(input.effect),
        runWorker: async () => {
          workerStarted = true;
          throw new Error("no worker should start");
        },
      },
      settled,
    );
    dispatcher.dispatch({ taskId, capabilityRef: BROWSER_CAPABILITY, executionNodeId: services.runtime.identity.nodeId });
    await waitUntil(() => waiting.length > 0, 10_000);

    // The person is asked about the site and the request, in their own language.
    expect(waiting[0]).toBe("dùng trình duyệt trên shop.example cho việc “Nộp đơn ở https://shop.example/form”");
    expect(getTask(services.runtime.db, taskId)?.state).toBe("waiting_approval");
    expect(workerStarted).toBe(false);
    expect(opened).toBe(0);
    expect(settled).toEqual([]);
  });
});
