import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";


/**
 * The reference media render tool, from the conversation: a package widget that renders a WAV clip the person picks,
 * through the package's own service, as a job the person can follow and stop.
 *
 * The clip is several chunks long, so the service reads it from the host in ranges and reports progress as it goes. The
 * service runs in a container under the package's `background-compute` profile; when a policy rule refuses that profile
 * the service is not started, and the widget shows the host's reason where Render was. The transform, the service's
 * cancel and the host's caps have their own tests; this is the app between them, in a browser.
 *
 * Needs a container engine that runs Linux containers, like the other package-service journeys.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.clarkcant.reference.media-render";
const CAPABILITY = "com.clarkcant.reference.media-render.render@1";
const FRAME = "[data-pin-live] [data-widget-frame]";
const POLICY_KEY = "execution.policy";

/** 68 s of mono 16-bit audio: about 2.9 MiB, twelve 256 KiB chunks, and still under what one service result may carry. */
const CLIP_SECONDS = 68;
const CLIP_NAME = "giong-noi.wav";
/*
 * The same deterministic clip the package's own tests render, from the package's transform module. Loaded by URL: the
 * module is plain JavaScript that ships in the package, and this suite's type configuration does not read JavaScript.
 */
const WAV_MODULE = pathToFileURL(join(process.cwd(), "examples", "reference-apps", "media-render", "service", "wav.mjs")).href;
const { fixtureClip } = (await import(WAV_MODULE)) as { fixtureClip: (options: { seconds: number }) => Uint8Array };
const CLIP = Buffer.from(fixtureClip({ seconds: CLIP_SECONDS }));
const CHUNK = 256 * 1024;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no identity");
  return parsed.localToken;
}

const headers = () => ({ authorization: `Bearer ${token()}` });

async function install(request: APIRequestContext): Promise<void> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: headers() })).json()) as { packages: { packageId: string }[] };
  if (listed.packages.some((entry) => entry.packageId === PACKAGE)) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers: headers(),
    data: { packageId: PACKAGE, version: "1.0.0", localDigest: "sha256:media-render-reference-digest" },
  });
  expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
}

async function storedPolicy(request: APIRequestContext): Promise<Record<string, unknown>> {
  const listed = (await (await request.get(`${GATEWAY}/preferences`, { headers: headers() })).json()) as {
    preferences: { key: string; value: unknown }[];
  };
  const policy = listed.preferences.find((entry) => entry.key === POLICY_KEY)?.value;
  if (typeof policy !== "object" || policy === null) throw new Error("the node reports no execution policy");
  return policy as Record<string, unknown>;
}

async function writePolicy(request: APIRequestContext, value: Record<string, unknown>): Promise<void> {
  const written = await request.put(`${GATEWAY}/preferences/${POLICY_KEY}`, { headers: headers(), data: { value } });
  expect(written.ok(), await written.text()).toBe(true);
}

/** A person's Stop: services are killed and started again, and each start decides its package's profile afresh. */
async function restartServices(request: APIRequestContext): Promise<void> {
  const stopped = await request.post(`${GATEWAY}/stop`, { headers: headers() });
  expect(stopped.ok()).toBe(true);
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

/**
 * The newest media render widget, live, once it has drawn itself. After a reload the live frame the page had open is
 * mounted again by the page itself; `restored` waits for that rather than pressing the transcript's open button, which
 * the restored frame may already cover.
 */
async function openLive(page: Page, options: { restored?: boolean } = {}): Promise<FrameLocator> {
  const frame = page.locator(FRAME);
  if (options.restored === true) await frame.waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
  const mounted = (await frame.count()) > 0;
  if (!mounted || (options.restored !== true && (await frame.getAttribute("data-frame-status")) !== "ready")) {
    const open = page.locator("[data-open-live]").last();
    await expect(open).toBeVisible({ timeout: 20_000 });
    await open.click();
  }
  await expect(frame).toHaveAttribute("data-frame-status", "ready", { timeout: 30_000 });
  const widget = page.frameLocator(`${FRAME} iframe`);
  await expect(widget.locator("#root[data-media-ready='true']")).toHaveCount(1, { timeout: 30_000 });
  return widget;
}

async function composeTool(page: Page): Promise<FrameLocator> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  // Placed the way a model places it: `place_widget`, with Render bound to the package's own capability.
  await composer.fill("place widget com.clarkcant.reference.media-render.main@1");
  await composer.press("Enter");
  await expect(page.getByText(/Fixture: tui gọi place_widget .*Placed /u).last()).toBeVisible({ timeout: 20_000 });
  return openLive(page);
}

/** Wait until the host says Render can run: the service has started in the profile it was granted. */
async function serviceReady(widget: FrameLocator): Promise<void> {
  await expect(widget.locator("#root[data-media-available='true']")).toHaveCount(1, { timeout: 180_000 });
}

/** Pick the clip through the browser's own chooser, from the host's question. */
async function pickClip(page: Page, widget: FrameLocator): Promise<void> {
  await widget.locator("[data-media-pick]").click();
  const prompt = page.locator("[data-artifact-prompt='pick']");
  await expect(prompt).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await prompt.locator("[data-artifact-choose]").click();
  await (await chooser).setFiles({ name: CLIP_NAME, mimeType: "audio/wav", buffer: CLIP });
  await expect(widget.locator("[data-media-status='picked']")).toHaveCount(1, { timeout: 20_000 });
  await expect(widget.locator(`[data-media-source='${CLIP_NAME}']`)).toHaveCount(1);
}

async function startRender(widget: FrameLocator): Promise<string> {
  await widget.locator("[data-media-render]").click();
  const job = widget.locator("[data-media-job]");
  await expect(job).toHaveAttribute("data-media-job-id", /^job_/, { timeout: 30_000 });
  return (await job.getAttribute("data-media-job-id")) ?? "";
}

type FrameApi = { jobs: { cancel: (id: string) => Promise<unknown> }; actions: { invoke: (...args: unknown[]) => Promise<unknown> } };

/**
 * Make the frame's next call to `method` refused with `reason`, as the host refuses one, and every later call go through.
 * The widget holds the same API object the frame's runtime hands out, so this is the refusal it would receive.
 */
async function refuseOnce(widget: FrameLocator, method: "cancel" | "invoke", reason: string): Promise<void> {
  await widget.locator("body").evaluate(
    (_body, input) => {
      const api = (window as unknown as { clarkcantWidget: { api: () => FrameApi } }).clarkcantWidget.api();
      const owner = (input.method === "cancel" ? api.jobs : api.actions) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const name = input.method;
      const real = owner[name]?.bind(owner);
      if (real === undefined) throw new Error(`the frame has no ${name}`);
      let refused = false;
      owner[name] = (...args: unknown[]) => {
        if (refused) return real(...args);
        refused = true;
        return Promise.reject(new Error(input.reason));
      };
    },
    { method, reason },
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  expect(CLIP.byteLength).toBeGreaterThan(CHUNK * 10);
  await install(request);
});

test("a clip larger than one chunk renders with the service's progress, and its file is previewed, saved and attached", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await openApp(page);
  const widget = await composeTool(page);
  await serviceReady(widget);

  // Nothing is picked yet, so there is nothing to render.
  await expect(widget.locator("[data-media-source]")).toHaveText("Chưa chọn tệp nào");
  await expect(widget.locator("[data-media-render]")).toBeDisabled();

  await pickClip(page, widget);
  await widget.locator("[data-media-gain]").fill("-6");
  await widget.locator("[data-media-trim-start]").fill("1000");
  await widget.locator("[data-media-trim-end]").fill("1000");
  // A gain outside what the tool allows is refused before anything is sent.
  await widget.locator("[data-media-gain]").fill("40");
  await expect(widget.locator("[data-media-param-error]")).not.toHaveText("");
  await expect(widget.locator("[data-media-render]")).toBeDisabled();
  await widget.locator("[data-media-gain]").fill("-6");
  await expect(widget.locator("[data-media-render]")).toBeEnabled();

  await startRender(widget);
  const job = widget.locator("[data-media-job]");
  // Progress is the service's, in its own words, counted in the bytes it has rendered so far.
  await expect(job).toHaveAttribute("data-media-job-status", "running", { timeout: 30_000 });
  await expect(widget.locator("[data-media-progress]")).toHaveAttribute("data-media-progress", /^[1-9]\d?$/, { timeout: 30_000 });
  await expect(widget.locator("[data-media-job-message]")).toContainText(/Rendered \d+ KiB of \d+ KiB/);
  await expect(widget.locator("[data-media-preview]")).toBeHidden();

  await expect(job).toHaveAttribute("data-media-job-status", "completed", { timeout: 60_000 });
  await expect(widget.locator("[data-media-job-message]")).toContainText(`Rendered ${String(CLIP_SECONDS - 2)}.0 s at -6 dB`);
  const preview = widget.locator("[data-media-preview]");
  await expect(preview).toHaveAttribute("data-media-preview", "ready", { timeout: 30_000 });
  await expect(widget.locator("[data-media-preview-meta]")).toHaveAttribute("data-media-duration", `${String(CLIP_SECONDS - 2)}.000`);
  const digest = (await widget.locator("[data-media-digest]").getAttribute("data-media-digest")) ?? "";
  expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  await expect(page.getByText(`The package job for ${CAPABILITY} completed`).last()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("media-render-1280-light.png"), fullPage: true });

  // Saved through the host's prompt, the file is the render the digest names: the trimmed clip, at the new gain.
  await widget.locator("[data-media-export]").click();
  const savePrompt = page.locator("[data-artifact-prompt='export']");
  await expect(savePrompt).toBeVisible({ timeout: 20_000 });
  const download = page.waitForEvent("download");
  await savePrompt.locator("[data-artifact-save]").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("giong-noi-render.wav");
  const rendered = readFileSync(await saved.path());
  expect(rendered.byteLength).toBe(44 + (CLIP_SECONDS - 2) * 22_050 * 2);
  expect(rendered.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(sha256(rendered)).toBe(digest);
  // Every sample at -6 dB is about half the source's, so the file is not the clip passed through.
  expect(sha256(rendered)).not.toBe(sha256(CLIP));
  await expect(widget.locator("[data-media-status='exported']")).toHaveCount(1, { timeout: 20_000 });

  // Attaching puts the rendered file in the composer, ready to send.
  await widget.locator("[data-media-attach]").click();
  await expect(widget.locator("[data-media-status='attached']")).toHaveCount(1, { timeout: 20_000 });
  const chip = page.locator("[data-attachment-chip]").last();
  await expect(chip).toHaveAttribute("data-attachment-state", "ready", { timeout: 20_000 });

  // A press the host refuses starts nothing, so the finished render stays on screen with its actions.
  await refuseOnce(widget, "invoke", "the node is restarting its services");
  await widget.locator("[data-media-render]").click();
  await expect(widget.locator("[data-media-status='refused']")).toContainText("the node is restarting its services", { timeout: 20_000 });
  await expect(preview).toHaveAttribute("data-media-preview", "ready");
  await expect(widget.locator("[data-media-digest]")).toHaveAttribute("data-media-digest", digest);
  await expect(job).toHaveAttribute("data-media-job-status", "completed");
  await expect(widget.locator("[data-media-attach]")).toBeEnabled();
  await expect(widget.locator("[data-media-export]")).toBeEnabled();

  expect(await horizontalOverflow(page)).toBe(0);
});

test("Escape stops a render mid-way, and the stopped render leaves no file", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  const widget = await composeTool(page);
  await serviceReady(widget);
  await pickClip(page, widget);
  const jobId = await startRender(widget);
  const job = widget.locator("[data-media-job]");
  await expect(widget.locator("[data-media-progress]")).toHaveAttribute("data-media-progress", /^[1-9]\d?$/, { timeout: 30_000 });

  // A stop the host refuses leaves the render running, says so, and offers Stop and Escape again.
  await refuseOnce(widget, "cancel", "the node could not reach the job");
  await widget.locator("[data-media-cancel]").focus();
  await widget.locator("[data-media-cancel]").press("Escape");
  await expect(widget.locator("[data-media-status='refused']")).toContainText(
    "Chưa dừng được: the node could not reach the job. Bản dựng vẫn đang chạy; bấm Dừng dựng để thử lại.",
    { timeout: 20_000 },
  );
  await expect(job).toHaveAttribute("data-media-job-status", "running");
  await expect(widget.locator("[data-media-cancel]")).toBeEnabled();

  await widget.locator("[data-media-cancel]").press("Escape");
  await expect(job).toHaveAttribute("data-media-job-status", "cancelled", { timeout: 30_000 });
  await expect(job).toHaveAttribute("data-media-job-id", jobId);
  await expect(widget.locator("[data-media-job-message]")).toContainText("Đã dừng; không có tệp kết quả nào.");
  const stoppedAt = Number(await widget.locator("[data-media-progress]").getAttribute("data-media-progress"));
  expect(stoppedAt).toBeLessThan(100);
  await expect(widget.locator("[data-media-preview]")).toBeHidden();
  await expect(widget.locator("[data-media-cancel]")).toBeDisabled();
  // Focus goes back to Render, so a keyboard user can start again where they were.
  await expect(widget.locator("[data-media-render]")).toBeFocused();
  await expect(page.getByText(`The package job for ${CAPABILITY} was stopped`).last()).toBeVisible({ timeout: 30_000 });

  // The node's own snapshot of the stopped job carries no file: nothing was finalized as the render.
  const snapshot = await widget.locator("body").evaluate(async (_body, ref) => {
    const api = (window as unknown as { clarkcantWidget: { api: () => { jobs: { get: (id: string) => Promise<{ status: string; resultRefs: unknown[] }> } } } }).clarkcantWidget.api();
    const read = await api.jobs.get(ref);
    return { status: read.status, resultRefs: read.resultRefs };
  }, jobId);
  expect(snapshot).toEqual({ status: "cancelled", resultRefs: [] });

  // And after a reload the stopped render is still a stopped render, with no file shown as finished.
  await page.reload();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  const remounted = await openLive(page, { restored: true });
  await expect(remounted.locator("[data-media-job]")).toHaveAttribute("data-media-job-status", "cancelled", { timeout: 30_000 });
  await expect(remounted.locator("[data-media-preview]")).toBeHidden();
});

test("a remounted frame follows the same render to its file", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  let widget = await composeTool(page);
  await serviceReady(widget);
  await pickClip(page, widget);
  const jobId = await startRender(widget);
  await expect(widget.locator("[data-media-job]")).toHaveAttribute("data-media-job-status", "running", { timeout: 30_000 });
  // Long enough for the widget to have written its JobRef to state.
  await page.waitForTimeout(500);

  await page.reload();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  widget = await openLive(page, { restored: true });
  const job = widget.locator("[data-media-job]");
  await expect(job).toHaveAttribute("data-media-job-id", jobId, { timeout: 30_000 });
  await expect(job).toHaveAttribute("data-media-job-status", "completed", { timeout: 60_000 });
  await expect(widget.locator("[data-media-preview]")).toHaveAttribute("data-media-preview", "ready", { timeout: 30_000 });
  await expect(widget.locator("[data-media-preview-meta]")).toHaveAttribute("data-media-duration", `${String(CLIP_SECONDS)}.000`);

  // Another reload shows the finished file again from widget state, without rendering anything new.
  await page.reload();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  widget = await openLive(page, { restored: true });
  await expect(widget.locator("[data-media-job]")).toHaveAttribute("data-media-job-id", jobId, { timeout: 30_000 });
  await expect(widget.locator("[data-media-preview]")).toHaveAttribute("data-media-preview", "ready", { timeout: 30_000 });
});

test("keyboard only, at 390 px, in dark with reduced motion: pick, set, render and reach the preview", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openApp(page);
  const widget = await composeTool(page);
  await serviceReady(widget);

  // The frame follows the host's dark appearance and draws no motion.
  await expect(widget.locator("html[data-scheme='dark']")).toHaveCount(1);
  const transition = await widget.locator("[data-media-pick]").evaluate((button) => window.getComputedStyle(button).transitionDuration);
  expect(transition).toBe("0s");

  await widget.locator("[data-media-pick]").focus();
  await widget.locator("[data-media-pick]").press("Enter");
  // The host's question takes the keyboard at its title; one Tab reaches the choice.
  const prompt = page.locator("[data-artifact-prompt='pick']");
  await expect(prompt.locator("[data-artifact-title]")).toBeFocused({ timeout: 20_000 });
  await page.keyboard.press("Tab");
  await expect(prompt.locator("[data-artifact-choose]")).toBeFocused();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: CLIP_NAME, mimeType: "audio/wav", buffer: CLIP });
  await expect(widget.locator("[data-media-status='picked']")).toHaveCount(1, { timeout: 20_000 });

  await widget.locator("[data-media-pick]").focus();
  await page.keyboard.press("Tab");
  await expect(widget.locator("[data-media-gain]")).toBeFocused();
  // A keyboard with a minus key, so a cut in gain can be typed by touch; the typographic minus a phone may insert counts.
  await expect(widget.locator("[data-media-gain]")).toHaveAttribute("inputmode", "text");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("−3");
  await page.keyboard.press("Tab");
  await expect(widget.locator("[data-media-trim-start]")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(widget.locator("[data-media-trim-end]")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(String((CLIP_SECONDS - 10) * 1000));
  await page.keyboard.press("Tab");
  await expect(widget.locator("[data-media-render]")).toBeFocused();
  await page.keyboard.press("Enter");

  const job = widget.locator("[data-media-job]");
  await expect(job).toHaveAttribute("data-media-job-status", "completed", { timeout: 60_000 });
  await expect(widget.locator("[data-media-job-message]")).toContainText("Rendered 10.0 s at -3 dB");
  await expect(widget.locator("[data-media-preview]")).toHaveAttribute("data-media-preview", "ready", { timeout: 30_000 });
  // The finished render is announced by moving focus to its heading, and its actions are next in the tab order.
  await expect(widget.locator("#media-preview-title")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(widget.locator("[data-media-attach]")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(widget.locator("[data-media-export]")).toBeFocused();

  // Every control is a 44 px touch target at phone width.
  for (const control of ["[data-media-pick]", "[data-media-gain]", "[data-media-render]", "[data-media-cancel]", "[data-media-attach]", "[data-media-export]"]) {
    const box = await widget.locator(control).boundingBox();
    expect(box?.height ?? 0, control).toBeGreaterThanOrEqual(44);
  }

  // The waveform is drawn in the dark field colour, not the light fallback.
  const field = await widget.locator("html").evaluate((html) => window.getComputedStyle(html).getPropertyValue("--mr-field").trim());
  expect(field).not.toBe("#f6f6f7");
  await page.screenshot({ path: testInfo.outputPath("media-render-390-dark.png"), fullPage: true });
  expect(await horizontalOverflow(page)).toBe(0);
  const frameOverflow = await widget.locator("html").evaluate((html) => html.scrollWidth - html.clientWidth);
  expect(frameOverflow).toBe(0);
});

test("when a policy refuses the package's profile, the service is not started and the widget shows why", async ({ page, request }) => {
  test.setTimeout(300_000);
  const previous = await storedPolicy(request);
  try {
    await writePolicy(request, { ...previous, rules: [{ effectCategory: "local-write", decision: "deny" }] });
    await restartServices(request);

    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page);
    const widget = await composeTool(page);
    await expect(widget.locator("#root[data-media-available='false']")).toHaveCount(1, { timeout: 60_000 });
    const reason = widget.locator("[data-media-unavailable]");
    await expect(reason).toContainText("Chưa dựng được:", { timeout: 60_000 });
    await expect(reason).toContainText(/background-compute/);
    await expect(widget.locator("[data-media-render]")).toBeDisabled();
    // Render is described by the reason, so a screen reader hears why it is off.
    await expect(widget.locator("[data-media-render]")).toHaveAttribute("aria-describedby", /media-unavailable/);
    // Picking a file is still the host's, and still works; only rendering waits for the profile.
    await pickClip(page, widget);
    await expect(widget.locator("[data-media-render]")).toBeDisabled();
  } finally {
    await writePolicy(request, previous);
    await restartServices(request);
  }

  // With the policy restored and the services started again, the same tool can render.
  await openApp(page);
  const widget = await composeTool(page);
  await serviceReady(widget);
});
