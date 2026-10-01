import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import { runCli } from "../src/cli.ts";
import { startDevHost, type DevHost } from "../src/dev-host.ts";

let host: DevHost | undefined;
let browser: Browser | undefined;
let packageRoot: string | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await host?.close();
  host = undefined;
  if (packageRoot !== undefined) rmSync(packageRoot, { recursive: true, force: true });
  packageRoot = undefined;
});

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${message}`);
}

describe("semantic inspector and composition simulator in Chromium", () => {
  it("shows normalized frame state and deltas, validates simulated events, and refuses invalid inputs", async () => {
    packageRoot = mkdtempSync(join(tmpdir(), "clark-semantic-browser-"));
    expect(await runCli(["widget", "init", packageRoot, "--template", "form"])).toBe(0);

    const definitionPath = join(packageRoot, "widgets", "main", "widget.json");
    const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as Record<string, unknown>;
    definition.eventSchemas = {
      "demo.changed": {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    };
    writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(
      join(packageRoot, "widgets", "main", "main.js"),
      `const root = document.getElementById("root");
function draw() {
  const runtime = window.clarkcantWidget;
  if (runtime === undefined || runtime.status() !== "ready") { setTimeout(draw, 20); return; }
  if (root.dataset.drawn === "true") return;
  root.dataset.drawn = "true";
  const api = runtime.api();
  const long = document.createElement("button");
  long.type = "button";
  long.textContent = "Publish long";
  long.addEventListener("click", () => api.semantic.publish("quarterly widget summary ".repeat(20), ["row-1"], { query: "north region ".repeat(24) }));
  const changed = document.createElement("button");
  changed.type = "button";
  changed.textContent = "Publish update";
  changed.addEventListener("click", () => api.semantic.publish("Updated sample", ["row-2"], { query: "second" }));
  const emit = document.createElement("button");
  emit.type = "button";
  emit.textContent = "Emit declared event";
  emit.addEventListener("click", () => api.events.emit("demo.changed", { count: 3 }));
  root.append(long, changed, emit);
  root.setAttribute("data-widget-ready", "true");
  api.semantic.publish("Initial sample", ["row-0"], { query: "first" });
}
draw();\n`,
    );

    host = await startDevHost({ root: packageRoot, port: 0, watchFiles: false });
    const shellHtml = await (await fetch(host.url)).text();
    expect(shellHtml).toContain("demo.changed");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ colorScheme: "light" });
    const diagnostics: string[] = [];
    page.on("pageerror", (error) => diagnostics.push(error.message));
    await page.goto(host.url);

    const frame = page.frameLocator("iframe[data-dev-frame]");
    await frame.locator("[data-widget-ready]").waitFor({ state: "attached", timeout: 10_000 });
    await eventually(async () => (await page.locator("[data-dev-semantic]").textContent())?.includes("Initial sample") === true, "initial semantic publish");

    await frame.getByRole("button", { name: "Publish long" }).click();
    await eventually(async () => (await page.locator("[data-dev-semantic-dropped]").textContent())?.includes("summary") === true, "truncation marker");
    const normalized = await page.locator("[data-dev-semantic]").textContent();
    const normalizedDoc = JSON.parse(normalized ?? "null") as { summary: string; values: { query: string } };
    expect(normalizedDoc.summary).toHaveLength(300);
    expect(normalizedDoc.values.query).toHaveLength(200);
    expect(normalized).not.toContain("[redacted]");
    expect(await page.locator("[data-dev-semantic-dropped]").textContent()).toContain("values.query");
    expect(await page.locator("[data-dev-semantic-inspect-ui]").textContent()).toContain("proposed by the widget itself");
    expect((await page.locator("[data-dev-semantic-context]").textContent())?.trim().length).toBeGreaterThan(0);

    await frame.getByRole("button", { name: "Publish update" }).click();
    await eventually(async () => (await page.locator("[data-dev-semantic-delta]").textContent())?.includes("Updated sample") === true, "semantic delta");
    expect(await page.locator("[data-dev-semantic-delta]").textContent()).toContain("query");

    await page.locator('[data-dev-action="theme"][data-dev-value="light"]').click();
    await eventually(async () => page.locator("body").getAttribute("data-dev-theme").then((value) => value === "light"), "light theme");
    const light = await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.locator('[data-dev-action="theme"][data-dev-value="dark"]').click();
    await eventually(async () => page.locator("body").getAttribute("data-dev-theme").then((value) => value === "dark"), "dark theme");
    const dark = await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(dark).not.toBe(light);
    const reducedMotion = page.locator('input[data-dev-action="reduced-motion"]');
    await reducedMotion.check();
    await eventually(async () => page.locator("body").getAttribute("data-dev-reduced-motion").then((value) => value === "true"), "reduced motion state");
    await reducedMotion.uncheck();
    await eventually(async () => page.locator("body").getAttribute("data-dev-reduced-motion").then((value) => value === "false"), "normal motion state");

    const eventName = page.locator("[data-dev-composition-name]");
    await eventName.waitFor({ state: "visible", timeout: 5_000 });
    expect(await eventName.inputValue()).toBe("demo.changed");
    const eventResult = page.locator("[data-dev-composition-result]");
    await page.locator("[data-dev-composition-send]").click();
    await eventually(async () => (await eventResult.textContent())?.includes('"count":0') === true, "validated declared event");
    expect(await eventResult.textContent()).toContain("đã được kiểm tra theo schema khai báo");

    await frame.getByRole("button", { name: "Emit declared event" }).click();
    await eventually(async () => (await page.locator("[data-dev-log]").textContent())?.includes('widget event demo.changed validated fields {"count":3}') === true, "validated emitted widget event");
    expect(await eventResult.textContent()).toContain('"count":3');

    await page.locator("[data-dev-composition-payload]").fill('{"count":"not-a-number"}');
    await page.locator("[data-dev-composition-send]").click();
    await eventually(async () => (await eventResult.textContent())?.includes("Từ chối event") === true, "malformed event refusal");

    const undeclared = await page.evaluate(async () => {
      const state = await (await fetch("/dev/api/state")).json() as { bridgeNonce: string };
      const response = await fetch("/dev/api/composition-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: state.bridgeNonce, name: "not.declared", payload: {} }),
      });
      return { status: response.status, body: await response.json() as { problem?: string } };
    });
    expect(undeclared.status).toBe(400);
    expect(undeclared.body.problem).toContain("does not declare event");

    await page.locator("[data-dev-composition-payload]").fill('{"count":1}');
    const sendButton = page.locator("[data-dev-composition-send]");
    await page.locator("[data-dev-composition-payload]").focus();
    await page.keyboard.press("Tab");
    expect(await sendButton.evaluate((element) => document.activeElement === element)).toBe(true);
    const focus = await sendButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    });
    expect(focus).toBe(true);
    await sendButton.press("Enter");
    await eventually(async () => (await eventResult.textContent())?.includes('"count":1') === true, "keyboard event simulation");

    const log = await page.locator("[data-dev-log]").textContent();
    expect(log).toContain("composition event demo.changed");
    expect(log).toContain("composition event refused");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it("applies a built-in composition event through the shared graph contract", async () => {
    host = await startDevHost({ builtin: "canvas.search@1", port: 0, watchFiles: false });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(host.url);

    const eventName = page.locator("[data-dev-composition-name]");
    await eventName.waitFor({ state: "visible", timeout: 10_000 });
    expect(await eventName.inputValue()).toBe("query.change");
    const payload = page.locator("[data-dev-composition-payload]");
    await payload.fill('{"query":"quarterly"}');
    await page.locator("[data-dev-composition-send]").click();
    const result = page.locator("[data-dev-composition-result]");
    await eventually(async () => (await result.textContent())?.trim().length !== 0, "composition event response");
    expect(await result.textContent()).toContain('"field0":"quarterly"');
    expect(await result.textContent()).toContain("áp dụng vào graph mô phỏng");
    expect(await page.locator("[data-dev-log]").textContent()).toContain('composition event query.change {"query":"quarterly"}');
  }, 60_000);
});
