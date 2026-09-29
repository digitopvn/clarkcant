import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

/**
 * A package that ships a widget and a service, used from the widget, the agent and voice.
 *
 * The notes package's widget keeps nothing itself: its buttons are bindings to capabilities its own service provides,
 * and the service runs in a container the node started when the package was installed. The agent and a spoken sentence
 * reach the same capability through the same gate, so a note one of them adds is one the others read back — which is
 * the observable form of "one path", since the node writes a single file the three can only share through the service.
 *
 * Needs a container engine that runs Linux containers (the Linux CI runner has Docker). The first start fetches the
 * pinned Node image, which is why the first wait is long.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.example.notes";
const FRAME = "[data-pin-live] [data-widget-frame]";

function identity(): { token: string; nodeId: string } {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown; nodeId?: unknown };
  if (typeof parsed.localToken !== "string" || typeof parsed.nodeId !== "string") throw new Error("no identity");
  return { token: parsed.localToken, nodeId: parsed.nodeId };
}

async function install(request: APIRequestContext): Promise<void> {
  const headers = { authorization: `Bearer ${identity().token}` };
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers })).json()) as { packages: { packageId: string }[] };
  if (listed.packages.some((entry) => entry.packageId === PACKAGE)) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers,
    data: { packageId: PACKAGE, version: "1.0.0", localDigest: "sha256:notes-service-digest" },
  });
  expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
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

/** Compose the notes widget and open it live, then wait until the host has said its service can run. */
async function openNotes(page: Page): Promise<FrameLocator> {
  await say(page, "widget ghi chú");
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  await expect(page.locator(FRAME)).toHaveAttribute("data-frame-status", "ready", { timeout: 30_000 });
  const widget = page.frameLocator(`${FRAME} iframe`);
  // The first start fetches the image and starts Node in a container; the frame re-reads availability every few seconds.
  await expect(widget.locator("#root[data-notes-announced='true'][data-notes-service='available']")).toBeVisible({
    timeout: 180_000,
  });
  return widget;
}

async function press(widget: FrameLocator, button: "add" | "list", text?: string): Promise<void> {
  if (text !== undefined) await widget.locator("[data-notes-text]").fill(text);
  await widget.locator(button === "add" ? "[data-notes-add]" : "[data-notes-list]").click();
}

/** The containers this node started for its services, found by the label the node gives them. */
function serviceContainers(): string[] {
  const listed = execFileSync("docker", ["ps", "--quiet", "--filter", `label=clarkcant.node=${identity().nodeId}`], {
    encoding: "utf8",
  });
  return listed.split(/\s+/).filter((id) => id !== "");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await install(request);
});

test("the widget's button calls the package's service and shows what it answered", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const widget = await openNotes(page);
  const note = `mua sữa ${String(Date.now())}`;

  await press(widget, "add", note);

  const output = widget.locator("[data-notes-output]");
  await expect(output).toHaveAttribute("data-notes-state", "done", { timeout: 30_000 });
  // The service's own words: "Saved. N note(s): …", written by the process in the container, not by the host.
  await expect(output).toContainText("Saved.");
  await expect(output).toContainText(note);
  // Nothing about the service is wrong, so the host says nothing about it.
  await expect(page.locator("[data-unavailable-capabilities]")).toHaveCount(0);
});

test("the agent calls the same capability, and the widget reads back what it added", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const note = `gọi thợ sửa ống nước ${String(Date.now())}`;

  await say(page, `ghi chú giúp tui: ${note}`);
  // The tool's answer names the capability and quotes the service; a refusal would say "Không gọi được".
  await expect(page.getByText(`Đã gọi com.example.notes.add@1`).last()).toBeVisible({ timeout: 60_000 });

  const widget = await openNotes(page);
  await press(widget, "list");
  const output = widget.locator("[data-notes-output]");
  await expect(output).toHaveAttribute("data-notes-state", "done", { timeout: 30_000 });
  await expect(output).toContainText(note);
});

test("a spoken command runs the widget's action through the same host path", async ({ page, request }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const widget = await openNotes(page);
  const note = `nói ra ${String(Date.now())}`;
  await press(widget, "add", note);
  await expect(widget.locator("[data-notes-output]")).toContainText(note, { timeout: 30_000 });

  const scripted = await request.post(`${GATEWAY}/voice-fixture/words`, {
    headers: { authorization: `Bearer ${identity().token}` },
    data: { words: "tải danh sách" },
  });
  expect(scripted.status()).toBe(200);
  await page.locator('[data-voice-open="true"]').click();

  // What voice says back is the service's answer, read from the node's result — so it contains the note the click added.
  await expect(page.getByText(new RegExp(`Đã Tải danh sách\\..*${note}`)).first()).toBeVisible({ timeout: 30_000 });
});

test("a killed service shows as unavailable with its reason, the frame stays usable, and it comes back", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const widget = await openNotes(page);

  const running = serviceContainers();
  expect(running.length, "the node should be running the notes service in a container").toBeGreaterThan(0);
  execFileSync("docker", ["kill", ...running]);
  // Long enough for the node to see the process end, and well inside the one-second wait before it restarts.
  await page.waitForTimeout(300);

  await press(widget, "list");

  const output = widget.locator("[data-notes-output]");
  await expect(output).toHaveAttribute("data-notes-state", "refused", { timeout: 15_000 });
  await expect(output).toContainText("stopped");
  // The host says it too, with the node's reason, and the widget is still there to read and type into.
  const notice = page.locator("[data-unavailable-capabilities]");
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await notice.locator("summary").click();
  await expect(notice).toContainText("com.example.notes.list@1");
  await expect(widget.locator("[data-notes-text]")).toBeVisible();
  await expect(page.locator(FRAME)).not.toHaveAttribute("data-frame-status", "refused");

  // The widget is told too, and turns off what cannot run rather than letting the next click fail.
  await expect(widget.locator("#root[data-notes-service='unavailable']")).toBeVisible({ timeout: 10_000 });
  // The frame grows to what the widget says it needs, so the reason is read in full rather than cut off at the edge.
  const contentBottom = (): Promise<number> =>
    widget.locator("#root").evaluate((element) => Math.ceil(element.getBoundingClientRect().bottom));
  const frameHeight = (): Promise<number> =>
    page.locator(`${FRAME} iframe`).evaluate((element) => element.getBoundingClientRect().height);
  await expect.poll(async () => (await frameHeight()) - (await contentBottom()), { timeout: 5_000 }).toBeGreaterThanOrEqual(0);

  // The node restarts it, the frame learns that from its next read, and the same button works again.
  await expect(widget.locator("#root[data-notes-service='available']")).toBeVisible({ timeout: 60_000 });
  await expect(notice).toHaveCount(0, { timeout: 15_000 });
  await press(widget, "list");
  await expect(output).toHaveAttribute("data-notes-state", "done", { timeout: 30_000 });
});
