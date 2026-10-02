import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

import { renderImage } from "../../../examples/reference-apps/image-generator/service/png.mjs";
import { type FakeProvider, startFakeProvider } from "../../../examples/reference-apps/image-generator/test/fake-provider.ts";

/**
 * Reference app C, the image generator: a prompt, a job the widget follows, and an image that comes back as an artifact.
 *
 * The package's service runs in a container with no network. It asks the node to reach the provider origin its manifest
 * declares, and the node adds the key the person stored for the package. The provider here is the fake one the app's
 * unit tests use, on that declared origin: it answers only requests carrying the key, advances one step per status read,
 * and can be held at a step, so a reload lands while the job is still running.
 *
 * One widget instance is placed once and reopened by every journey after the first, because Clark starts the job
 * through the conversation's image generator, and a conversation with several would make Clark ask which one.
 *
 * Needs a container engine that runs Linux containers, like the other package-service journeys.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.clarkcant.reference.image-generator";
const GENERATE = `${PACKAGE}.image.generate@1`;
const SECRET = "IMAGE_PROVIDER_KEY";
/** The origin the package declares. Fixed, because a declared origin is part of what the person consented to. */
const PROVIDER_PORT = 8881;
const FRAME = "[data-pin-live] [data-widget-frame]";

// Generated for this run, so nothing in the repository could be mistaken for a provider's key.
const KEY = `fake-image-key-${randomBytes(16).toString("hex")}`;

let provider: FakeProvider | undefined;

function identity(): { token: string; nodeId: string } {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown; nodeId?: unknown };
  if (typeof parsed.localToken !== "string" || typeof parsed.nodeId !== "string") throw new Error("no identity");
  return { token: parsed.localToken, nodeId: parsed.nodeId };
}
const auth = (): Record<string, string> => ({ authorization: `Bearer ${identity().token}` });

function fake(): FakeProvider {
  if (provider === undefined) throw new Error("the fake provider is not running");
  return provider;
}

async function installedPackages(request: APIRequestContext): Promise<string[]> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: auth() })).json()) as { packages: { packageId: string }[] };
  return listed.packages.map((entry) => entry.packageId);
}

/** Records every bridge message each document receives: the page hears the widget, the frame hears the host. */
async function recordBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __ccBridge: string[] }).__ccBridge = store;
    window.addEventListener(
      "message",
      (event) => {
        try {
          store.push(JSON.stringify(event.data));
        } catch {
          store.push("<unserialisable>");
        }
      },
      true,
    );
  });
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${identity().token}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

/** Open the newest widget in the conversation live, and wait until the host has told it about its button. */
async function openLive(page: Page): Promise<FrameLocator> {
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  // The node keeps a widget opened live open, so a fresh page may bring it back on its own and cover the button.
  if ((await page.locator(FRAME).count()) === 0) {
    await open.click({ timeout: 10_000 }).catch(async (error: unknown) => {
      if ((await page.locator(FRAME).count()) === 0) throw error;
    });
  }
  await expect(page.locator(FRAME).last()).toHaveAttribute("data-frame-status", "ready", { timeout: 30_000 });
  const widget = page.locator(FRAME).last().locator("iframe").contentFrame();
  await expect(widget.locator("#root[data-widget-ready='true'][data-image-announced='true']")).toBeVisible({ timeout: 30_000 });
  return widget;
}

/** The conversation the first journey placed the widget in; each test has a fresh browser context. */
let conversationId: string | undefined;

/** Reopen the one image generator this file placed, with its service signed in. */
async function reopen(page: Page): Promise<FrameLocator> {
  if (conversationId === undefined) throw new Error("the first journey did not place the image generator");
  await page.addInitScript((id) => window.sessionStorage.setItem("cc_conversation", id), conversationId);
  await openApp(page);
  const widget = await openLive(page);
  await expect(widget.locator("#root[data-image-service='available']")).toBeVisible({ timeout: 180_000 });
  return widget;
}

async function imageCount(widget: FrameLocator): Promise<number> {
  return Number((await widget.locator("#root").getAttribute("data-image-count")) ?? "0");
}

/** Write a prompt and press "Tạo ảnh"; returns the JobRef the job panel follows. */
async function generate(widget: FrameLocator, prompt: string): Promise<string> {
  await widget.locator("[data-image-prompt]").fill(prompt);
  await widget.locator("[data-image-generate]").click();
  await expect(widget.locator("[data-image-status]")).toHaveAttribute("data-image-state", "started", { timeout: 30_000 });
  const panel = widget.locator("[data-image-job]");
  await expect(panel).toHaveAttribute("data-image-job-id", /^job_/, { timeout: 30_000 });
  return (await panel.getAttribute("data-image-job-id")) ?? "";
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Everything the page can hold: its DOM, the widget's DOM, both bridge logs, and both documents' storage. */
async function pageHoldings(page: Page, widget: FrameLocator): Promise<Record<string, string>> {
  const host = await page.evaluate(() => ({
    dom: document.documentElement.outerHTML,
    bridge: JSON.stringify((window as unknown as { __ccBridge?: string[] }).__ccBridge ?? []),
    storage: JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } }),
  }));
  const frame = await widget.locator("html").evaluate((root) => {
    let storage = "unavailable to an opaque origin";
    try {
      storage = JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } });
    } catch {
      // A sandboxed frame without allow-same-origin has no storage, which is the expected answer.
    }
    return { dom: root.outerHTML, bridge: JSON.stringify((window as unknown as { __ccBridge?: string[] }).__ccBridge ?? []), storage };
  });
  return {
    "page DOM": host.dom,
    "messages the widget sent the host": host.bridge,
    "page storage": host.storage,
    "frame DOM": frame.dom,
    "messages the host sent the widget": frame.bridge,
    "frame storage": frame.storage,
  };
}

/** The containers this node started for its services, found by the label the node gives them. */
function serviceContainers(): string[] {
  const listed = execFileSync("docker", ["ps", "--quiet", "--filter", `label=clarkcant.node=${identity().nodeId}`], { encoding: "utf8" });
  return listed.split(/\s+/).filter((id) => id !== "");
}

/** The node's database files. The key's one home is the credential vault inside it, which `databaseHolds` checks apart. */
const DATABASE = /^node\.sqlite(?:-wal|-shm|-journal)?$/;

/** Every other file under the node's data directory — logs, transcripts, blobs, job results — for the key. */
function dataDirHolds(value: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) walk(path);
      else if (!(dir === DATA_DIR && DATABASE.test(name)) && stats.size < 256 * 1024 * 1024 && readFileSync(path).includes(value)) found.push(path);
    }
  };
  walk(DATA_DIR);
  return found;
}

/** The node's tables that hold the key, read from the live database: only the credential vault may. */
function databaseHolds(value: string): string[] {
  const db = new DatabaseSync(join(DATA_DIR, "node.sqlite"), { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    return tables
      .map((table) => table.name)
      .filter((name) => JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()).includes(value));
  } finally {
    db.close();
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  provider = await startFakeProvider({ key: KEY, port: PROVIDER_PORT });
  if (!(await installedPackages(request)).includes(PACKAGE)) {
    const installed = await request.post(`${GATEWAY}/packages/install`, {
      headers: auth(),
      data: { packageId: PACKAGE, version: "1.0.0", localDigest: "sha256:image-generator-reference-digest" },
    });
    expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
  }
});

test.afterAll(async ({ request }) => {
  // Left as the suite found it: other specs count the node's credentials and packages.
  await request.delete(`${GATEWAY}/credentials/${SECRET}`, { headers: auth() });
  await request.post(`${GATEWAY}/packages/${encodeURIComponent(PACKAGE)}/uninstall`, { headers: auth() });
  await provider?.close();
});

test("a prompt becomes a job whose progress survives a reload, and its image lands in the gallery to attach and export", async ({
  page,
  request,
}) => {
  test.setTimeout(420_000);
  await recordBridge(page);
  await openApp(page);
  await say(page, "trình tạo ảnh");
  let widget = await openLive(page);
  conversationId = (await page.evaluate(() => window.sessionStorage.getItem("cc_conversation"))) ?? undefined;

  // Before the person gives the package its key, the button is off with the node's reason, and nothing was sent.
  // The first start fetches the image and starts Node in a container; until then the reason is that it is starting.
  await expect(widget.locator("[data-image-unavailable]")).toContainText(SECRET, { timeout: 180_000 });
  await expect(widget.locator("#root[data-image-service='unavailable']")).toBeVisible();
  await expect(widget.locator("[data-image-generate]")).toBeDisabled();
  expect(fake().requests).toEqual([]);

  const stored = await request.post(`${GATEWAY}/credentials`, {
    headers: auth(),
    data: { fields: [{ name: SECRET, value: KEY, kind: "token", consumer: `package:${PACKAGE}` }] },
  });
  expect(stored.status()).toBe(201);
  expect(await stored.text()).not.toContain(KEY);
  await expect(widget.locator("#root[data-image-service='available']")).toBeVisible({ timeout: 60_000 });
  await expect(widget.locator("[data-image-empty]")).toBeVisible();

  // Held at the second of four steps, so the job is still running when the frame goes away.
  fake().holdAt(2);
  const prompt = "a red kite over a green sea";
  const jobId = await generate(widget, prompt);
  const panel = widget.locator("[data-image-job]");
  await expect(panel).toHaveAttribute("data-image-job-status", "running", { timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-image-job-progress", "2", { timeout: 30_000 });
  await expect(panel).toContainText("bước 2/4");
  await expect(widget.locator("[data-image-cancel]")).toBeEnabled();

  // A reload unmounts the frame. The remounted widget lists its jobs from the node and follows the same one.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  widget = await openLive(page);
  const resumed = widget.locator("[data-image-job]");
  await expect(resumed).toHaveAttribute("data-image-job-id", jobId, { timeout: 30_000 });
  await expect(resumed).toHaveAttribute("data-image-job-status", "running");
  await expect(resumed).toHaveAttribute("data-image-job-progress", "2");
  // The draft came back from widget state too.
  await expect(widget.locator("[data-image-prompt]")).toHaveValue(prompt);

  fake().release();
  await expect(resumed).toBeHidden({ timeout: 60_000 });
  const image = widget.locator("[data-image-gallery] img[data-image-loaded]");
  await expect(image).toHaveCount(1, { timeout: 30_000 });
  await expect(widget.locator("#root")).toHaveAttribute("data-image-count", "1");
  // The bytes the widget read from the result artifact are the provider's image for this prompt.
  expect(await image.getAttribute("src")).toBe(`data:image/png;base64,${renderImage(prompt).toString("base64")}`);
  await expect(page.getByText(`The package job for ${GENERATE} completed`).last()).toBeVisible({ timeout: 30_000 });

  // Every request reached the provider with the key, which only the node could have added, and only as reads.
  expect(fake().requests.length).toBeGreaterThanOrEqual(4);
  expect(fake().requests.every((entry) => entry.authorized && entry.method === "GET")).toBe(true);

  // Attach puts the image in the composer; the person decides whether to send it.
  const item = widget.locator("[data-image-item]").first();
  await item.locator("[data-image-attach]").click();
  await expect(item.locator("[data-image-item-status]")).toHaveAttribute("data-image-item-state", "attached", { timeout: 20_000 });
  const chip = page.locator("[data-attachment-chip]").last();
  await expect(chip).toHaveAttribute("data-attachment-state", "ready", { timeout: 20_000 });
  await expect(chip).toHaveAttribute("data-attachment-chip", /\.png$/);
  await chip.locator("[data-attachment-remove]").click();
  await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);

  // Export is the host's: on the web it saves through the browser's own download.
  await item.locator("[data-image-export]").click();
  const savePrompt = page.locator("[data-artifact-prompt='export']");
  await expect(savePrompt).toBeVisible();
  const download = page.waitForEvent("download");
  await savePrompt.locator("[data-artifact-save]").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("anh-1.png");
  expect(readFileSync(await saved.path()).equals(renderImage(prompt))).toBe(true);
  await expect(item.locator("[data-image-item-status]")).toHaveAttribute("data-image-item-state", "exported", { timeout: 20_000 });

  // The key is nowhere the person's page, the widget, the node's records or the service's container can reach.
  for (const [where, text] of Object.entries(await pageHoldings(page, widget))) expect(text, `the key is in the ${where}`).not.toContain(KEY);
  const conversations = await request.get(`${GATEWAY}/conversations`, { headers: auth() });
  expect(await conversations.text()).not.toContain(KEY);
  expect(dataDirHolds(KEY)).toEqual([]);
  // Not in widget state, the job's record, its notes, the audit or the transcript: only in the vault it was stored in.
  expect(databaseHolds(KEY)).toEqual(["credentials"]);
  const containers = serviceContainers();
  expect(containers.length, "the node should be running the image service in a container").toBeGreaterThan(0);
  const inspected = JSON.parse(execFileSync("docker", ["inspect", ...containers], { encoding: "utf8" })) as {
    Config: { Env: string[] | null };
    HostConfig: { NetworkMode: string };
  }[];
  for (const entry of inspected) {
    expect(entry.HostConfig.NetworkMode).toBe("none");
    expect(JSON.stringify(entry.Config.Env ?? [])).not.toContain(KEY);
  }
  for (const id of containers) expect(execFileSync("docker", ["exec", id, "env"], { encoding: "utf8" })).not.toContain(KEY);
});

test("Stop ends a running job and the provider is not asked again; a provider failure is shown in its own words", async ({ page }) => {
  test.setTimeout(300_000);
  const widget = await reopen(page);
  const before = await imageCount(widget);

  fake().holdAt(1);
  try {
    const jobId = await generate(widget, "a lighthouse in the fog");
    const panel = widget.locator("[data-image-job]");
    await expect(panel).toHaveAttribute("data-image-job-progress", "1", { timeout: 30_000 });
    await widget.locator("[data-image-cancel]").click();
    await expect(panel).toHaveAttribute("data-image-job-status", "cancelled", { timeout: 30_000 });
    await expect(panel).toHaveAttribute("data-image-job-id", jobId);
    // It may have finished part of the work before it heard the stop, and the widget says so.
    await expect(panel).toContainText("Đã dừng");
    await expect(widget.locator("[data-image-cancel]")).toBeHidden();
    await expect(page.getByText(`The package job for ${GENERATE} was stopped`).last()).toBeVisible({ timeout: 30_000 });
    const asked = fake().requests.length;
    await page.waitForTimeout(3_000);
    expect(fake().requests.length, "the service kept polling the provider after the job was stopped").toBe(asked);
  } finally {
    fake().release();
  }

  fake().failNext(2, "the provider ran out of ink");
  await generate(widget, "a cat made of clouds");
  const panel = widget.locator("[data-image-job]");
  await expect(panel).toHaveAttribute("data-image-job-status", "failed", { timeout: 60_000 });
  await expect(panel).toContainText("the provider ran out of ink");
  expect(await imageCount(widget)).toBe(before);
});

test("Clark and a spoken request start the same job through the widget, which follows it to the image", async ({ page }) => {
  test.setTimeout(300_000);
  let widget = await reopen(page);
  const before = await imageCount(widget);

  // Clark: the tool starts the job through this conversation's image generator, so the widget shows it.
  await say(page, "tạo ảnh giúp tui: a paper boat on a river");
  await expect(page.getByText(/Đã bắt đầu job job_\S+ cho com\.clarkcant\.reference\.image-generator\.image\.generate@1/u).last()).toBeVisible({
    timeout: 30_000,
  });
  widget = await openLive(page);
  await expect(widget.locator("#root")).toHaveAttribute("data-image-count", String(before + 1), { timeout: 60_000 });
  await expect(widget.locator("[data-image-gallery] figcaption").first()).toContainText("a paper boat on a river");

  // Voice: the button's label, said with the widget open, runs the draft prompt kept in its state.
  await widget.locator("[data-image-prompt]").fill("a snowy mountain at dawn");
  // The draft is written to widget state after a short pause in typing.
  await page.waitForTimeout(1_500);
  const scripted = await page.request.post(`${GATEWAY}/voice-fixture/words`, { headers: auth(), data: { words: "tạo ảnh" } });
  expect(scripted.status()).toBe(200);
  await page.locator('[data-voice-open="true"]').click();
  // Said as a job that started, not as done and not as waiting on an approval.
  await expect(page.getByText("Đã bắt đầu “Tạo ảnh”").first()).toBeVisible({ timeout: 30_000 });
  // The scripted provider hears the same words again every second of capture, so the session ends here.
  await page.locator("[data-voice-end='true']").click();
  await expect(widget.locator("[data-image-gallery] figcaption").first()).toContainText("a snowy mountain at dawn", { timeout: 60_000 });
  expect(await imageCount(widget)).toBeGreaterThanOrEqual(before + 2);
  await expect(widget.locator("[data-image-job]")).toBeHidden({ timeout: 60_000 });
});

test("the widget works from the keyboard, in both themes, on a phone and with reduced motion", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const widget = await reopen(page);

  // Keyboard only: focus the prompt, Ctrl+Enter generates, Tab reaches the gallery's buttons.
  const field = widget.locator("[data-image-prompt]");
  await field.focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("a blue fox in tall grass");
  await page.keyboard.press("Control+Enter");
  await expect(widget.locator("[data-image-gallery] figcaption").first()).toContainText("a blue fox in tall grass", { timeout: 60_000 });
  await expect(widget.locator("[data-image-gallery] img[data-image-loaded]").first()).toBeVisible({ timeout: 30_000 });
  const attach = widget.locator("[data-image-item]").first().locator("[data-image-attach]");
  await attach.focus();
  await page.keyboard.press("Tab");
  await expect(widget.locator("[data-image-item]").first().locator("[data-image-export]")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(attach).toBeFocused();
  // A visible focus ring, not one only a pointer user would never miss.
  expect(await attach.evaluate((button) => getComputedStyle(button).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(widget.locator("[data-image-item]").first().locator("[data-image-item-status]")).toHaveAttribute("data-image-item-state", "attached", {
    timeout: 20_000,
  });
  await page.locator("[data-attachment-chip] [data-attachment-remove]").last().click();

  // Reduced motion wins over the widget's own transitions.
  expect(await attach.evaluate((button) => getComputedStyle(button).transitionDuration)).toBe("0s");

  const overflow: Record<string, number> = {};
  const frameOverflow = (): Promise<number> => widget.locator("html").evaluate((root) => root.scrollWidth - root.clientWidth);
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await expect(widget.locator(`html[data-scheme='${colorScheme}']`)).toHaveCount(1, { timeout: 10_000 });
    await page.screenshot({ path: testInfo.outputPath(`image-generator-1280-${colorScheme}.png`), fullPage: true });
    overflow[`1280-${colorScheme}`] = await horizontalOverflow(page);
    overflow[`1280-${colorScheme}-frame`] = await frameOverflow();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(FRAME).last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("image-generator-390-light.png"), fullPage: true });
  overflow["390-light"] = await horizontalOverflow(page);
  overflow["390-light-frame"] = await frameOverflow();
  const box = await page.locator(FRAME).last().boundingBox();
  expect(box === null ? Number.POSITIVE_INFINITY : box.x + box.width).toBeLessThanOrEqual(390);

  testInfo.annotations.push({ type: "horizontal-overflow", description: JSON.stringify(overflow) });
  expect(overflow).toEqual({ "1280-dark": 0, "1280-dark-frame": 0, "1280-light": 0, "1280-light-frame": 0, "390-light": 0, "390-light-frame": 0 });
});
