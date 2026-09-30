import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const port = process.env.CC_E2E_NODE_PORT;
if (!port) throw new Error("Run through playwright.config.ts");
const gateway = `http://127.0.0.1:${port}`;
const evidence = join(process.cwd(), "plans/reports/evidence/reference-themes");
function token(): string {
  return (JSON.parse(readFileSync(join(process.cwd(), ".data/e2e/identity.json"), "utf8")) as { localToken: string }).localToken;
}

for (const name of ["pixel-arcade", "neo-brutalism"]) for (const width of [1280, 390]) for (const scheme of ["dark", "light"] as const) {
  test(`${name} reaches a real declarative composition and its built-in widgets at ${width} ${scheme}`, async ({ page, request }) => {
    mkdirSync(evidence, { recursive: true });
    const headers = { authorization: `Bearer ${token()}` };
    const write = async (key: string, value: unknown): Promise<void> => {
      const response = await request.put(`${gateway}/preferences/${key}`, { headers, data: { value } });
      expect(response.ok(), await response.text()).toBe(true);
    };
    await write("experience.themeRef", "builtin:clark");
    await write("experience.colorScheme", "system");
    await write("experience.accent", null);
    await write("experience.motion", "system");
    const packageId = `org.clarkcant.${name}`;
    const entries = JSON.parse(readFileSync(join(process.cwd(), "apps/web/e2e/fixtures/directory.json"), "utf8")) as { packageId: string; digest: string }[];
    const installed = await (await request.get(`${gateway}/packages`, { headers })).json() as { packages: { packageId: string }[] };
    if (!installed.packages.some((entry) => entry.packageId === packageId)) {
      const entry = entries.find((entry) => entry.packageId === packageId)!;
      const response = await request.post(`${gateway}/packages/install`, { headers, data: { packageId, version: "1.0.0", localDigest: entry.digest } });
      expect(response.ok(), await response.text()).toBe(true);
    }
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "no-preference" });
    await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(gateway)}`);
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    const composer = page.locator("[data-composer]");
    await composer.fill("bố cục có liên kết");
    await composer.press("Enter");
    const composition = page.locator("[data-layout-root]").last();
    await expect(composition).toBeVisible();
    const chart = composition.locator("[data-chart-series]").first();
    await expect(chart).toBeVisible();
    await composition.evaluate((element) => element.setAttribute("data-reference-kept", "true"));
    await composer.fill("Reference theme keeps the actual conversation draft");
    const themeRef = `package:${packageId}#${name}`;
    await page.locator("[data-settings='true']").click();
    await page.locator(`[data-theme-ref='${themeRef}']`).click();
    await page.keyboard.press("Escape");
    await expect(composition).toHaveAttribute("data-reference-kept", "true");
    await expect(composer).toHaveValue("Reference theme keeps the actual conversation draft");
    await expect(page.locator("html")).toHaveAttribute("data-cc-theme", scheme);
    await expect.poll(async () => {
      const response = await request.get(`${gateway}/appearance`, { headers });
      if (!response.ok()) return undefined;
      return ((await response.json()) as { appliedRef?: string }).appliedRef;
    }).toBe(themeRef);
    for (const key of ["--cc-accent", "--cc-radius-card", "--cc-line", "--cc-card-shadow"]) {
      await expect.poll(() => composition.evaluate((element, variable) => {
        const local = getComputedStyle(element).getPropertyValue(variable).trim();
        const host = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
        return local !== "" && local === host;
      }, key), { message: `${key} should reach the existing composition from the host theme` }).toBe(true);
    }
    await expect(chart).toBeVisible();
    await page.screenshot({ path: join(evidence, `composition-${name}-${width}-${scheme}.png`) });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => composition.evaluate((element) => getComputedStyle(element).getPropertyValue("--cc-motion-micro").trim())).toBe("0ms");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await write("experience.themeRef", "builtin:clark");
  });
}
