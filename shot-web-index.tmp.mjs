import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const [base, out, selector, prefix] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [width, height, tag] of [[1280, 900, "desk"], [390, 844, "phone"]]) {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
    await page.goto(`file:///${base.replaceAll("\\", "/")}/index.html`);
    const el = page.locator(selector);
    await el.scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(tag, scheme, "overflow", overflow);
    await el.screenshot({ path: `${out}/${prefix}-${tag}-${scheme}.png` });
    await page.close();
  }
}
await browser.close();
