import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * What a pinned frame does when it is scrolled out of view.
 *
 * Suspended, by default: the frame is unmounted and its live view released. The one exception is a frame whose package
 * was granted a profile with authorized playback, and which the person chose, in host chrome, to keep playing. Then it
 * keeps running out of view, the host says so in chrome the frame cannot draw, and Stop suspends it.
 *
 * The playback package is a UI-only fixture asking for `media-workstation`, the profile that authorizes playback; its
 * frame counts while its document runs. The frame widget asks for no profile, so it gets the default, which suspends.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const LIVE_READ = /\/conversations\/([^/]+)\/widgets\/([^/]+)\/live$/;

const PACKAGES = [
  { packageId: "com.example.playback", localDigest: "sha256:playback-widget-digest" },
  { packageId: "com.example.frame-widget", localDigest: "sha256:frame-widget-digest" },
];

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token()}` });

async function installedPackages(request: APIRequestContext): Promise<string[]> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: auth() })).json()) as { packages: { packageId: string }[] };
  return listed.packages.map((entry) => entry.packageId);
}

/** The packages this suite installed, so it leaves the node as it found it for the specs that count packages. */
const installedHere: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  const before = await installedPackages(request);
  for (const { packageId, localDigest } of PACKAGES) {
    if (before.includes(packageId)) continue;
    const installed = await request.post(`${GATEWAY}/packages/install`, {
      headers: auth(),
      data: { packageId, version: "1.0.0", localDigest },
    });
    expect(installed.ok(), `installing ${packageId} answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
    installedHere.push(packageId);
  }
});

test.afterAll(async ({ request }) => {
  for (const packageId of installedHere) {
    await request.post(`${GATEWAY}/packages/${encodeURIComponent(packageId)}/uninstall`, { headers: auth() });
  }
});

/** Compose a frame, open it live, and return its surface and the frame inside it. */
async function openFrame(page: Page, prompt: string): Promise<{ surface: Locator; frame: Locator }> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(prompt);
  await composer.press("Enter");
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  const liveRead = page.waitForResponse((response) => LIVE_READ.test(new URL(response.url()).pathname) && response.ok());
  await open.click();
  const instanceId = LIVE_READ.exec(new URL((await liveRead).url()).pathname)?.[2] ?? "";
  expect(instanceId).not.toBe("");
  const surface = page.locator(`[data-pin-live] [data-live-instance="${instanceId}"]`);
  await expect(surface).toHaveAttribute("data-lazy", "false", { timeout: 30_000 });
  const frame = surface.locator("[data-widget-frame]");
  await expect(frame).toHaveAttribute("data-frame-status", "ready", { timeout: 30_000 });
  return { surface, frame };
}

/**
 * Pushed out of the viewport directly rather than by scrolling: the surface sits inside a scroll container that is
 * not the window, and moving the element is what the observer actually watches.
 */
async function pushOutOfView(surface: Locator): Promise<void> {
  await surface.evaluate((element) => {
    (element as HTMLElement).style.marginTop = "3000px";
  });
  await expect(surface).toHaveAttribute("data-lazy", "true", { timeout: 20_000 });
}

test("a frame granted playback keeps running out of view when the person chose it, and Stop suspends it", async ({ page }) => {
  test.setTimeout(120_000);
  const { surface, frame } = await openFrame(page, "widget phát");
  const clock = frame.locator("iframe").contentFrame().locator("[data-playback-ticks]");
  await expect(clock).toBeVisible({ timeout: 30_000 });

  // Host chrome offers the choice, off by default.
  const keep = surface.locator("[data-keep-playing]");
  await expect(keep).toHaveAttribute("aria-pressed", "false");
  await keep.click();
  await expect(keep).toHaveAttribute("aria-pressed", "true");

  await pushOutOfView(surface);
  // Still mounted, and the host says so, with a Stop the frame cannot draw or remove.
  const playing = page.locator("[data-offscreen-playing]");
  await expect(playing).toBeVisible();
  await expect(playing).toContainText("vẫn đang chạy ngoài màn hình");
  await expect(surface.locator("[data-live-waiting='offscreen']")).toHaveCount(0);
  await expect(frame).toHaveCount(1);
  // Running, not merely kept on the page: its clock keeps counting while it is out of view.
  const offscreenAt = Number(await clock.getAttribute("data-playback-ticks"));
  await expect.poll(async () => Number(await clock.getAttribute("data-playback-ticks")), { timeout: 10_000 }).toBeGreaterThan(offscreenAt + 5);

  await page.locator("[data-stop-offscreen-playing]").click();
  // Stopped is suspended: unmounted, the live view released, and the wait described.
  await expect(surface.locator("[data-widget-frame]")).toHaveCount(0, { timeout: 20_000 });
  await expect(surface.locator("[data-live-waiting='offscreen']")).toBeVisible();
  await expect(page.locator("[data-offscreen-playing]")).toHaveCount(0);
});

test("a frame under a profile without playback is suspended out of view, and is offered no choice", async ({ page }) => {
  test.setTimeout(120_000);
  const { surface } = await openFrame(page, "widget cách ly");
  await expect(surface.locator("[data-keep-playing]")).toHaveCount(0);

  await pushOutOfView(surface);
  await expect(surface.locator("[data-widget-frame]")).toHaveCount(0, { timeout: 20_000 });
  await expect(surface.locator("[data-live-waiting='offscreen']")).toBeVisible();
  await expect(page.locator("[data-offscreen-playing]")).toHaveCount(0);
});
