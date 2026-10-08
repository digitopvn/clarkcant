import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDriver } from "../src/driver.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * The browser started, but its page could not be opened.
 *
 * A start that fails after Chromium is up must close that Chromium. Left running, it keeps holding the profile folder,
 * and the next call starts a second browser on the same profile. This launches a real Chromium, because whether a
 * browser is left behind is a property of the real browser; only the page opening is made to fail.
 */

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-new-page-failure-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await removeTestDirectory(dir);
});

describe("a browser whose page could not be opened", () => {
  it("is closed, and the next call starts one browser cleanly on the same profile", async () => {
    const launched: BrowserContext[] = [];
    const launch = chromium.launchPersistentContext.bind(chromium);
    vi.spyOn(chromium, "launchPersistentContext").mockImplementation(async (...args) => {
      const context = await launch(...args);
      if (launched.length === 0) {
        // The first start has no page to reuse and cannot open one.
        vi.spyOn(context, "pages").mockReturnValue([]);
        vi.spyOn(context, "newPage").mockRejectedValue(new Error("newPage failed"));
      }
      launched.push(context);
      return context;
    });

    const created = createDriver({
      profileName: "new-page-failure",
      nodeId: "node_test",
      allowedOrigins: ["http://127.0.0.1"],
      profileDir: join(dir, "profile"),
    });
    if (!created.ok) throw new Error(created.refused);
    const driver = created.driver;

    try {
      await expect(driver.observe()).rejects.toThrow(/newPage failed/);
      // The browser that start produced is closed, not left holding the profile.
      expect(launched).toHaveLength(1);
      expect(launched[0]?.browser()?.isConnected()).toBe(false);

      // The next call starts afresh and gets a working page.
      const result = await driver.observe();
      expect(result.url).toBe("about:blank");
      expect(launched).toHaveLength(2);
      // Only one browser holds the profile: the first is gone, the second is the one in use.
      expect(launched.map((context) => context.browser()?.isConnected())).toEqual([false, true]);
    } finally {
      await driver.close();
      await Promise.all(launched.map((context) => context.close().catch(() => undefined)));
    }
  });
});
