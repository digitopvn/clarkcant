import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { observationIdSchema, type AutomationAction, type Observation } from "@clarkcant/contracts";

import { createDriver } from "../src/driver.ts";
import type { BrowserDriver } from "../src/driver.ts";

/**
 * A submit that times out is not submitted again (T55).
 *
 * The dangerous case is not a click that failed. It is a click that *landed* while the driver was
 * still waiting: the request is on its way, the driver never hears back, and a retry sends it a
 * second time. For a form that is a duplicate application, an order, or a payment.
 *
 * The fixture reproduces exactly that. The button fires its request immediately and then blocks
 * the main thread long enough that the click never reports completion, so the submission has
 * genuinely happened by the time the driver gives up on it.
 */

/** How long the page blocks after firing its request, in milliseconds. */
const BLOCK_MS = 6000;

const PAGE = `<!doctype html>
<html><body>
  <h1>Application</h1>
  <button id="submit">Submit application</button>
  <p id="status">not submitted</p>
  <script>
    const button = document.querySelector("#submit");
    const status = document.querySelector("#status");
    button.addEventListener("click", () => {
      // Fire the real request first, so it has genuinely left, then make the click unable to
      // report completion. This is what makes a blind retry dangerous rather than merely wasteful.
      navigator.sendBeacon("/submit", "application-payload");
      const until = Date.now() + ${BLOCK_MS};
      while (Date.now() < until) { /* block the main thread */ }
      status.textContent = "submitted";
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;
let dir: string;
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
  dir = mkdtempSync(join(tmpdir(), "clarkcant-submit-once-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

type ActionOverrides = Omit<Partial<AutomationAction>, "observationId"> & { observationId: string };

function action(driver: BrowserDriver, overrides: ActionOverrides): AutomationAction {
  const { observationId, ...rest } = overrides;
  return {
    actionId: "act_1",
    targetId: driver.target.targetId,
    leaseEpoch: driver.leaseEpoch,
    operation: "click",
    arguments: {},
    expectedTargetVersion: driver.targetVersion,
    consequential: false,
    ...rest,
    observationId: observationIdSchema.parse(observationId),
  };
}

async function withPage<T>(
  fn: (context: { driver: BrowserDriver; observation: Observation }) => Promise<T>,
): Promise<T> {
  submissions = 0;
  const created = createDriver({
    profileName: `submit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    nodeId: "node_test",
    allowedOrigins: [origin],
    profileDir: join(dir, `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  });
  if (!created.ok) throw new Error(created.refused);

  const driver = created.driver;
  try {
    driver.startLease();
    const navigated = await driver.act(
      action(driver, { observationId: "obs_none", operation: "navigate", arguments: { url: origin } }),
      { approvalGranted: false },
    );
    if (navigated.status !== "applied") throw new Error(`the fixture did not load: ${navigated.message}`);
    const { observation } = await driver.observe();
    return await fn({ driver, observation });
  } finally {
    await driver.close();
  }
}

describe("a timed-out submit is not sent twice", () => {
  it("reports the outcome as unknown, not as failed", async () => {
    await withPage(async ({ driver, observation }) => {
      const submit = await driver.findRefByName(observation, "Submit application");
      const first = await driver.act(
        action(driver, {
          observationId: observation.observationId,
          actionId: "submit_1",
          arguments: { elementRef: submit },
          consequential: true,
        }),
        { approvalGranted: true },
      );

      // "failed" would invite a retry. The honest answer is that we do not know.
      expect(first.status).toBe("unknown");
      expect(first.requiresReobservation).toBe(true);
      // And it really did land: the request left before the click stopped reporting.
      expect(submissions).toBe(1);
    });
  }, 90_000);

  it("refuses to resend the same action, so the submission count stays at one", async () => {
    await withPage(async ({ driver, observation }) => {
      const submit = await driver.findRefByName(observation, "Submit application");
      const shared = {
        observationId: observation.observationId,
        actionId: "submit_1",
        arguments: { elementRef: submit },
        consequential: true,
      };

      const first = await driver.act(action(driver, shared), { approvalGranted: true });
      expect(first.status).toBe("unknown");
      expect(submissions).toBe(1);

      // The same plan, re-sent. This is what a naive retry does.
      const retry = await driver.act(action(driver, shared), { approvalGranted: true });

      expect(retry.status).toBe("refused");
      expect(retry.message).toContain("observe the page");
      // The number that matters: one application, not two.
      expect(submissions).toBe(1);
    });
  }, 90_000);

  it("allows the action again once the page has been observed", async () => {
    await withPage(async ({ driver, observation }) => {
      const submit = await driver.findRefByName(observation, "Submit application");
      const shared = {
        observationId: observation.observationId,
        actionId: "submit_1",
        arguments: { elementRef: submit },
        consequential: true,
      };

      await driver.act(action(driver, shared), { approvalGranted: true });
      expect(submissions).toBe(1);

      // Observing is how the unknown outcome stops being unknown, so it is what lifts the block.
      // The reference is looked up again because re-observing stamps a new set: the old reference
      // belongs to a document that has since been observed differently.
      const next = await driver.observe();
      const freshRef = await driver.findRefByName(next.observation, "Submit application");
      const retry = await driver.act(
        action(driver, {
          ...shared,
          observationId: next.observation.observationId,
          arguments: { elementRef: freshRef },
        }),
        { approvalGranted: true },
      );

      // The differential: without this, the previous test would also pass if the driver simply
      // refused every second click, which would prove nothing about the timeout guard.
      expect(retry.status).not.toBe("refused");
      expect(submissions).toBe(2);
    });
  }, 90_000);

  it("does not block a different action, because only the unknown one is suspect", async () => {
    await withPage(async ({ driver, observation }) => {
      const submit = await driver.findRefByName(observation, "Submit application");
      await driver.act(
        action(driver, {
          observationId: observation.observationId,
          actionId: "submit_1",
          arguments: { elementRef: submit },
          consequential: true,
        }),
        { approvalGranted: true },
      );

      const other = await driver.act(
        action(driver, {
          observationId: observation.observationId,
          actionId: "read_1",
          operation: "read-dom",
        }),
        { approvalGranted: false },
      );

      expect(other.status).toBe("applied");
    });
  }, 90_000);
});
