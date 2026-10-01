import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
const { chromium } = createRequire("D:/wt300/package.json")("@playwright/test");
const evidence = "D:/wt300/plans/reports/evidence";
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  for (const path of ["docs/api.html#theme-lab", "vi/docs/api.html#theme-lab", "docs/cli.html#theme-authoring", "vi/docs/cli.html#theme-authoring"]) {
    for (const width of [1280, 390]) for (const scheme of ["dark", "light"]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:4321/${path}`);
      await page.waitForFunction(() => document.fonts.status === "loaded");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0 || errors.length > 0) throw new Error(JSON.stringify({ path, width, scheme, overflow, errors }));
      const shot = `web300-${path.replaceAll(/[\/#.]/g, "-")}-${width}-${scheme}`;
      await page.screenshot({ path: `${evidence}/${shot}.png` });
      results.push({ path, width, scheme, overflow, errors });
      await context.close();
    }
  }
} finally { await browser.close(); }
writeFileSync(`${evidence}/web300-preview.json`, JSON.stringify(results, null, 2));
console.log(`${results.length} documentation previews passed, zero horizontal overflow or page errors`);
