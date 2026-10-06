import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

/**
 * A package capability that runs as a durable job, followed from its widget.
 *
 * The notes service's export reports its own progress over MCP and stops when the node cancels the request. The widget
 * gets a JobRef from its press and reads the job through `jobs@1`; every read is re-authorized by the node against the
 * widget's binding, so the snapshot the frame shows is the node's, not the widget's guess. The JobRef is kept in the
 * widget's state, which is how a remounted frame follows the same job.
 *
 * Needs a container engine that runs Linux containers, like the other notes-service journeys.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.example.notes";
const FRAME = "[data-pin-live] [data-widget-frame]";
const EXPORT = "com.example.notes.export@1";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no identity");
  return parsed.localToken;
}

async function install(request: APIRequestContext): Promise<void> {
  const headers = { authorization: `Bearer ${token()}` };
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers })).json()) as { packages: { packageId: string }[] };
  if (listed.packages.some((entry) => entry.packageId === PACKAGE)) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers,
    data: { packageId: PACKAGE, version: "1.0.0", localDigest: "sha256:notes-service-digest" },
  });
  expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

/** Open the newest notes widget live and wait until the host has said its export can run. */
async function openLive(page: Page): Promise<FrameLocator> {
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  await expect(page.locator(FRAME)).toHaveAttribute("data-frame-status", "ready", { timeout: 30_000 });
  const widget = page.frameLocator(`${FRAME} iframe`);
  await expect(widget.locator("#root[data-notes-announced='true'][data-notes-service='available']")).toBeVisible({ timeout: 180_000 });
  return widget;
}

async function composeNotes(page: Page): Promise<FrameLocator> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("widget ghi chú");
  await composer.press("Enter");
  return openLive(page);
}

/** Start an export of `steps` steps, `stepMs` apart, and return its JobRef once the widget follows it. */
async function startExport(widget: FrameLocator, steps: number, stepMs: number): Promise<string> {
  await widget.locator("#root").evaluate((root, size) => {
    (root as HTMLElement).dataset.exportSteps = String(size.steps);
    (root as HTMLElement).dataset.exportStepMs = String(size.stepMs);
  }, { steps, stepMs });
  await widget.locator("[data-notes-export]").click();
  const job = widget.locator("[data-notes-job]");
  await expect(job).toHaveAttribute("data-notes-job-id", /^job_/, { timeout: 30_000 });
  return (await job.getAttribute("data-notes-job-id")) ?? "";
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await install(request);
});

test("a press starts a job whose service progress survives a remount, and the widget's cancel ends it", async ({ page }) => {
  test.setTimeout(300_000);
  await openApp(page);
  let widget = await composeNotes(page);
  const jobId = await startExport(widget, 12, 1_500);
  const job = widget.locator("[data-notes-job]");

  // Progress is what the service sent, step by step; the message is the service's own words.
  await expect(job).toHaveAttribute("data-notes-job-progress", /^[1-9]/, { timeout: 30_000 });
  await expect(job).toContainText(/exported step \d+ of 12/);
  await expect(job).toHaveAttribute("data-notes-job-status", "running");

  // A reload unmounts the frame. The remounted widget reads its JobRef from saved state and follows the same job.
  await page.reload();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  widget = await openLive(page);
  const resumed = widget.locator("[data-notes-job]");
  await expect(resumed).toHaveAttribute("data-notes-job-id", jobId, { timeout: 30_000 });
  await expect(resumed).toHaveAttribute("data-notes-job-status", "running", { timeout: 30_000 });
  const before = Number(await resumed.getAttribute("data-notes-job-progress"));
  await expect.poll(async () => Number(await resumed.getAttribute("data-notes-job-progress")), { timeout: 15_000 }).toBeGreaterThan(before);

  // A JobRef is a pointer, not authority: one the node never gave this widget is refused like a missing one.
  const forged = await widget.locator("body").evaluate(async () => {
    const api = (window as unknown as { clarkcantWidget: { api: () => { jobs: { get: (ref: string) => Promise<unknown> } } } }).clarkcantWidget.api();
    try {
      await api.jobs.get("job_forged_by_widget");
      return "read";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(forged).toContain("JOB_NOT_FOUND");

  await widget.locator("[data-notes-export-cancel]").click();
  await expect(resumed).toHaveAttribute("data-notes-job-status", "cancelled", { timeout: 30_000 });
  // The service may have finished its effect before it heard the cancel, and the ending says so instead of claiming otherwise.
  await expect(resumed).toContainText("may already have completed its effect");
  await expect(widget.locator("[data-notes-export-cancel]")).toBeDisabled();
  // The node's note, in its owner's language: the suite's node keeps the default, Vietnamese.
  await expect(page.getByText(`Job của package cho ${EXPORT} đã bị dừng`).last()).toBeVisible({ timeout: 30_000 });
});

test("a finished job hands the widget its file by reference and says so in the conversation", async ({ page }) => {
  test.setTimeout(300_000);
  await openApp(page);
  const widget = await composeNotes(page);
  await startExport(widget, 2, 200);
  const job = widget.locator("[data-notes-job]");
  await expect(job).toHaveAttribute("data-notes-job-status", "completed", { timeout: 60_000 });
  await expect(job).toContainText("Exported");
  await expect(job).toHaveAttribute("data-notes-job-files", /\S/);
  // The node's note, in its owner's language: the suite's node keeps the default, Vietnamese.
  await expect(page.getByText(`Job của package cho ${EXPORT} đã xong`).last()).toBeVisible({ timeout: 30_000 });
  // The same ending is in the inbox, so it is found again after the conversation has moved on, its title in the same
  // language as its body.
  const inbox = (await (await page.request.get(`${GATEWAY}/inbox`, { headers: { authorization: `Bearer ${token()}` } })).json()) as {
    notices: { title: string; body?: string }[];
  };
  expect(inbox.notices).toContainEqual(
    expect.objectContaining({ title: "Một job của package đã xong", body: expect.stringContaining(`Job của package cho ${EXPORT} đã xong`) }),
  );
});

test("an emergency Stop ends a running job, and the widget reads that ending from the node", async ({ page, request }) => {
  test.setTimeout(300_000);
  await openApp(page);
  const widget = await composeNotes(page);
  await startExport(widget, 30, 1_000);
  const job = widget.locator("[data-notes-job]");
  await expect(job).toHaveAttribute("data-notes-job-status", "running", { timeout: 30_000 });

  const stopped = await request.post(`${GATEWAY}/stop`, { headers: { authorization: `Bearer ${token()}` } });
  expect(stopped.ok()).toBe(true);
  expect(((await stopped.json()) as { stopped: { jobs: number } }).stopped.jobs).toBeGreaterThanOrEqual(1);
  await expect(job).toHaveAttribute("data-notes-job-status", "cancelled", { timeout: 30_000 });
});
