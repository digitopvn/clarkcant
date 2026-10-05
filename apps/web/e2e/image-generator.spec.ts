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
const WIDGET_ID = `${PACKAGE}.main@1`;
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
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
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
  await recordBridge(page);
  await page.addInitScript((id) => window.sessionStorage.setItem("cc_conversation", id), conversationId);
  await openApp(page);
  const widget = await openLive(page);
  await expect(widget.locator("#root[data-image-service='available']")).toBeVisible({ timeout: 180_000 });
  return widget;
}

async function imageCount(widget: FrameLocator): Promise<number> {
  return Number((await widget.locator("#root").getAttribute("data-image-count")) ?? "0");
}

/** Write a prompt and press "Tạo ảnh"; returns the JobRef of the new job, whose panel is the first: newest first. */
async function generate(widget: FrameLocator, prompt: string): Promise<string> {
  const before = new Set(await widget.locator("[data-image-job]").evaluateAll((panels) => panels.map((panel) => panel.getAttribute("data-image-job-id"))));
  await widget.locator("[data-image-prompt]").fill(prompt);
  await widget.locator("[data-image-generate]").click();
  await expect(widget.locator("[data-image-status]")).toHaveAttribute("data-image-state", "started", { timeout: 30_000 });
  const panel = widget.locator("[data-image-job]").first();
  await expect(panel).toHaveAttribute("data-image-job-id", /^job_/, { timeout: 30_000 });
  await expect.poll(async () => before.has(await panel.getAttribute("data-image-job-id")), { timeout: 30_000 }).toBe(false);
  return (await panel.getAttribute("data-image-job-id")) ?? "";
}

/** The panel of one job, by its JobRef. */
const jobPanel = (widget: FrameLocator, jobId: string) => widget.locator(`[data-image-job][data-image-job-id="${jobId}"]`);

/** The end of a job's id the widget puts in the file name it proposes, so two images never share one. */
const jobSuffix = (jobId: string): string => jobId.replace(/^job_/u, "").replace(/[^A-Za-z0-9]/gu, "").slice(-6).toLowerCase();

/** Every request reached the provider with the key the node added. Starting an image was a POST; the rest were reads. */
function expectProviderRequestsSigned(): void {
  const requests = fake().requests;
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((entry) => entry.authorized)).toBe(true);
  expect(requests.filter((entry) => entry.method === "POST").every((entry) => entry.path === "/v1/images/generate")).toBe(true);
  expect(requests.filter((entry) => entry.path === "/v1/images/generate").every((entry) => entry.method === "POST")).toBe(true);
  expect(requests.filter((entry) => entry.path !== "/v1/images/generate").every((entry) => entry.method === "GET")).toBe(true);
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

/**
 * The key is nowhere the person's page, the widget, the node's records or the service's container can reach.
 *
 * Run at the end of every journey, because each one takes the key down a different path: a finished image, a Stop, a
 * provider error that echoes the key, Clark's tool, a spoken request, an approval.
 */
async function expectKeyNowhere(page: Page, widget: FrameLocator, request: APIRequestContext): Promise<void> {
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
}

/** Inbox notices asking whether an effect took effect, with the effect each one offers an answer for. */
async function reconcileQuestions(request: APIRequestContext): Promise<{ noticeId: string; effectId: string }[]> {
  const inbox = (await (await request.get(`${GATEWAY}/inbox`, { headers: auth() })).json()) as {
    notices: { noticeId: string; actions?: { id: string; effectId?: string }[] }[];
  };
  return inbox.notices.flatMap((notice) => {
    const effectId = notice.actions?.find((action) => action.id === "reconcile-failed")?.effectId;
    return effectId === undefined ? [] : [{ noticeId: notice.noticeId, effectId }];
  });
}

const POLICY_KEY = "execution.policy";

async function storedPolicy(request: APIRequestContext): Promise<Record<string, unknown>> {
  const listed = (await (await request.get(`${GATEWAY}/preferences`, { headers: auth() })).json()) as {
    preferences: { key: string; value: unknown }[];
  };
  const policy = listed.preferences.find((entry) => entry.key === POLICY_KEY)?.value;
  if (typeof policy !== "object" || policy === null) throw new Error("the node reports no execution policy");
  return policy as Record<string, unknown>;
}

async function writePolicy(request: APIRequestContext, value: Record<string, unknown>): Promise<void> {
  const written = await request.put(`${GATEWAY}/preferences/${POLICY_KEY}`, { headers: auth(), data: { value } });
  expect(written.ok(), await written.text()).toBe(true);
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
  // Placed the way a model places it: `place_widget`, with the button bound to the package's own capability.
  await say(page, `place widget ${WIDGET_ID}`);
  await expect(page.getByText(/Fixture: tui gọi place_widget .*Placed /u).last()).toBeVisible({ timeout: 20_000 });
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
  const panel = jobPanel(widget, jobId);
  await expect(panel).toHaveAttribute("data-image-job-status", "running", { timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-image-job-progress", "2", { timeout: 30_000 });
  await expect(panel).toContainText("bước 2/4");
  await expect(panel.locator("[data-image-cancel]")).toBeEnabled();

  // A reload unmounts the frame. The remounted widget lists its jobs from the node and follows the same one.
  await page.reload();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  widget = await openLive(page);
  await expect(widget.locator("[data-image-list-note]")).toBeHidden();
  const resumed = jobPanel(widget, jobId);
  await expect(resumed).toBeVisible({ timeout: 30_000 });
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

  // Every request reached the provider with the key, which only the node could have added. The capability is declared
  // external-write, so the node sent the start as a POST with the prompt in its body; following it were reads.
  expect(fake().requests.length).toBeGreaterThanOrEqual(4);
  expect(fake().requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
  expectProviderRequestsSigned();

  // Attach puts the image in the composer; the person decides whether to send it. It is named after its prompt and its
  // job, as the widget proposed and the node sanitized, not `untitled.png`.
  const item = widget.locator("[data-image-item]").first();
  await item.locator("[data-image-attach]").click();
  await expect(item.locator("[data-image-item-status]")).toHaveAttribute("data-image-item-state", "attached", { timeout: 20_000 });
  const chip = page.locator("[data-attachment-chip]").last();
  await expect(chip).toHaveAttribute("data-attachment-state", "ready", { timeout: 20_000 });
  await expect(chip).toHaveAttribute("data-attachment-chip", `a-red-kite-over-a-green-sea-${jobSuffix(jobId)}.png`);
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

  await expectKeyNowhere(page, widget, request);
});

test("every running job keeps its own Stop, a stopped job asks the provider nothing more, and a failure quotes the provider", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const widget = await reopen(page);
  const before = await imageCount(widget);
  const waitingBefore = new Set((await reconcileQuestions(request)).map((question) => question.noticeId));

  fake().holdAt(1);
  try {
    // Two images at once: each keeps its own progress and its own Stop, not only the newest.
    const first = await generate(widget, "a lighthouse in the fog");
    await expect(jobPanel(widget, first)).toHaveAttribute("data-image-job-progress", "1", { timeout: 30_000 });
    const second = await generate(widget, "a harbour at night");
    await expect(jobPanel(widget, second)).toHaveAttribute("data-image-job-progress", "1", { timeout: 30_000 });
    await expect(widget.locator("[data-image-job][data-image-job-status='running']")).toHaveCount(2);
    await expect(jobPanel(widget, first).locator("[data-image-cancel]")).toBeEnabled();
    await expect(jobPanel(widget, second).locator("[data-image-cancel]")).toBeEnabled();

    // The older one is stopped from its own panel; the newer one keeps running, with its Stop.
    await jobPanel(widget, first).locator("[data-image-cancel]").click();
    await expect(jobPanel(widget, first)).toBeHidden({ timeout: 30_000 });
    await expect(jobPanel(widget, second)).toHaveAttribute("data-image-job-status", "running");
    await expect(jobPanel(widget, second).locator("[data-image-cancel]")).toBeEnabled();

    await jobPanel(widget, second).locator("[data-image-cancel]").click();
    const panel = jobPanel(widget, second);
    await expect(panel).toHaveAttribute("data-image-job-status", "cancelled", { timeout: 30_000 });
    // It may have finished part of the work before it heard the stop, and the widget says so.
    await expect(panel).toContainText("Đã dừng");
    await expect(panel.locator("[data-image-cancel]")).toBeHidden();
    await expect(page.getByText(`The package job for ${GENERATE} was stopped`).nth(1)).toBeVisible({ timeout: 30_000 });
    const asked = fake().requests.length;
    await page.waitForTimeout(3_000);
    expect(fake().requests.length, "the service kept polling the provider after the job was stopped").toBe(asked);
  } finally {
    fake().release();
  }

  // The provider fails and repeats the key it was sent in its reason. The node removed the key from the answer before
  // the service read it, and the widget frames the provider's words as the provider's, in its own language.
  fake().failNext(2, "the provider ran out of ink", { echoKey: true });
  const failing = await generate(widget, "a cat made of clouds");
  const panel = jobPanel(widget, failing);
  await expect(panel).toHaveAttribute("data-image-job-status", "failed", { timeout: 60_000 });
  await expect(panel).toContainText("Dịch vụ tạo ảnh báo: “The provider could not make the image: the provider ran out of ink (request signed with [redacted])”");
  await expect(panel).not.toContainText(KEY);
  expect(await imageCount(widget)).toBe(before);
  expectProviderRequestsSigned();

  // Each of the three was sent to the service, so whether it took effect is the person's to say: the inbox asks about
  // the two stopped jobs and the failed one. The provider made no image for any of them, so the honest answer is that
  // none took effect. Answering also leaves nothing waiting for the journeys after this one.
  const askedAbout = async () => (await reconcileQuestions(request)).filter((question) => !waitingBefore.has(question.noticeId));
  await expect.poll(async () => (await askedAbout()).length, { timeout: 30_000 }).toBe(3);
  for (const question of await askedAbout()) {
    const answered = await request.post(`${GATEWAY}/effects/${question.effectId}/reconcile`, { headers: auth(), data: { outcome: "failed" } });
    expect(answered.ok(), `reconcile answered ${String(answered.status())}: ${await answered.text()}`).toBe(true);
  }
  await expect.poll(async () => (await askedAbout()).length, { timeout: 10_000 }).toBe(0);

  await expectKeyNowhere(page, widget, request);
});

test("Clark and a spoken request start the same job through the widget, which follows it to the image", async ({ page, request }) => {
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
  expectProviderRequestsSigned();

  // Two images attached together get two names, each after its own prompt and job.
  const chips = page.locator("[data-attachment-chip]");
  await expect(chips).toHaveCount(0);
  for (const caption of ["a paper boat on a river", "a snowy mountain at dawn"]) {
    const item = widget.locator("[data-image-item]").filter({ hasText: caption }).first();
    await item.locator("[data-image-attach]").click();
    await expect(item.locator("[data-image-item-status]")).toHaveAttribute("data-image-item-state", "attached", { timeout: 20_000 });
  }
  await expect(chips).toHaveCount(2, { timeout: 20_000 });
  const names = await chips.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-attachment-chip") ?? ""));
  expect(names.find((name) => name.startsWith("a-paper-boat"))).toMatch(/^a-paper-boat-on-a-river-[0-9a-z]{6}\.png$/u);
  expect(names.find((name) => name.startsWith("a-snowy-mountain"))).toMatch(/^a-snowy-mountain-at-dawn-[0-9a-z]{6}\.png$/u);
  expect(new Set(names).size).toBe(2);
  for (let left = 2; left > 0; left -= 1) {
    await chips.last().locator("[data-attachment-remove]").click();
    await expect(chips).toHaveCount(left - 1);
  }

  await expectKeyNowhere(page, widget, request);
});

test("the widget works from the keyboard, in both themes, on a phone and with reduced motion", async ({ page, request }, testInfo) => {
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

  await expectKeyNowhere(page, widget, request);
});

test("with a policy that asks before external writes, a press waits for the person's approval on the host's card", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const previousPolicy = await storedPolicy(request);
  // Asking a provider to draw is an external write; this person's policy asks before one.
  await writePolicy(request, { ...previousPolicy, rules: [{ effectCategory: "external-write", decision: "ask" }] });
  try {
    let widget = await reopen(page);
    const before = await imageCount(widget);
    const asked = fake().requests.length;

    await widget.locator("[data-image-prompt]").fill("an owl reading a map");
    await widget.locator("[data-image-generate]").click();
    // Nothing ran: the widget is told the press waits on the person, and the provider heard nothing.
    await expect(widget.locator("[data-image-status]")).toHaveAttribute("data-image-state", "refused", { timeout: 30_000 });
    await expect(widget.locator("[data-image-status]")).toContainText("đang chờ bạn duyệt");
    expect(fake().requests.length).toBe(asked);

    // The card is the host's, in the conversation, out of the frame's reach. The person closes the live view and
    // approves it there.
    await page.locator("[data-close-live]").first().click();
    const card = page.locator('[data-host-card="approval"][data-decision="pending"]').last();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator("[data-approve]")).toBeEnabled();
    await card.locator("[data-approve]").click();
    await expect(card.locator("[data-approve]")).toHaveCount(0, { timeout: 30_000 });

    // The approved press runs as the widget's own job, so the widget finds it in its list and follows it to the image.
    widget = await openLive(page);
    await expect(widget.locator("[data-image-gallery] figcaption").first()).toContainText("an owl reading a map", { timeout: 90_000 });
    expect(await imageCount(widget)).toBe(before + 1);
    expectProviderRequestsSigned();

    await expectKeyNowhere(page, widget, request);
  } finally {
    await writePolicy(request, previousPolicy);
  }
});

test("on a host that cannot list a widget's jobs, the gallery keeps the jobs started while it is open, and says so", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  // An older host: it offers jobs@1 but not jobs.list@1. The frame's init is read with that token taken out.
  await page.addInitScript(() => {
    if (window === window.top) return;
    window.addEventListener(
      "message",
      (event) => {
        const data = event.data as { kind?: unknown; extensions?: unknown } | null;
        if (data !== null && typeof data === "object" && data.kind === "init" && Array.isArray(data.extensions)) {
          data.extensions = data.extensions.filter((token) => token !== "jobs.list@1");
        }
      },
      true,
    );
  });
  const widget = await reopen(page);

  // Images made before this mount are not listed, and the widget says why rather than looking empty for no reason.
  await expect(widget.locator("[data-image-list-note]")).toBeVisible();
  await expect(widget.locator("[data-image-list-note]")).toContainText("chỉ có ảnh tạo trong lần mở này");
  await expect(widget.locator("[data-image-empty]")).toBeVisible();

  // A job started here is followed to its image all the same.
  const jobId = await generate(widget, "a lantern on a windowsill");
  await expect(jobPanel(widget, jobId)).toBeHidden({ timeout: 60_000 });
  await expect(widget.locator("[data-image-gallery] figcaption").first()).toContainText("a lantern on a windowsill", { timeout: 30_000 });
  await expect(widget.locator("#root")).toHaveAttribute("data-image-count", "1");

  // And it never asked the host for a list the host could not answer.
  const sent = await page.evaluate(() => (window as unknown as { __ccBridge?: string[] }).__ccBridge ?? []);
  expect(sent.some((message) => message.includes('"kind":"job.request"'))).toBe(true);
  expect(sent.filter((message) => message.includes('"op":"list"'))).toEqual([]);

  await expectKeyNowhere(page, widget, request);
});
