import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { observationIdSchema, type AutomationAction, type Observation } from "@clarkcant/contracts";

import { createDriver } from "../src/driver.ts";
import type { BrowserDriver } from "../src/driver.ts";

/**
 * Browser driver integration tests.
 *
 * These launch a real Chromium against a real HTTP server, because the properties that matter
 * here are properties of a browser session and cannot be established with a mock: that a stale
 * element reference is refused rather than clicked, that a local stop invalidates an
 * outstanding plan, and that secret entry suspends capture.
 */

const PAGE = `<!doctype html>
<html><body>
  <h1 id="title">Fixture</h1>
  <button id="go">Continue</button>
  <button id="submit">Submit application</button>
  <input id="email" name="email" aria-label="Email" />
  <input id="pw" name="password" type="password" aria-label="Password" />
</body></html>`;

let server: Server;
let origin: string;
let dir: string;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  origin = `http://127.0.0.1:${address.port}`;
  dir = mkdtempSync(join(tmpdir(), "clarkcant-browser-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build an action bound to the driver under test.
 *
 * It reads the driver's real target id and version instead of assuming them: a hardcoded
 * target made every case fail the target check before reaching the behaviour it tested.
 */
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
    // Built through its schema rather than asserted: the test file is typechecked now, and a
    // plain string is not an ObservationId.
    observationId: observationIdSchema.parse(observationId),
  };
}

/**
 * Start a driver with the fixture already loaded and observed.
 *
 * Every test begins from the state a real session would be in, so none of them can pass
 * merely because the page never loaded.
 */
async function withFixture<T>(
  fn: (context: { driver: BrowserDriver; observation: Observation }) => Promise<T>,
): Promise<T> {
  const created = createDriver({
    profileName: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
    if (navigated.status !== "applied") {
      throw new Error(`the fixture page did not load: ${navigated.message}`);
    }
    const { observation } = await driver.observe();
    return await fn({ driver, observation });
  } finally {
    await driver.close();
  }
}

describe("a managed profile is a separate identity", () => {
  it("refuses to build a profile with no declared origins", () => {
    const created = createDriver({
      profileName: "empty",
      nodeId: "node_test",
      allowedOrigins: [],
      profileDir: join(dir, "never"),
    });
    expect(created.ok).toBe(false);
    expect(created.ok === false && created.refused).toContain("allowed origins");
  });

  it("refuses to navigate outside the declared origins", async () => {
    await withFixture(async ({ driver }) => {
      const result = await driver.act(
        action(driver, { observationId: "obs_none", operation: "navigate", arguments: { url: "https://example.invalid/" } }),
        { approvalGranted: false },
      );
      expect(result.status).toBe("refused");
      expect(result.message).toContain("declared origins");
    });
  });
});

describe("observation and action correlation (T53)", () => {
  it("stamps element references and reports the viewport", async () => {
    await withFixture(async ({ observation }) => {
      expect(observation.elementRefs.length).toBeGreaterThan(3);
      expect(observation.viewport?.width).toBeGreaterThan(0);
      // The fixture contains a password field, but it is not focused, so this is not secret
      // entry in progress and ordinary input remains available.
      expect(observation.containsSensitiveInput).toBe(false);
    });
  });

  it("refuses an observation it no longer retains", async () => {
    await withFixture(async ({ driver }) => {
      const result = await driver.act(action(driver, { observationId: "obs_gone" }), { approvalGranted: false });
      expect(result.status).toBe("refused");
      expect(result.requiresReobservation).toBe(true);
    });
  });

  it("refuses an element reference that is no longer in the document", async () => {
    await withFixture(async ({ driver, observation }) => {
      const result = await driver.act(
        action(driver, { observationId: observation.observationId, arguments: { elementRef: "el_does_not_exist" } }),
        { approvalGranted: false },
      );
      expect(result.status).toBe("refused");
      expect(result.message).toContain("observed again");
    });
  });

  it("applies a click on a real element and reports it as observed", async () => {
    await withFixture(async ({ driver, observation }) => {
      const buttonRef = await driver.findRefByName(observation, "Continue");
      const result = await driver.act(
        action(driver, { observationId: observation.observationId, arguments: { elementRef: buttonRef } }),
        { approvalGranted: false },
      );
      expect(result.status).toBe("applied");
      expect(result.verification).toBe("observed-applied");
    });
  });

  it("invalidates the plan when the target version moves", async () => {
    await withFixture(async ({ driver, observation }) => {
      // Navigating bumps the target version, so a plan captured against the old version must
      // not be replayed against the new document.
      await driver.act(
        action(driver, { observationId: "obs_none", operation: "navigate", arguments: { url: origin } }),
        { approvalGranted: false },
      );
      const stale = await driver.act(
        action(driver, {
          observationId: observation.observationId,
          expectedTargetVersion: "1",
          arguments: { elementRef: observation.elementRefs[0] },
        }),
        { approvalGranted: true },
      );
      expect(stale.status).toBe("refused");
    });
  });
});

describe("secret entry suspends capture and input (T56)", () => {
  it("reports sensitive input once a password field has focus, and refuses input", async () => {
    await withFixture(async ({ driver, observation }) => {
      const passwordRef = await driver.findRefByName(observation, "Password");
      // Focusing the field is an ordinary click; it is only after focus that the session counts
      // as secret entry.
      const focused = await driver.act(
        action(driver, { observationId: observation.observationId, arguments: { elementRef: passwordRef } }),
        { approvalGranted: false },
      );
      expect(focused.status).toBe("applied");

      const next = await driver.observe();
      expect(next.observation.containsSensitiveInput).toBe(true);

      const refused = await driver.act(
        action(driver, { observationId: next.observation.observationId, arguments: { elementRef: passwordRef } }),
        { approvalGranted: true },
      );
      expect(refused.status).toBe("refused");
      expect(refused.message).toContain("sensitive input");
    });
  });
});

describe("local stop and human takeover outrank a plan (T59)", () => {
  it("refuses every action after a stop, including navigation", async () => {
    await withFixture(async ({ driver, observation }) => {
      const before = driver.leaseEpoch;
      driver.stop("user pressed stop");
      expect(driver.leaseEpoch).toBeGreaterThan(before);

      const stopped = await driver.act(
        action(driver, { observationId: observation.observationId, arguments: { elementRef: observation.elementRefs[0] } }),
        { approvalGranted: true },
      );
      expect(stopped.status).toBe("refused");
      expect(stopped.message).toContain("stop");

      const navigate = await driver.act(
        action(driver, { observationId: "obs_none", operation: "navigate", arguments: { url: origin } }),
        { approvalGranted: true },
      );
      expect(navigate.status).toBe("refused");
    });
  });

  it("refuses input while a human has takeover", async () => {
    await withFixture(async ({ driver }) => {
      driver.setHumanTakeover(true);
      const { observation } = await driver.observe();
      const result = await driver.act(
        action(driver, { observationId: observation.observationId, arguments: { elementRef: observation.elementRefs[0] } }),
        { approvalGranted: true },
      );
      expect(result.status).toBe("refused");
      expect(result.message).toContain("takeover");
    });
  });
});

describe("consequential operations and unsupported operations", () => {
  it("refuses an unapproved submit", async () => {
    await withFixture(async ({ driver, observation }) => {
      const submitRef = await driver.findRefByName(observation, "Submit application");
      // A submit is not merely a click: it can send an application.
      const result = await driver.act(
        action(driver, {
          observationId: observation.observationId,
          arguments: { elementRef: submitRef },
          consequential: true,
        }),
        { approvalGranted: false },
      );
      expect(result.status).toBe("refused");
      expect(result.message).toContain("approval");
    });
  });

  it("refuses an operation it does not implement rather than substituting one", async () => {
    await withFixture(async ({ driver, observation }) => {
      const result = await driver.act(
        action(driver, { observationId: observation.observationId, operation: "launch-app" }),
        { approvalGranted: true },
      );
      expect(result.status).toBe("refused");
      expect(result.message).toContain("does not implement");
    });
  });
});
