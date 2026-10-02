import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import { startDevHost, type DevHost } from "../src/dev-host.ts";

let host: DevHost | undefined;
let browser: Browser | undefined;

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${message}`);
}

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await host?.close();
  host = undefined;
});

describe("simulated jobs in Chromium", () => {
  it("starts a job from a press, steps its progress, and ends it by completion, failure and the widget's own cancel", async () => {
    host = await startDevHost({ root: `${process.cwd()}/apps/web/e2e/fixtures/notes-service`, port: 0, watchFiles: false });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(host.url);

    const frame = page.frameLocator("iframe[data-dev-frame]");
    const job = frame.locator("[data-notes-job]");
    const status = async (): Promise<string | null> => job.getAttribute("data-notes-job-status");
    await frame.locator("[data-widget-ready]").waitFor({ state: "visible", timeout: 10_000 });
    await expect(page.locator("[data-dev-job-empty]").isVisible()).resolves.toBe(true);

    await page.getByLabel("Readiness for com.example.notes.export@1").selectOption("ready");
    const exportButton = frame.locator("[data-notes-export]");
    await eventually(async () => !(await exportButton.isDisabled()), "a ready export binding");

    // A press answers with a JobRef the widget follows; the shell lists the job, and its first step starts it.
    await exportButton.click();
    await eventually(async () => (await status()) === "queued", "a queued job");
    const row = page.locator("[data-dev-job]").first();
    await expect(row.getAttribute("data-dev-job-status")).resolves.toBe("queued");
    expect(await page.locator("[data-dev-job-empty]").isHidden()).toBe(true);
    await row.locator('[data-dev-job-control="advance"]').click();
    await eventually(async () => (await status()) === "running", "a running job");
    await page.locator("[data-dev-job]").first().locator('[data-dev-job-control="advance"]').click();
    await eventually(async () => (await job.getAttribute("data-notes-job-progress")) === "1", "the fixture's first progress step");
    expect(await job.textContent()).toContain("exported step 1 of 3");

    // The widget's own cancel reaches the simulated broker and the ending says it was simulated.
    await frame.locator("[data-notes-export-cancel]").click();
    await eventually(async () => (await status()) === "cancelled", "a cancelled job");
    expect(await job.textContent()).toContain("simulated by clark widget dev");
    expect(await frame.locator("[data-notes-export-cancel]").isDisabled()).toBe(true);

    await exportButton.click();
    await eventually(async () => (await page.locator('[data-dev-job][data-dev-job-status="queued"]').count()) === 1, "a second job");
    await page.locator('[data-dev-job][data-dev-job-status="queued"]').locator('[data-dev-job-control="complete"]').click();
    await eventually(async () => (await status()) === "completed", "a completed job");
    expect(await job.textContent()).toContain("Exported 1 note(s). (simulated by clark widget dev)");

    await exportButton.click();
    await eventually(async () => (await page.locator('[data-dev-job][data-dev-job-status="queued"]').count()) === 1, "a third job");
    await page.locator('[data-dev-job][data-dev-job-status="queued"]').locator('[data-dev-job-control="fail"]').click();
    await eventually(async () => (await status()) === "failed", "a failed job");
    expect(await job.textContent()).toContain("the export could not be written (simulated by clark widget dev)");

    // Ended jobs keep their controls disabled; the record is the dev host's, by id and status only.
    expect(await page.locator('[data-dev-job][data-dev-job-status="failed"] [data-dev-job-control="advance"]').isDisabled()).toBe(true);
    expect(host.jobEvents().map((event) => event.op)).toEqual(["start", "advance", "advance", "cancel", "start", "complete", "start", "fail"]);
    expect(requests.every((url) => url.startsWith(host?.url ?? ""))).toBe(true);
  }, 60_000);
});
