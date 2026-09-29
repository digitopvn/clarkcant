import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type ActResult, type BrowserDriver, createDriver } from "@clarkcant/browser-playwright";
import { type AutomationAction, type Instant, type Principal, inboxResponseSchema, observationIdSchema } from "@clarkcant/contracts";
import { advanceResolving, applyTaskEvent, createTask } from "@clarkcant/core";
import { allRows, effectsForTask, getTask } from "@clarkcant/storage";

import { type BrowserActor, actWithLedger } from "../src/browser-effects.ts";
import { sweepUnknownEffects } from "../src/effect-notices.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A consequential browser action in the effect ledger (#273).
 *
 * The driver already refuses to resend a submit whose click timed out (T55); what it cannot do is keep that answer
 * past its own page. These tests hold the ledger to it: a submit written down before it is handed over, settled on
 * what the driver reported, and a timeout left as one `unknown` row and one notice a person can answer.
 */

const AT = "2026-09-30T08:00:00.000Z" as Instant;

let dir: string;
let services: NodeServices;
let owner: Principal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-browser-effects-"));
  services = bootNodeServices({ dataDir: dir, label: "browser effects test node" });
  owner = { principalId: services.runtime.identity.ownerPrincipalId as never, kind: "user", nodeId: services.runtime.identity.nodeId as never };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function runningTask(): { taskId: string; conversationId: string } {
  const deps = services.conductor;
  const conversationId = `conv_browser_${deps.newId("id")}`;
  deps.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(conversationId, deps.nodeId, AT, AT);
  const task = createTask(deps, { conversationId: conversationId as never, goal: "nộp đơn đăng ký", principal: owner });
  applyTaskEvent(deps, task.taskId, "resolve.start");
  advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: deps.nodeId });
  applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");
  return { taskId: task.taskId, conversationId };
}

function click(consequential: boolean, elementRef = "ref_submit"): AutomationAction {
  return {
    actionId: "act_submit",
    targetId: "tgt_form" as AutomationAction["targetId"],
    leaseEpoch: 1,
    operation: "click",
    arguments: { elementRef },
    expectedTargetVersion: "1",
    consequential,
    observationId: observationIdSchema.parse("obs_1"),
  };
}

/** An actor that answers what it is told to, and counts how often it was asked. */
function scripted(answer: ActResult | Error): BrowserActor & { calls: number } {
  const actor = {
    calls: 0,
    async act(): Promise<ActResult> {
      actor.calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return actor;
}

const APPLIED: ActResult = { status: "applied", verification: "observed-applied", message: "clicked", requiresReobservation: false };
const TIMED_OUT: ActResult = {
  status: "unknown",
  verification: "not-observed",
  message: "the click did not report completion in time; it may have landed",
  requiresReobservation: true,
};

function taskNotices(taskId: string): { dedup_key: string }[] {
  return allRows(services.runtime.db, "SELECT dedup_key FROM notifications WHERE dedup_key LIKE ?", `worker:${taskId}%`);
}

describe("a consequential browser action in the ledger", () => {
  it("confirms the effect when the driver reports it applied", async () => {
    const { taskId } = runningTask();

    const result = await actWithLedger({ services, taskId }, scripted(APPLIED), click(true), { approvalGranted: true });

    expect(result.status).toBe("applied");
    const [effect] = effectsForTask(services.runtime.db, taskId);
    expect(effect).toMatchObject({ state: "confirmed", capabilityRef: "browser.playwright@1", category: "external-write" });
    expect(effect?.intent).toBe("browser click ref_submit — tgt_form");
    expect(getTask(services.runtime.db, taskId)?.state).toBe("running");
    expect(taskNotices(taskId)).toEqual([]);
  });

  it("records a failed or refused action as not having happened", async () => {
    const { taskId } = runningTask();
    const failed: ActResult = { status: "failed", verification: "observed-absent", message: "the button was gone", requiresReobservation: true };

    await actWithLedger({ services, taskId }, scripted(failed), click(true), { approvalGranted: true });

    const [effect] = effectsForTask(services.runtime.db, taskId);
    expect(effect?.state).toBe("failed");
    expect(effect?.reconciliationEvidence).toContain("the button was gone");
  });

  it("leaves a timeout unknown, turns the task uncertain and writes exactly one notice", async () => {
    const { taskId } = runningTask();

    const result = await actWithLedger({ services, taskId }, scripted(TIMED_OUT), click(true), { approvalGranted: true });
    sweepUnknownEffects(services, "2026-09-30T08:05:00.000Z" as Instant);

    expect(result.status).toBe("unknown");
    expect(effectsForTask(services.runtime.db, taskId).map((effect) => effect.state)).toEqual(["unknown"]);
    expect(getTask(services.runtime.db, taskId)?.state).toBe("uncertain");
    expect(taskNotices(taskId)).toEqual([{ dedup_key: `worker:${taskId}` }]);
  });

  it("treats a driver that threw as unknown too: the click may have left before it did", async () => {
    const { taskId } = runningTask();

    await expect(
      actWithLedger({ services, taskId }, scripted(new Error("browser closed")), click(true), { approvalGranted: true }),
    ).rejects.toThrow("browser closed");

    expect(effectsForTask(services.runtime.db, taskId).map((effect) => effect.state)).toEqual(["unknown"]);
    expect(taskNotices(taskId)).toHaveLength(1);
  });

  it("does not hand a second consequential action to the driver while the first is unknown", async () => {
    const { taskId } = runningTask();
    await actWithLedger({ services, taskId }, scripted(TIMED_OUT), click(true), { approvalGranted: true });
    const next = scripted(APPLIED);

    const result = await actWithLedger({ services, taskId }, next, click(true, "ref_pay"), { approvalGranted: true });

    expect(result.status).toBe("refused");
    expect(result.message).toContain("browser click ref_submit");
    expect(next.calls).toBe(0);
    expect(effectsForTask(services.runtime.db, taskId)).toHaveLength(1);
  });

  it("passes an action with nothing outside to reconcile straight through, unrecorded", async () => {
    const { taskId } = runningTask();
    await actWithLedger({ services, taskId }, scripted(TIMED_OUT), click(true), { approvalGranted: true });
    const reader = scripted(APPLIED);

    const result = await actWithLedger({ services, taskId }, reader, click(false), { approvalGranted: false });

    expect(result.status).toBe("applied");
    expect(reader.calls).toBe(1);
    expect(effectsForTask(services.runtime.db, taskId)).toHaveLength(1);
  });
});

/**
 * The same, with a real browser and a real timeout: the page fires its request and then blocks, so the click has
 * landed by the time the driver gives up on it. Nothing is stubbed between the page and the ledger.
 */
describe("a submit that really timed out", () => {
  const BLOCK_MS = 6000;
  const PAGE = `<!doctype html>
<html><body>
  <button id="submit">Submit application</button>
  <script>
    document.querySelector("#submit").addEventListener("click", () => {
      navigator.sendBeacon("/submit", "application-payload");
      const until = Date.now() + ${BLOCK_MS};
      while (Date.now() < until) { /* block the main thread */ }
    });
  </script>
</body></html>`;

  let server: Server;
  let origin: string;
  let submissions = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/submit") {
        submissions += 1;
        request.resume();
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function driverAction(driver: BrowserDriver, overrides: Partial<AutomationAction>): AutomationAction {
    return {
      actionId: "act_1",
      targetId: driver.target.targetId,
      leaseEpoch: driver.leaseEpoch,
      operation: "click",
      arguments: {},
      expectedTargetVersion: driver.targetVersion,
      consequential: false,
      observationId: observationIdSchema.parse("obs_none"),
      ...overrides,
    };
  }

  it("writes an unknown row and one notice pointing at the task, and answers nothing twice", async () => {
    const { taskId, conversationId } = runningTask();
    const created = createDriver({
      profileName: `ledger-${Date.now()}`,
      nodeId: services.runtime.identity.nodeId,
      allowedOrigins: [origin],
      profileDir: join(dir, "profile"),
    });
    if (!created.ok) throw new Error(created.refused);
    const driver = created.driver;
    const ledger = { services, taskId };
    try {
      driver.startLease();
      const opened = await actWithLedger(ledger, driver, driverAction(driver, { operation: "navigate", arguments: { url: origin } }), {
        approvalGranted: false,
      });
      expect(opened.status).toBe("applied");
      const { observation } = await driver.observe();
      const submit = await driver.findRefByName(observation, "Submit application");
      submissions = 0;

      const result = await actWithLedger(
        ledger,
        driver,
        driverAction(driver, { observationId: observation.observationId, arguments: { elementRef: submit }, consequential: true }),
        { approvalGranted: true },
      );

      expect(result.status).toBe("unknown");
      expect(submissions).toBe(1);
    } finally {
      await driver.close();
    }

    expect(effectsForTask(services.runtime.db, taskId).map((effect) => effect.state)).toEqual(["unknown"]);
    expect(getTask(services.runtime.db, taskId)?.state).toBe("uncertain");

    // Swept again, as the node does on its own clock: still one notice, not a second.
    sweepUnknownEffects(services, "2026-09-30T08:10:00.000Z" as Instant);
    expect(taskNotices(taskId)).toEqual([{ dedup_key: `worker:${taskId}` }]);

    const gateway: GatewayDeps = { services, now: () => AT, newConversationId: () => "conv_unused" };
    const inbox = await handleRequest(gateway, {
      method: "GET",
      path: "/inbox",
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: "",
    });
    const notices = inboxResponseSchema.parse(inbox.body).notices.filter((notice) => notice.subject?.kind === "task");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.subject).toMatchObject({ kind: "task", taskId, conversationId });
    expect(notices[0]?.actions?.map((action) => action.id).slice(0, 2)).toEqual(["reconcile-confirmed", "reconcile-failed"]);
  }, 90_000);
});
