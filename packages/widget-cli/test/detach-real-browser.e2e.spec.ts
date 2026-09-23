import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import { runCli } from "../src/cli.ts";
import { startDevHost, type DevHost } from "../src/dev-host.ts";
import { runConformance } from "../src/conformance.ts";
import type { FrameFacts } from "../src/dev-shell.ts";

/**
 * Detach, driven against a real dev host in a real Chromium.
 *
 * `interaction.detach` used to be permanently `requires-dev-host`: a dev host was one window with nothing to
 * detach into. It now has a real detached window and a real lease (`dev-lease.ts`, over `@clarkcant/core`'s
 * `claimLiveOwner`/`releaseLiveOwner` — the same functions `apps/desktop` calls), so this test opens the dev host
 * for real, clicks Detach, waits for the real popup Chromium opens, clicks Reattach in it, and polls the lease's
 * own HTTP endpoint at each step. The fact this test hands to `runConformance` is not asserted by this file; it is
 * read back from the server after driving the browser through the whole handoff, which is what makes it a fact and
 * not a hope.
 */

let devHost: DevHost | undefined;
let browser: Browser | undefined;
const created: string[] = [];

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await devHost?.close();
  devHost = undefined;
  const { rmSync } = await import("node:fs");
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function tempPackage(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "clark-widget-detach-"));
  created.push(root);
  expect(await runCli(["widget", "init", root, "--template", "form"])).toBe(0);
  return root;
}

async function currentLeaseSurface(baseUrl: string): Promise<string | undefined> {
  const response = await fetch(`${baseUrl}dev/api/live-owner`);
  const body = (await response.json()) as { current: { surface: string } | null };
  return body.current?.surface;
}

describe("detach against a real browser", () => {
  it("moves the lease to a real detached window and back, with never more than one owner", async () => {
    const root = await tempPackage();
    devHost = await startDevHost({ root, port: 0, watchFiles: false });
    const baseUrl = devHost.url;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const shell = await context.newPage();
    await shell.goto(baseUrl);

    // The shell claims the lease for itself on load, before anything is detached.
    await expect
      .poll(async () => currentLeaseSurface(baseUrl))
      .toBe("inline");

    // Clicking Detach releases the shell's own claim and opens a real second window.
    const [detached] = await Promise.all([
      context.waitForEvent("page"),
      shell.click("[data-dev-detach='true']"),
    ]);
    await detached.waitForLoadState();

    // The polled surface after the popup is up is the fact the check cares about: exactly one owner, and it moved.
    await expect.poll(async () => currentLeaseSurface(baseUrl)).toBe("detached");

    // Nothing about the shell reclaimed the lease while the detached window is still open: a claim attempted from
    // the shell right now would be refused, which is the property "one owner" actually means.
    const wouldBeRefused = await shell.evaluate(async (base: string) => {
      const response = await fetch(`${base}dev/api/live-owner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerToken: "would-be-a-second-owner", surface: "inline" }),
      });
      return (await response.json()) as { ok: boolean };
    }, baseUrl);
    const sawShellClaimedWhileDetachedOpen = wouldBeRefused.ok === true;
    expect(sawShellClaimedWhileDetachedOpen).toBe(false);

    // Reattach: click the detached window's own control, which releases its claim, tells the shell over the
    // BroadcastChannel, and closes the window - exactly the desktop shell's "release before the next claim" order.
    await detached.click("[data-detached-reattach='true']");
    await detached.waitForEvent("close");

    await expect
      .poll(async () => currentLeaseSurface(baseUrl))
      .toBe("inline");

    // The fact set this whole test exists to produce: read from the server, not invented.
    const detach: NonNullable<FrameFacts["detach"]> = {
      afterDetach: "detached",
      everDoubleOwned: sawShellClaimedWhileDetachedOpen,
      afterReattach: "inline",
    };

    const result = runConformance(root, {
      frames: {
        tabbable: [],
        targets: [],
        images: [],
        textOverMotion: false,
        zeroDurationAnimation: false,
        declaredTextFallback: "fallback",
        detach,
      },
    });
    const check = result.checks.find((entry) => entry.id === "interaction.detach");
    expect(check?.status).toBe("pass");
  }, 30_000);
});
