import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import { startDevHost, type DevHost } from "../src/dev-host.ts";
import { serviceStatus } from "../src/service-simulator.ts";

let host: DevHost | undefined;
let browser: Browser | undefined;

async function shellShows(page: Page, attribute: string, value: string): Promise<boolean> {
  // A dev shell reloads after every control change; its controls answer only once its script has said so.
  return page.evaluate(([name, expected]) => document.body.dataset.devShellReady === "true" && document.body.getAttribute(name) === expected, [attribute, value] as const);
}

async function shellChange(page: Page, change: () => Promise<unknown>): Promise<void> {
  // Every control change reloads the shell. Wait for that reload and for the new page's script, so the next change
  // is not made on a page that is about to go away or that does not listen yet.
  await eventually(async () => shellReady(page), "dev shell ready");
  const reloaded = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await change();
  await reloaded;
  await eventually(async () => shellReady(page), "dev shell ready after reload");
}

async function shellReady(page: Page): Promise<boolean> {
  return page.evaluate(() => document.body?.dataset.devShellReady === "true").catch(() => false);
}

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${message}`);
}

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await host?.close();
  host = undefined;
});

describe("service simulator in Chromium", () => {
  it("delivers loading, readiness, offline refusal, fixture results, malformed refusal, and restart recovery", async () => {
    const packageRoot = `${process.cwd()}/apps/web/e2e/fixtures/notes-service`;
    host = await startDevHost({ root: packageRoot, port: 0, watchFiles: false });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requests: string[] = [];
    const diagnostics: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    page.on("console", (message) => { if (message.type() === "error") diagnostics.push(message.text()); });
    page.on("pageerror", (error) => diagnostics.push(error.message));
    page.on("requestfailed", (request) => diagnostics.push(`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`));
    await page.goto(host.url);

    const frame = page.frameLocator("iframe[data-dev-frame]");
    const add = frame.locator("[data-notes-add]");
    const list = frame.locator("[data-notes-list]");
    const widget = frame.locator("[data-widget-ready]");
    try {
      await widget.waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics.join("\n")}`, { cause: error });
    }
    await eventually(async () => (await widget.getAttribute("data-notes-announced")) === "true", "service availability announcement");
    expect(await add.isDisabled()).toBe(true);
    expect(await frame.locator("[data-notes-unavailable]").textContent()).toContain("service has not started yet");

    // The shell remains operable from the keyboard and exposes a visible focus indicator.
    await page.keyboard.press("Tab");
    const visibleFocus = await page.evaluate(() => {
      const element = document.activeElement;
      return element instanceof HTMLElement && getComputedStyle(element).outlineWidth !== "0px";
    });
    expect(visibleFocus).toBe(true);

    await shellChange(page, () => page.locator('[data-dev-action="theme"][data-dev-value="light"]').click());
    await eventually(async () => shellShows(page, "data-dev-theme", "light"), "light theme");
    await shellChange(page, () => page.locator('[data-dev-action="theme"][data-dev-value="dark"]').click());
    await eventually(async () => shellShows(page, "data-dev-theme", "dark"), "dark theme");

    await shellChange(page, () => page.getByLabel("Readiness for com.example.notes.add@1").selectOption("ready"));
    await eventually(
      async () => host?.state().serviceReadiness["com.example.notes.add@1"]?.healthy === true,
      "ready service state",
    );
    expect(host.state().serviceReadiness["com.example.notes.add@1"]?.healthy).toBe(true);
    await eventually(async () => !(await add.isDisabled()), "ready add binding");
    await add.click();
    await eventually(async () => (await frame.locator("[data-notes-output]").textContent())?.includes("Saved from the development service simulator") === true, "fixture action result");

    await shellChange(page, () => page.getByLabel("Readiness for com.example.notes.add@1").selectOption("blocked"));
    await eventually(async () => await add.isDisabled(), "blocked add binding");
    expect(await frame.locator("[data-notes-unavailable]").textContent()).toContain("service is blocked");

    await shellChange(page, () => page.getByLabel("Readiness for com.example.notes.add@1").selectOption("ready"));
    await shellChange(page, () => page.getByLabel("Readiness for com.example.notes.list@1").selectOption("unhealthy"));
    await eventually(async () => (await page.locator("[data-dev-service-health]").textContent()) === "degraded", "degraded service state");
    expect(await add.isDisabled()).toBe(false);
    expect(await list.isDisabled()).toBe(true);

    await shellChange(page, () => page.locator('input[data-dev-action="offline"]').check());
    await eventually(async () => await add.isDisabled(), "offline binding refusal");
    expect(await frame.locator("[data-notes-unavailable]").textContent()).toContain("the node is offline");
    const offlineResult = await frame.locator("body").evaluate(async () => {
      const widgetWindow = window as unknown as {
        clarkcantWidget: {
          api: () => {
            actions: {
              invoke: (binding: string, input: Record<string, unknown>, invocationId: string) => Promise<string | undefined>;
            };
          };
        };
      };
      const api = widgetWindow.clarkcantWidget.api();
      try {
        await api.actions.invoke("binding_notes_add", { text: "offline" }, "offline-invocation");
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(offlineResult).toContain("offline");

    await shellChange(page, () => page.locator('input[data-dev-action="offline"]').uncheck());
    await eventually(async () => shellReady(page), "dev shell ready");
    await page.locator('[data-dev-action="service-restart"]').click();
    await eventually(async () => (await page.locator('[data-dev-status="loading"]').count()) === 4, "restart loading state");
    await eventually(async () => await add.isDisabled(), "restart disables the add binding");
    await eventually(async () => await list.isDisabled(), "restart disables the list binding");
    await eventually(async () => !(await list.isDisabled()), "restart recovery");
    expect(await page.locator('[data-dev-status="ready"]').count()).toBe(4);

    await frame.locator("[data-notes-malformed]").click();
    await eventually(async () => (await frame.locator("[data-notes-output]").textContent())?.includes("malformed response") === true, "malformed fixture refusal");

    const hostUrl = host.url;
    expect(requests.every((url) => url.startsWith(hostUrl))).toBe(true);
    const finalState = await host.state();
    expect(Object.values(finalState.serviceReadiness).every((entry) => serviceStatus(entry) === "ready")).toBe(true);

    const framePath = new URL(await page.locator("iframe[data-dev-frame]").getAttribute("src") ?? "", host.url).pathname;
    const framePrefix = framePath.slice(0, framePath.indexOf("/widgets/board/"));
    const assetUrl = `${host.url}${framePrefix.slice(1)}/widgets/board/main.js`;
    const opaqueFrame = await fetch(assetUrl, { headers: { origin: "null" } });
    const unscopedOpaqueFrame = await fetch(`${host.url}widgets/board/main.js`, { headers: { origin: "null" } });
    const foreignWebsite = await fetch(assetUrl, { headers: { origin: "https://example.invalid", referer: "https://example.invalid/" } });
    expect(opaqueFrame.headers.get("access-control-allow-origin")).toBe("null");
    expect(unscopedOpaqueFrame.headers.get("access-control-allow-origin")).toBeNull();
    expect(foreignWebsite.headers.get("access-control-allow-origin")).toBeNull();
    const forgedAction = await fetch(`${host.url}dev/api/service-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action.invoke",
        nonce: "forged-nonce-123456",
        actionBindingId: "binding_notes_add",
        expectedRevision: 0,
        input: {},
        invocationId: "forged-invocation",
      }),
    });
    expect(forgedAction.status).toBe(400);
  }, 60_000);
});
