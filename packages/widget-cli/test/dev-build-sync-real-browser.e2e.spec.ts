import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { chromium, type APIResponse, type Browser, type Page, type Route } from "playwright";

import { chromiumTestArgs } from "../../../tools/chromium-test-args.ts";
import { runCli } from "../src/cli.ts";
import { startDevHost, type DevHost } from "../src/dev-host.ts";

/**
 * The dev shell's build state, read in a real browser.
 *
 * The shell learns about builds two ways: the state it fetches, and the events on its stream. They travel on separate
 * connections, so these tests hold the fetch to put them in the order that went wrong, and restart the dev host on the
 * same port, which the stream reconnects to by itself.
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

async function tempPackage(): Promise<{ root: string; definitionPath: string; definition: string }> {
  const root = mkdtempSync(join(tmpdir(), "clark-devsync-"));
  created.push(root);
  expect(await runCli(["widget", "init", root, "--template", "form"])).toBe(0);
  const manifest = JSON.parse(readFileSync(join(root, "clarkcant.json"), "utf8")) as { facets: { kind: string; definition?: string }[] };
  const definitionPath = join(root, manifest.facets.find((facet) => facet.kind === "ui")?.definition ?? "");
  return { root, definitionPath, definition: readFileSync(definitionPath, "utf8") };
}

async function eventually(check: () => Promise<boolean>, message: string, attempts = 60): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${message}`);
}

const showsFailure = async (page: Page): Promise<boolean> => (await page.locator("[data-dev-build]").count()) > 0;

async function newPage(): Promise<Page> {
  browser = await chromium.launch({ headless: true, args: await chromiumTestArgs(chromium) });
  return browser.newPage();
}

describe("the dev shell's build state in Chromium", () => {
  it("keeps a failure the stream reported when the state fetched before it answers late", async () => {
    const { root, definitionPath } = await tempPackage();
    host = await startDevHost({ root, port: 0, watchFiles: false });
    const page = await newPage();

    // The fetch is answered by the dev host as it is now, while the files still build, and handed to the page later.
    let held: { route: Route; response: APIResponse } | undefined;
    await page.route("**/dev/api/build", async (route) => {
      held = { route, response: await route.fetch() };
    });
    await page.goto(host.url);
    await eventually(async () => held !== undefined, "the build state fetch");

    // A failure built after that answer reaches the shell first, on the stream.
    writeFileSync(definitionPath, "{ not json");
    expect((await host.rebuild())?.ok).toBe(false);
    await eventually(async () => showsFailure(page), "the failure on the shell");

    // The older answer arrives last, and must not say the files build again.
    const answered = page.waitForResponse("**/dev/api/build");
    await held?.route.fulfill({ response: held.response });
    await answered;
    for (let check = 0; check < 6; check += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await showsFailure(page)).toBe(true);
    }
  });

  it("asks again after the dev host restarts on the same port, and takes off a failure the new one does not have", async () => {
    const { root, definitionPath, definition } = await tempPackage();
    host = await startDevHost({ root, port: 0, watchFiles: false });
    const port = host.port;
    const page = await newPage();
    await page.goto(host.url);

    writeFileSync(definitionPath, "{ not json");
    expect((await host.rebuild())?.ok).toBe(false);
    await eventually(async () => showsFailure(page), "the failure on the shell");

    // Restarted with the files fixed: the new host builds them as it starts and tells no one, so the shell must ask.
    await host.close();
    writeFileSync(definitionPath, definition);
    host = await startDevHost({ root, port, watchFiles: false });
    expect(host.build()?.ok).toBe(true);
    await eventually(async () => !(await showsFailure(page)), "the failure taken off after the restart", 200);
  });
});
