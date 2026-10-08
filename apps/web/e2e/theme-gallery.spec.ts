import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const port = process.env.CC_E2E_NODE_PORT;
if (port === undefined) throw new Error("CC_E2E_NODE_PORT is required");
const gateway = `http://127.0.0.1:${port}`;
const packageId = "com.example.theme-dusk";
const dusk = `package:${packageId}#dusk`;
const evidence = join(process.cwd(), "plans/reports/evidence");

for (const width of [1280, 390]) for (const scheme of ["dark", "light"] as const) {
  test(`theme gallery previews without writes, customizes and resets in place at ${String(width)} ${scheme}`, async ({ page, request }) => {
    const identity = JSON.parse(readFileSync(join(process.cwd(), ".data/e2e/identity.json"), "utf8")) as { localToken: string };
    const headers = { authorization: `Bearer ${identity.localToken}` };
    const write = async (key: string, value: unknown): Promise<void> => {
      const response = await request.put(`${gateway}/preferences/${key}`, { headers, data: { value } });
      expect(response.ok(), await response.text()).toBe(true);
    };
    await write("experience.accent", null);
    await write("experience.density", "comfortable");
    await write("experience.motion", "system");
    await write("experience.themeRef", "builtin:clark");
    const packages = await (await request.get(`${gateway}/packages`, { headers })).json();
    if (!packages.packages.some((pkg: { packageId: string; state: string }) => pkg.packageId === packageId && pkg.state === "active")) {
      const response = await request.post(`${gateway}/packages/install`, { headers,
        data: { packageId, version: "1.0.0", localDigest: "sha256:08c8691d1f8021e05d69a0754f3e6447de04a47ea2fc3cbd0b1817bcd2089053" } });
      expect(response.ok(), await response.text()).toBe(true);
    }
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/?token=${encodeURIComponent(identity.localToken)}&gateway=${encodeURIComponent(gateway)}`);
      await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible();
      const composer = page.locator('[data-composer="true"]').first();
      await composer.fill("Conversation draft survives Theme Lab");
      await composer.evaluate((element) => element.setAttribute("data-kept", "true"));
      const settings = page.locator('[data-settings="true"]');
      await settings.click();
      const browse = page.locator("[data-theme-browse]");
      await expect(browse).toBeVisible();
      await browse.click();
      const gallery = page.locator("[data-theme-gallery]");
      await gallery.locator(`[data-theme-ref="${dusk}"]`).click();
      const preview = page.locator("[data-theme-preview-canvas]");
      await expect(preview).toBeVisible();
      await expect(page.locator("[data-theme-apply]")).toBeEnabled();
      const before = await (await request.get(`${gateway}/appearance`, { headers })).json();
      expect(before.selectedRef).toBe("builtin:clark");
      const draft = preview.locator('[data-composer="true"]');
      await draft.fill("Local example draft");
      const modalOpener = preview.locator("button").filter({ hasText: /Mở hộp thoại ví dụ|Open example modal/ });
      await modalOpener.click();
      await expect(page.locator('[data-modal="true"]')).toHaveCount(3);
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-modal="true"]')).toHaveCount(2);
      await expect(modalOpener).toBeFocused();
      await expect(draft).toHaveValue("Local example draft");
      await page.locator("[data-theme-apply]").click();
      await expect.poll(async () => (await (await request.get(`${gateway}/appearance`, { headers })).json()).selectedRef).toBe(dusk);
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-modal="true"]')).toHaveCount(1);
      await expect(browse).toBeFocused();
      // The theme in use is the pressed card already; the recent row is only a way back to the others.
      await expect(page.locator("[data-theme-recent] button", { hasText: "Dusk" })).toHaveCount(0);
      await page.locator(`[data-theme-choice="${scheme}"]`).click();
      const normalSpace = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-space-md"));
      await page.locator('[data-theme-customization] [data-segment="compact"]').click();
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-space-md").trim())).toBe("0.5625rem");
      // The swatch beside each code is the colour itself and a picker for it: choosing there writes the code.
      await page.locator('[data-accent-picker="dark"]').fill("#336699");
      await expect(page.locator('[data-accent-scheme="dark"]')).toHaveValue("#336699");
      await expect(page.locator('[data-accent-picker="dark"]')).toHaveAccessibleName(/./);      await page.locator('[data-accent-scheme="dark"]').fill("#7AA2F7");
      await page.locator('[data-accent-scheme="light"]').fill("#2453A8");
      await expect(page.locator('[data-accent-picker="light"]')).toHaveValue("#2453a8");
      await page.locator("[data-accent-save]").click();
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim().toUpperCase())).toBe(scheme === "dark" ? "#7AA2F7" : "#2453A8");
      await page.locator('[data-accent-scheme="dark"]').fill("#111114");
      await page.locator('[data-accent-scheme="light"]').fill("#FFFFFF");
      await page.locator("[data-accent-save]").click();
      await expect(page.locator('[data-theme-customization] [role="status"]')).toContainText(/không|not|could/i);
      // The node's own reason is behind the details, as words: its code is for the program, never the person.
      await expect(page.locator('[data-accent-refused]')).toContainText("the accent would hide text or protected states");
      await expect(page.locator('[data-accent-refused]')).not.toContainText("THEME_LOW_CONTRAST");
      const saved = await (await request.get(`${gateway}/appearance`, { headers })).json();
      expect(saved.customization.accent).toEqual({ dark: "#7AA2F7", light: "#2453A8" });
      await page.locator("[data-theme-customization-reset]").click();
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-space-md"))).toBe(normalSpace);
      const restored = await (await request.get(`${gateway}/appearance`, { headers })).json();
      expect(restored.selectedRef).toBe(dusk);
      expect(restored.customization).toBeUndefined();
      await expect(page.locator(`[data-theme-choice="${scheme}"]`)).toHaveAttribute("aria-pressed", "true");
      await browse.click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(preview).toHaveAttribute("data-cc-reduced-motion", "true");
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `theme-gallery-${String(width)}-${scheme}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
      await expect(browse).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(settings).toBeFocused();
      await expect(composer).toHaveValue("Conversation draft survives Theme Lab");
      await expect(composer).toHaveAttribute("data-kept", "true");
      expect(errors).toEqual([]);
    } finally {
      await write("experience.accent", null);
      await write("experience.density", "comfortable");
      await write("experience.motion", "system");
      await write("experience.themeRef", "builtin:clark");
    }
  });
}
