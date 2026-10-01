import { createRequire } from "node:module";
import { startThemeDevHost } from "file:///D:/wt302/packages/widget-cli/src/theme-dev-host.ts";
const { chromium } = createRequire("D:/wt302/package.json")("@playwright/test");
const host = await startThemeDevHost({ root: "D:/wt302/examples/themes/pixel-arcade", port: 0, watchFiles: false });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.goto(host.url);
  await page.locator('[data-theme-preview-canvas]').waitFor();
  await page.locator('.cc-theme-lab-controls [data-segment="light"]').click();
  console.log(await page.locator('[data-theme-preview-canvas]').evaluate((canvas) => [...canvas.querySelectorAll('p, h3, [data-host-card], .cc-widget-preview, .cc-dot-grid')].slice(0,16).map(element=>{
    const style=getComputedStyle(element);
    return {className:element.className,text:element.textContent.slice(0,28),color:style.color,textVar:style.getPropertyValue('--cc-text'),background:style.backgroundColor,opacity:style.opacity,filter:style.filter,z:style.zIndex};
  })));
} finally { await browser.close(); await host.close(); }
