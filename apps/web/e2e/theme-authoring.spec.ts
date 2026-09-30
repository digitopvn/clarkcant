import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initTheme } from "../../../packages/widget-cli/src/theme-cli.ts";
import { startThemeDevHost } from "../../../packages/widget-cli/src/theme-dev-host.ts";

for (const width of [1280, 390]) {
  for (const scheme of ["dark", "light"] as const) {
    test(`a theme author previews production components and reloads data in place at ${String(width)} ${scheme}`, async ({ page }) => {
      const root = mkdtempSync(join(tmpdir(), "clark-theme-browser-"));
      initTheme(root);
      const host = await startThemeDevHost({ root, port: 0 });
      const errors: string[] = [];
      const writes: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      page.on("request", (request) => { if (request.method() === "POST") writes.push(request.url()); });
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(host.url);
        const preview = page.locator("[data-theme-preview-canvas]");
        await expect(preview).toBeVisible();
        await expect(preview).toHaveCSS("overflow", "hidden");
        await expect(preview).toHaveCSS("border-top-style", "solid");
        await page.locator(`.cc-theme-lab-controls [data-segment="${scheme}"]`).click();
        await expect(preview).toHaveAttribute("data-cc-theme", scheme);
        const textarea = preview.locator("textarea");
        await textarea.fill("Author draft stays local");
        await textarea.evaluate((element) => element.setAttribute("data-kept", "true"));
        const firstRevision = await preview.getAttribute("data-preview-revision");
        const path = join(root, "themes/main.json");
        const theme = JSON.parse(readFileSync(path, "utf8"));
        theme.recipes.button = "raised";
        writeFileSync(path, JSON.stringify(theme));
        await expect(preview).not.toHaveAttribute("data-preview-revision", firstRevision ?? "");
        await expect(textarea).toHaveValue("Author draft stays local");
        await expect(textarea).toHaveAttribute("data-kept", "true");
        await page.locator("details").filter({ has: page.locator("[data-preview-tokens]") }).locator("summary").click();
        await expect(page.locator("[data-preview-tokens]")).toContainText('"button": "raised"');
        await page.locator('.cc-theme-lab-controls [data-segment="narrow"]').click();
        await expect(preview).toHaveCSS("width", "320px");
        await page.locator('.cc-theme-lab-controls [data-segment="compact"]').click();
        const compact = await preview.boundingBox();
        expect(compact?.width).toBeGreaterThanOrEqual(320);
        expect(compact?.width).toBeLessThanOrEqual(Math.min(480, width));
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect.poll(() => preview.evaluate((element) => getComputedStyle(element).getPropertyValue("--cc-motion-micro").trim())).toBe("0ms");
        await expect(preview).toHaveAttribute("data-cc-reduced-motion", "true");
        await preview.locator("[data-send]").click();
        await expect(preview.locator('[data-role="user"]')).toContainText("Author draft stays local");
        await expect(textarea).toHaveValue("");
        await textarea.fill("Preserved after a bad edit");
        writeFileSync(path, "{ invalid JSON");
        await expect(page.locator(".cc-theme-notice")).toBeVisible();
        await expect(textarea).toHaveValue("Preserved after a bad edit");
        const modalOpener = preview.locator('button').filter({ hasText: /Mở modal ví dụ|Open example modal/ });
        await expect(modalOpener).toHaveCSS("min-height", "32px");
        await expect(preview.locator("input[aria-label]").first()).toHaveCSS("min-height", "44px");
        await modalOpener.click();
        await expect(preview.locator('[data-modal="true"]')).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(preview.locator('[data-modal="true"]')).toHaveCount(0);
        await expect(modalOpener).toBeFocused();
        writeFileSync(path, JSON.stringify(theme));
        await expect(page.locator(".cc-theme-notice")).toHaveCount(0);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        expect(writes).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await page.goto("about:blank");
        await host.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
