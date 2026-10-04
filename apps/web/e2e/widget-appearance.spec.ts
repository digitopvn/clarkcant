import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Frame } from "@playwright/test";
import type { WidgetRuntime } from "@clarkcant/widget-sdk";
import type { AppearanceResponse } from "@clarkcant/contracts";
import { compileAppearance } from "@clarkcant/design-tokens";

const port = process.env.CC_E2E_NODE_PORT;
if (!port) throw new Error("run this suite through playwright.config.ts");
const node = `http://127.0.0.1:${port}`;
const evidence = join(process.cwd(), "plans/reports/evidence/widget-appearance");
function token(): string {
  const identity = JSON.parse(readFileSync(join(process.cwd(), ".data/e2e/identity.json"), "utf8")) as { localToken: string };
  return identity.localToken;
}

const readWidget = (frame: Frame) => frame.evaluate(() => {
  const runtime = (window as unknown as { clarkcantWidget: WidgetRuntime }).clarkcantWidget;
  const api = runtime.api();
  return { appearance: api.appearance.current(), props: api.props.read(), state: api.state.get(), stateRevision: api.state.revision(),
    mark: document.documentElement.getAttribute("data-test-identity"),
    accent: getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim().toUpperCase() };
});

const themes = [
  { packageId: "com.example.theme-dusk", facet: "dusk", orb: undefined },
  { packageId: "org.clarkcant.pixel-arcade", facet: "pixel-arcade", orb: "plasma" },
  { packageId: "org.clarkcant.neo-brutalism", facet: "neo-brutalism", orb: "glass" },
];
for (const theme of themes) for (const width of [1280, 390]) for (const scheme of ["dark", "light"] as const) {
  test(`an isolated widget follows ${theme.facet} appearance in place at ${width} ${scheme}`, async ({ page, request }) => {
    mkdirSync(evidence, { recursive: true });
    const headers = { authorization: `Bearer ${token()}` };
    for (const [key, value] of [["experience.colorScheme", "system"], ["experience.accent", null], ["experience.motion", "system"]]) {
      const reset = await request.put(`${node}/preferences/${key}`, { headers, data: { value } });
      expect(reset.ok(), await reset.text()).toBe(true);
    }
    for (let step = 0; step < 16; step += 1) {
      const reset = await request.post(`${node}/preferences/orb.profile/undo`, { headers });
      expect(reset.ok()).toBe(true);
      if ((await reset.json()).preference.isDefault) break;
      if (step === 15) throw new Error("The personal Orb choice did not reset");
    }
    expect((await request.put(`${node}/preferences/experience.themeRef`, { headers, data: { value: "builtin:clark" } })).ok()).toBe(true);
    const directory = JSON.parse(readFileSync(join(process.cwd(), "apps/web/e2e/fixtures/directory.json"), "utf8")) as { packageId: string; digest: string }[];
    const entry = directory.find((candidate) => candidate.packageId === theme.packageId)!;
    const listed = await (await request.get(`${node}/packages`, { headers })).json() as { packages: { packageId: string }[] };
    if (!listed.packages.some((candidate) => candidate.packageId === entry.packageId)) {
      expect((await request.post(`${node}/packages/install`, { headers, data: { packageId: entry.packageId, version: "1.0.0", localDigest: entry.digest } })).ok()).toBe(true);
    }
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "no-preference" });
    await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(node)}`);
    await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
    const composer = page.locator("[data-composer='true']");
    await composer.fill("widget cách ly");
    await composer.press("Enter");
    const mountedSemantic = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/widgets\/[^/]+\/semantic$/.test(new URL(response.url()).pathname));
    await page.locator("[data-open-live]").last().click();
    const surface = page.locator("[data-pin-live] [data-widget-frame]");
    await expect(surface).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
    const frame = await (await surface.locator("iframe").elementHandle())?.contentFrame();
    if (!frame) throw new Error("the production widget did not mount");
    expect((await mountedSemantic).ok()).toBe(true);
    const initial = await readWidget(frame);
    expect(initial.appearance?.scheme).toBe(scheme);
    await frame.evaluate(async () => {
      const path = "/widget-runtime.js";
      const dom = await import(path) as { bindAppearance: (element: HTMLElement, appearance: ReturnType<WidgetRuntime["api"]>["appearance"]) => () => void };
      const runtime = (window as unknown as { clarkcantWidget: WidgetRuntime }).clarkcantWidget;
      dom.bindAppearance(document.documentElement, runtime.api().appearance);
      document.documentElement.setAttribute("data-test-identity", "kept");
      document.body.style.backgroundColor = "var(--cc-canvas)";
      document.body.style.color = "var(--cc-text)";
    });
    await composer.fill("draft kept across appearance changes");
    let semanticWrites = 0;
    let modelTurns = 0;
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (/\/widgets\/[^/]+\/(state|semantic)$/.test(new URL(request.url()).pathname)) semanticWrites += 1;
      if (/\/conversations\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) modelTurns += 1;
    });
    await page.locator("[data-settings='true']").click();
    const themeRef = `package:${theme.packageId}#${theme.facet}`;
    const choice = page.locator(`[data-theme-ref='${themeRef}']`);
    await expect(choice).toBeVisible();
    await choice.click();
    await expect.poll(async () => (await readWidget(frame)).appearance?.themeRef).toBe(themeRef);
    const canonical = await (await request.get(`${node}/appearance`, { headers })).json() as AppearanceResponse;
    if (canonical.theme === null) throw new Error("The installed theme was not applied by the canonical route");
    expect((await readWidget(frame)).appearance).toEqual(compileAppearance({
      scheme, theme: canonical.theme, themeRef: canonical.appliedRef, customization: canonical.customization,
    }));
    if (theme.orb !== undefined) {
      const orb = page.locator("canvas[data-orb-profile]").first();
      await expect(orb).toHaveAttribute("data-orb-profile", theme.orb);
      await page.locator('[data-orb-preset="calm"]').click();
      await expect(orb).toHaveAttribute("data-orb-profile", "calm");
    }
    const hostAccent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim().toUpperCase());
    await expect.poll(async () => (await readWidget(frame)).accent).toBe(await hostAccent());
    await page.locator(`[data-theme-choice='${scheme === "dark" ? "light" : "dark"}']`).click();
    await expect.poll(async () => (await readWidget(frame)).appearance?.scheme).toBe(scheme === "dark" ? "light" : "dark");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => {
      const current = (await readWidget(frame)).appearance;
      return current?.tokens.motion.micro === "0ms" && current.tokens.motion.micro === current.tokens.motionReduced.micro;
    }).toBe(true);
    const final = await readWidget(frame);
    expect(final.mark).toBe("kept");
    expect(final.props).toEqual(initial.props);
    expect(final.state).toEqual(initial.state);
    expect(final.stateRevision).toBe(initial.stateRevision);
    expect(semanticWrites).toBe(0);
    expect(modelTurns).toBe(0);
    await expect(composer).toHaveValue("draft kept across appearance changes");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: join(evidence, `iframe-${theme.facet}-${width}-${scheme}.png`) });
    expect((await request.put(`${node}/preferences/experience.themeRef`, { headers, data: { value: "builtin:clark" } })).ok()).toBe(true);
  });
}
