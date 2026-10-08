import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium, type APIResponse, type Browser, type Page, type Route } from "playwright";

import { chromiumTestArgs } from "../../../tools/chromium-test-args.ts";
import { runCli } from "../src/cli.ts";
import { startDevHost, type DevHost } from "../src/dev-host.ts";

/**
 * The dev shell's build state, read in a real browser.
 *
 * The shell learns about builds two ways: the state it fetches, and the events on its stream. They travel on separate
 * connections, so these tests hold the fetch to put them in the order that went wrong, set the dev host's clock back to
 * show that no clock decides which is current, and restart the dev host on the same port, which the stream reconnects
 * to by itself.
 */

let host: DevHost | undefined;
let browser: Browser | undefined;
const created: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
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

/** Until the shell has handled the build state it fetched, whether it showed it or not. */
const synced = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => document.body.dataset.devBuildSynced === "true");
};

/** A failed build made while the dev host's clock reads an hour earlier than it did a moment ago. */
async function failWithClockSetBack(definitionPath: string): Promise<void> {
  const earlier = new Date(Date.now() - 3_600_000);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(earlier);
  try {
    writeFileSync(definitionPath, "{ not json");
    const build = await host?.rebuild();
    expect(build?.ok).toBe(false);
    expect(build?.at).toBe(earlier.toISOString());
  } finally {
    vi.useRealTimers();
  }
}

async function newPage(): Promise<Page> {
  browser = await chromium.launch({ headless: true, args: await chromiumTestArgs(chromium) });
  return browser.newPage();
}

/** Holds the shell's build state fetch once the dev host has answered it, so the test decides when the page reads it. */
async function holdBuildFetch(page: Page): Promise<() => { route: Route; response: APIResponse } | undefined> {
  let held: { route: Route; response: APIResponse } | undefined;
  await page.route("**/dev/api/build", async (route) => {
    held = { route, response: await route.fetch() };
  });
  return () => held;
}

/** Where the shell's frame points, or null while the shell is not on screen (reloading, or an error page). */
const frameSource = async (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector("[data-dev-frame]")?.getAttribute("src") ?? null).catch(() => null);

/**
 * The frame address prefix of the dev host process answering on its port now. Asked on a connection of its own, since a
 * pooled one may still lead to the process that was there before.
 */
async function framePrefixOf(current: DevHost): Promise<string> {
  const body = await new Promise<string>((resolveBody, reject) => {
    get(new URL("/dev/api/build", current.url), { agent: false }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolveBody(text));
    }).on("error", reject);
  });
  return `/dev/frame/${(JSON.parse(body) as { bridgeNonce: string }).bridgeNonce}/`;
}

/** Until the shell has reloaded from the dev host process on the port now, and handled the build state it fetched. */
async function reloadedOnto(page: Page, current: DevHost): Promise<void> {
  const prefix = await framePrefixOf(current);
  await eventually(async () => (await frameSource(page))?.startsWith(prefix) === true, "the shell reloaded from the restarted dev host", 200);
  await synced(page);
}

describe("the dev shell's build state in Chromium", () => {
  it("keeps a failure the stream reported when the state fetched before it answers late", async () => {
    const { root, definitionPath } = await tempPackage();
    host = await startDevHost({ root, port: 0, watchFiles: false });
    const page = await newPage();

    // The fetch is answered by the dev host as it is now, while the files still build, and handed to the page later.
    const held = await holdBuildFetch(page);
    await page.goto(host.url);
    await eventually(async () => held() !== undefined, "the build state fetch");

    // A failure built after that answer reaches the shell first, on the stream.
    writeFileSync(definitionPath, "{ not json");
    expect((await host.rebuild())?.ok).toBe(false);
    await eventually(async () => showsFailure(page), "the failure on the shell");

    // The older answer arrives last, and must not say the files build again.
    const answer = held();
    await answer?.route.fulfill({ response: answer.response });
    await synced(page);
    expect(await showsFailure(page)).toBe(true);
  });

  it("keeps a failure the stream reported even when the dev host's clock dates it before the answer that arrives later", async () => {
    const { root, definitionPath } = await tempPackage();
    host = await startDevHost({ root, port: 0, watchFiles: false });
    const page = await newPage();

    const held = await holdBuildFetch(page);
    await page.goto(host.url);
    await eventually(async () => held() !== undefined, "the build state fetch");

    // The clock steps back, so the failure on the stream reads as built an hour before the answer still held.
    await failWithClockSetBack(definitionPath);
    await eventually(async () => showsFailure(page), "the failure on the shell");

    // The answer is older news than any event since the stream opened, whatever its time says.
    const answer = held();
    await answer?.route.fulfill({ response: answer.response });
    await synced(page);
    expect(await showsFailure(page)).toBe(true);
  });

  it("shows a failure from the stream that the dev host's clock dates before the build state it fetched", async () => {
    const { root, definitionPath } = await tempPackage();
    host = await startDevHost({ root, port: 0, watchFiles: false });
    const page = await newPage();
    await page.goto(host.url);
    await synced(page);
    expect(await showsFailure(page)).toBe(false);

    await failWithClockSetBack(definitionPath);
    await eventually(async () => showsFailure(page), "the failure on the shell");
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
    await reloadedOnto(page, host);
    expect(await showsFailure(page)).toBe(false);
  });

  it("shows the failure a dev host restarted on the same port started with", async () => {
    const { root } = await tempPackage();
    host = await startDevHost({ root, port: 0, watchFiles: false });
    const port = host.port;
    const page = await newPage();
    await page.goto(host.url);
    await synced(page);
    expect(await showsFailure(page)).toBe(false);

    // A fixture that does not read fails the build but still lets the dev host start; it reports that to no one.
    await host.close();
    writeFileSync(join(root, "fixtures", "broken.json"), "{ not json");
    host = await startDevHost({ root, port, watchFiles: false });
    expect(host.build()?.ok).toBe(false);
    await reloadedOnto(page, host);
    expect(await showsFailure(page)).toBe(true);
  });

  it("loads the frame from the new dev host after a restart on the same port", async () => {
    const { root } = await tempPackage();
    host = await startDevHost({ root, port: 0, watchFiles: false });
    const port = host.port;
    const page = await newPage();
    await page.goto(host.url);
    await synced(page);
    const oldPrefix = await framePrefixOf(host);
    expect(await frameSource(page)).toMatch(new RegExp(`^${oldPrefix}`));

    // Watched from before the restart, so a reload that comes quickly is not missed.
    const loaded = page.waitForResponse(
      (response) => {
        const path = new URL(response.url()).pathname;
        return path.startsWith("/dev/frame/") && !path.startsWith(oldPrefix) && response.status() === 200;
      },
      { timeout: 15_000 },
    );
    await host.close();
    host = await startDevHost({ root, port, watchFiles: false });
    const prefix = await framePrefixOf(host);
    expect(prefix).not.toBe(oldPrefix);

    // The old frame address belongs to a process that is gone; the shell must load the frame from the one serving now.
    expect(new URL((await loaded).url()).pathname.startsWith(prefix)).toBe(true);
    await reloadedOnto(page, host);
  });
});
