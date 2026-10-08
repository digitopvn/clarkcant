import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import { buildWidgetTooling } from "../../../tools/build-widget-tooling.mjs";
import { chromiumTestArgs } from "../../../tools/chromium-test-args.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";
import { runCli } from "../src/cli.ts";
import { startDevHost, type DevHost } from "../src/dev-host.ts";

/**
 * The sandboxed frame's modules, loaded by a real browser.
 *
 * Vite serves them only under a prefix that carries the dev host's nonce, and answers the frame's opaque origin only
 * there. A browser is what proves the frame still finds every module it imports that way, in a package's frame and a
 * catalog widget's, and again after a change to the files reloads it. An installed CLI has no Vite modules for a
 * catalog widget: it serves the release build's bundled runtime, under the same nonce.
 */

let host: DevHost | undefined;
let browser: Browser | undefined;
let installed: ChildProcess | undefined;
const created: string[] = [];
const links: string[] = [];

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await host?.close();
  host = undefined;
  if (installed !== undefined && installed.exitCode === null && installed.signalCode === null) {
    const exited = new Promise((done) => installed?.once("exit", done));
    installed.kill();
    await exited;
  }
  installed = undefined;
  // The links first, on their own: removing the stage must not reach through them into the workspace's dependencies.
  for (const link of links.splice(0)) unlinkSync(link);
  // The stopped dev host can hold its temporary files for a moment on Windows.
  for (const root of created.splice(0)) await removeTestDirectory(root);
});

/** The widget CLI's own dependencies in this workspace: what installing the published package puts beside it. */
const CLI_DEPENDENCIES = fileURLToPath(new URL("../node_modules", import.meta.url));

/**
 * `clark widget dev` from the published package's layout: the release build's bundled `lib/` and `runtime/`, run by
 * Node, with no workspace source in reach. Resolves with the URL it prints.
 */
async function startInstalledDev(args: readonly string[]): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "clark-installed-"));
  created.push(scratch);
  await buildWidgetTooling({ outRoot: join(scratch, "stage") });
  const cli = join(scratch, "stage", "widget-cli");
  // Each dependency the published manifest declares, linked to where pnpm installed it for this workspace. The link
  // names the real directory: pnpm's own links are relative, so they would not resolve from another place.
  const manifest = JSON.parse(readFileSync(join(cli, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  for (const name of Object.keys(manifest.dependencies)) {
    const link = join(cli, "node_modules", ...name.split("/"));
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(CLI_DEPENDENCIES, ...name.split("/"))), link, "junction");
    links.push(link);
  }
  const temp = join(scratch, "tmp");
  mkdirSync(temp);
  const child = spawn(process.execPath, [join(cli, "lib", "cli.js"), "widget", "dev", ...args, "--port", "0"], {
    cwd: scratch,
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  installed = child;
  let output = "";
  return new Promise((done, failed) => {
    const timer = setTimeout(() => failed(new Error(`clark widget dev printed no URL within 60s:\n${output}`)), 60_000);
    const read = (chunk: unknown): void => {
      output += String(chunk);
      const match = /dev host: (http:\/\/127\.0\.0\.1:\d+)\/?/i.exec(output);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      done(`${match[1]}/`);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      failed(new Error(`clark widget dev exited ${String(code)} before serving:\n${output}`));
    });
  });
}

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

  it("draws a catalog widget in an installed CLI from its bundled runtime under the nonce", async () => {
    const url = await startInstalledDev(["--builtin", "canvas.line@1"]);
    const nonce = ((await (await fetch(`${url}dev/api/state`)).json()) as { bridgeNonce: string }).bridgeNonce;
    const { page, modules, failures } = await watchedPage();
    await page.goto(url);

    const drawn = async (): Promise<boolean> =>
      page
        .frameLocator("iframe[data-dev-frame]")
        .locator("#cc-catalog-root")
        .evaluate((element) => element.childElementCount > 0)
        .catch(() => false);
    await eventually(drawn, `the catalog widget\n${failures.join("\n")}`);
    expect(modules).toContain(`/dev/frame/${nonce}/catalog-runtime.js`);
    // The bundle imports nothing, so no module path outside the nonce is asked for, and Vite serves none.
    expect(modules.some((path) => path.startsWith("/runtime/") || path.startsWith("/dev/modules/"))).toBe(false);
    expect(failures).toEqual([]);

    // The opaque origin is answered under the nonce alone: not on the bare path, and not to another website.
    const probes = [
      { path: "/runtime/catalog-runtime.js", origin: "null" },
      { path: `/dev/frame/${nonce}/catalog-runtime.js`, origin: "https://attacker.test" },
    ];
    for (const { path, origin } of probes) {
      const answer = await fetch(new URL(path, url), { headers: { origin, "sec-fetch-dest": "script" } });
      await answer.text();
      expect(answer.headers.get("access-control-allow-origin"), `${origin} ${path}`).toBeNull();
    }
  }, 240_000);
});
