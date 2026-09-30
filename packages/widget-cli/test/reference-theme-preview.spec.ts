import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium, type Browser } from "playwright";
import { expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileAppearance } from "@clarkcant/design-tokens";
import { startThemeDevHost, readThemeDevView } from "../src/theme-dev-host.ts";

const names = ["pixel-arcade", "neo-brutalism"] as const;
let browser: Browser | undefined;
const evidence = resolve("plans/reports/evidence/reference-themes", `${process.platform}-${process.arch}`);

beforeAll(async () => {
  mkdirSync(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true });
}, 40_000);

afterAll(async () => {
  await browser?.close();
}, 40_000);

for (const name of names) describe(`${name} production components on this platform`, () => {
  let host: Awaited<ReturnType<typeof startThemeDevHost>> | undefined;
  beforeAll(async () => {
    host = await startThemeDevHost({ root: resolve("examples/themes", name), port: 0, watchFiles: false });
  }, 40_000);
  afterAll(async () => { await host?.close(); }, 40_000);
  for (const width of [1280, 390]) for (const scheme of ["dark", "light"] as const) {
    it(`${name} keeps keyboard, narrow layout and reduced motion usable at ${width} ${scheme}`, async () => {
      if (browser === undefined) throw new Error("The real browser did not start");
      if (host === undefined) throw new Error("The production author host did not start");
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      try {
        await page.goto(host.url);
        const preview = page.locator("[data-theme-preview-canvas]");
        await browserExpect(preview).toBeVisible();
        await browserExpect(preview).toHaveCSS("overflow", "hidden");
        await page.locator(`.cc-theme-lab-controls [data-segment="${scheme}"]`).click();
        await browserExpect(preview).toHaveAttribute("data-cc-theme", scheme);
        await browserExpect(page.locator(".cc-theme-notice")).toHaveCount(0);
        const theme = readThemeDevView(resolve("examples/themes", name)).themes[0]!;
        const snapshot = compileAppearance({ scheme, theme: theme.document, themeRef: theme.themeRef });
        const identity = snapshot.tokens.identity;
        if (identity === undefined) throw new Error(`${name} did not compile its identity tokens`);
        await browserExpect(preview).toHaveAttribute("data-preview-revision", snapshot.revision);
        const actual = await preview.evaluate((element) => {
          const style = getComputedStyle(element);
          return { accent: style.getPropertyValue("--cc-accent").trim(), radius: style.getPropertyValue("--cc-radius-card").trim(),
            line: style.getPropertyValue("--cc-line").trim(), heading: style.getPropertyValue("--cc-weight-heading").trim() };
        });
        expect(actual.accent.toUpperCase()).toBe(snapshot.tokens.color.accent.toUpperCase());
        expect(actual.radius).toBe(snapshot.tokens.radius.card);
        expect(actual.line).toBe(`${identity.border.width}px ${identity.border.style}`);
        expect(actual.heading).toBe(String(identity.typography.headingWeight));
        await browserExpect(preview).toHaveCSS("border-top-width", `${identity.border.width}px`);
        await browserExpect(preview.locator("h3").first()).toHaveCSS("font-weight", String(identity.typography.headingWeight));
        expect(await preview.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("system-ui");
        const background = await preview.locator(".cc-dot-grid").evaluate((element) => getComputedStyle(element).backgroundImage);
        if (name === "pixel-arcade") expect(background).toContain("linear-gradient");
        else expect(background).toBe("none");
        await browserExpect(preview.locator("[data-orb-profile]").first()).toHaveAttribute("data-orb-profile", theme.document.orb!.profile);
        const draft = preview.locator("textarea");
        await draft.fill("A real local preview draft");
        const opener = preview.getByRole("button", { name: /Open example modal|Mở modal ví dụ/ });
        await browserExpect(opener).toHaveCSS("min-height", "32px");
        await browserExpect(preview.locator(".cc-field-input").first()).toHaveCSS("min-height", "44px");
        expect(await opener.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
        await opener.focus();
        await page.keyboard.press("Enter");
        await browserExpect(preview.locator("[data-modal='true']")).toBeVisible();
        await page.keyboard.press("Escape");
        await browserExpect(opener).toBeFocused();
        expect(await opener.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
        await browserExpect(draft).toHaveValue("A real local preview draft");
        await browserExpect.poll(() => preview.locator(".cc-card, .cc-row").evaluateAll((elements) =>
          elements.every((element) => getComputedStyle(element).opacity === "1"))).toBe(true);
        await page.screenshot({ path: join(evidence, `${name}-${width}-${scheme}.png`), fullPage: true });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await browserExpect(preview).toHaveAttribute("data-cc-reduced-motion", "true");
        await browserExpect.poll(() => preview.evaluate((element) => getComputedStyle(element).getPropertyValue("--cc-motion-micro").trim())).toBe("0ms");
        await browserExpect(preview.locator("[data-orb-motion]").first()).toHaveAttribute("data-orb-motion", "reduced");
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
