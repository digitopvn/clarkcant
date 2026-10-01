import { chromium } from "@playwright/test";

const [base, out, anchor = "peer-notices", prefix = "web38"] = process.argv.slice(2);
const browser = await chromium.launch();
for (const [width, height, tag] of [[1280, 900, "desk"], [390, 844, "phone"]]) {
  for (const lang of ["", "vi/"]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`file:///${base.replaceAll("\\", "/")}/${lang}docs/api.html#${anchor}`);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(tag, lang === "" ? "en" : "vi", "overflow", overflow);
    await page.screenshot({ path: `${out}/${prefix}-${tag}-${lang === "" ? "en" : "vi"}.png` });
    await page.close();
  }
}
await browser.close();
