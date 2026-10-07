import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDriver } from "../src/driver.ts";

/**
 * Closing the driver while Chromium is still starting.
 *
 * A person's Stop can land during a browser task's cold start. The browser that finishes starting afterwards must be
 * closed by that close, not left running with the profile folder held (on Windows the lock then makes the profile's
 * removal fail with EPERM). This launches a real Chromium: whether a process is left behind is a property of the real
 * browser, which a mock cannot show.
 */

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-close-launch-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("closing the driver while its browser is starting", () => {
  it("waits for the start, closes the browser it started, and starts nothing afterwards", async () => {
    // Every browser the driver starts, as Playwright hands it back, so the test can see whether it is still running.
    const launched: BrowserContext[] = [];
    const launch = chromium.launchPersistentContext.bind(chromium);
    const spy = vi.spyOn(chromium, "launchPersistentContext").mockImplementation(async (...args) => {
      const context = await launch(...args);
      launched.push(context);
      return context;
    });

    const profileDir = join(dir, "profile");
    const created = createDriver({
      profileName: "close-during-launch",
      nodeId: "node_test",
      allowedOrigins: ["http://127.0.0.1"],
      profileDir,
    });
    if (!created.ok) throw new Error(created.refused);
    const driver = created.driver;

    // Observing starts the browser; the close arrives while it is still starting.
    const observing = driver.observe();
    // It rejects while close() is awaited; handled here so the rejection is not reported as unhandled before then.
    void observing.catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    try {
      await driver.close();

      // (a) close() resolved only after the browser that start produced was up and then closed again.
      expect(launched).toHaveLength(1);
      expect(launched[0]?.browser()?.isConnected()).toBe(false);
      // The start that was under way is not handed out as a usable page.
      await expect(observing).rejects.toThrow(/closed/);

      // (b) No browser from that start is left holding the profile: a fresh browser can take the same profile folder.
      const again = await launch(profileDir, { headless: true });
      expect(again.browser()?.isConnected()).toBe(true);
      await again.close();

      // (c) A closed driver starts nothing again.
      await expect(driver.observe()).rejects.toThrow(/closed/);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      // Whatever the outcome, no browser this test caused outlives it.
      await observing.catch(() => undefined);
      await Promise.all(launched.map((context) => context.close().catch(() => undefined)));
    }
  });
});
