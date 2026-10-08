import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import { chromiumTestArgs } from "../../../tools/chromium-test-args.ts";
import { runCli } from "../src/cli.ts";
import { startDevHost, type DevHost } from "../src/dev-host.ts";

/**
 * The sandboxed frame's modules, loaded by a real browser.
 *
 * Vite serves them only under a prefix that carries the dev host's nonce, and answers the frame's opaque origin only
 * there. A browser is what proves the frame still finds every module it imports that way, in a package's frame and a
 * catalog widget's, and again after a change to the files reloads it.
 */

let host: DevHost | undefined;
let browser: Browser | undefined;
const created: string[] = [];

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await host?.close();
  host = undefined;
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${message}`);
}

/** A page that records the module requests it made and every failure, so a missing module names itself. */
async function watchedPage(): Promise<{ page: Page; modules: string[]; failures: string[] }> {
  browser = await chromium.launch({ headless: true, args: await chromiumTestArgs(chromium) });
  const page = await browser.newPage();
  const modules: string[] = [];
  const failures: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") modules.push(new URL(request.url()).pathname);
  });
  page.on("requestfailed", (request) => failures.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.url()}: ${String(response.status())}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  return { page, modules, failures };
}

const nonceOf = async (current: DevHost): Promise<string> =>
  ((await (await fetch(`${current.url}dev/api/state`)).json()) as { bridgeNonce: string }).bridgeNonce;

describe("the frame's modules in Chromium", () => {
  it("loads a package's frame runtime under the nonce, and again after a change reloads it", async () => {
    const root = mkdtempSync(join(tmpdir(), "clark-devmodules-"));
    created.push(root);
    expect(await runCli(["widget", "init", root, "--template", "form"])).toBe(0);
    // The template's entry loads `./main.js`, which an author writes; this one says which version of it ran.
    const script = join(root, "widgets", "main", "main.js");
    const version = (name: string): string => `document.body.dataset.version = ${JSON.stringify(name)};\n`;
    writeFileSync(script, version("first"));
    host = await startDevHost({ root, port: 0 });
    const nonce = await nonceOf(host);
    const { page, modules, failures } = await watchedPage();
    await page.goto(host.url);

    const runtimeReady = (expected: string) => async (): Promise<boolean> =>
      page
        .frameLocator("iframe[data-dev-frame]")
        .locator("body")
        .evaluate(
          (body, name) => typeof (window as unknown as { clarkcantWidget?: unknown }).clarkcantWidget === "object" && body.dataset.version === name,
          expected,
        )
        .catch(() => false);
    await eventually(runtimeReady("first"), `the frame's runtime\n${failures.join("\n")}`);
    const viteModules = modules.filter((path) => path.startsWith("/dev/modules/"));
    expect(viteModules.length).toBeGreaterThan(0);
    expect(viteModules.every((path) => path.startsWith(`/dev/modules/${nonce}/`))).toBe(true);
    expect(modules.some((path) => path.startsWith("/@"))).toBe(false);

    const reloaded = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
    writeFileSync(script, version("second"));
    await reloaded;
    expect(host.reloads()).toBeGreaterThan(0);
    await eventually(runtimeReady("second"), `the frame's runtime after the reload\n${failures.join("\n")}`);
    expect(failures).toEqual([]);
  }, 60_000);

  it("draws a catalog widget from modules under the nonce", async () => {
    host = await startDevHost({ builtin: "canvas.note@1", port: 0, watchFiles: false });
    const nonce = await nonceOf(host);
    const { page, modules, failures } = await watchedPage();
    await page.goto(host.url);

    const drawn = async (): Promise<boolean> =>
      page
        .frameLocator("iframe[data-dev-frame]")
        .locator("#cc-catalog-root")
        .evaluate((element) => element.childElementCount > 0)
        .catch(() => false);
    await eventually(drawn, `the catalog widget\n${failures.join("\n")}`);
    expect(modules.some((path) => path.startsWith(`/dev/modules/${nonce}/src/catalog-runtime.tsx`))).toBe(true);
    expect(modules.some((path) => path.startsWith("/@") || path.startsWith("/src/"))).toBe(false);
    expect(failures).toEqual([]);
  }, 60_000);
});
