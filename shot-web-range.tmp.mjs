import { chromium } from "@playwright/test";

// Captures the page from one element's top to another's top, in EN and VI, at desk and phone widths.
const [base, out, startSelector, endSelector, prefix] = process.argv.slice(2);
const browser = await chromium.launch();
for (const [width, height, tag] of [[1280, 900, "desk"], [390, 844, "phone"]]) {
  for (const lang of ["", "vi/"]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`file:///${base.replaceAll("\\", "/")}/${lang}docs/api.html`);
    const box = await page.evaluate(([a, b]) => {
      const top = document.querySelector(a).getBoundingClientRect().top + window.scrollY;
      const end = document.querySelector(b).getBoundingClientRect().top + window.scrollY;
      return { top, end };
    }, [startSelector, endSelector]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(tag, lang === "" ? "en" : "vi", "overflow", overflow, "height", Math.round(box.end - box.top));
    await page.screenshot({
      path: `${out}/${prefix}-${tag}-${lang === "" ? "en" : "vi"}.png`,
      fullPage: true,
      clip: { x: 0, y: box.top - 8, width, height: box.end - box.top },
    });
    await page.close();
  }
}
await browser.close();
