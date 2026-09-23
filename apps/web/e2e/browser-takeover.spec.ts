import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Taking the wheel from the agent, and stopping the session.
 *
 * This is the one capability where the agent acts unsupervised, which makes it the one where "the agent is still
 * driving" has to be something the user can change. The claim worth a browser is not that a flag flips: it is that
 * the takeover takes effect on a process the node is not synchronously controlling. The mechanism is the lease
 * epoch — the agent's already-planned action is refused for having a stale lease — so the card is asserted to say
 * that, and the epoch is asserted to move, because those are the two things that make the browser the user's.
 *
 * The session is created in the node's own registry by the fixture, so the verbs act on something that exists. The
 * frame on the card is not the fixture's: it is the pack's own browser photographing the page the node serves, and
 * this spec checks the bytes rather than the presence of an element.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

test("a takeover changes who may act, and a stop ends the session", async ({ page }) => {
  const startedAt = Date.now();
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("mở browser giúp tôi");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='browser-session']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The agent is driving, at the epoch its plan was made under.
  await expect(card).toHaveAttribute("data-control-driver", "agent");
  await expect(card).toHaveAttribute("data-control-status", "running");
  await expect(card).toContainText("agent");

  /*
   * The captured frame, as a picture rather than a promise. A card that carried a digest but rendered nothing would
   * pass every assertion above while showing the person nothing at all — and the caption has to say when it was
   * taken, because a frame presented as the live screen is the one thing this surface must never do.
   */
  const frame = card.locator("[data-control-preview-frame='true']");
  await expect(frame).toHaveCount(1);
  const picture = frame.locator("img");
  await expect(picture).toBeVisible({ timeout: 20_000 });
  await expect(picture).toHaveAttribute("alt", /Ảnh chụp màn hình phiên/);
  await expect(frame.locator("figcaption")).toContainText("không phải màn hình trực tiếp");

  /*
   * That the frame is a browser's own capture and not a stored picture.
   *
   * Three checks, and each of them fails on bytes nobody rendered. The card names a digest; the bytes the node
   * serves under that digest hash to it, which is what makes the digest a reference to this picture rather than a
   * decoration on the card. The picture decodes to the size the frame was captured at, and a hand-written PNG
   * prefix does not decode at all — an `<img>` around one is present, has a box from its `alt` text, and is 0 by 0
   * as an image, which is exactly how the fixed bytes this journey used to end at passed for years of green runs.
   * And the moment on the card is a real instant inside this run rather than a constant: the label has to come from
   * the capture, not from whoever composed the card.
   */
  const digest = await frame.getAttribute("data-control-preview-digest");
  expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

  const served = await fetch(`${GATEWAY}/previews/${encodeURIComponent(digest ?? "")}`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  // Never cached: a cached frame is a stale screen presented as the current one.
  expect(served.headers.get("cache-control")).toBe("no-store");
  const bytes = new Uint8Array(await served.arrayBuffer());
  expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(digest);

  const decoded = await picture.evaluate((node) => {
    const image = node as HTMLImageElement;
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  const captured = {
    width: Number(await picture.getAttribute("width")),
    height: Number(await picture.getAttribute("height")),
  };
  expect(captured.width).toBeGreaterThan(0);
  expect(captured.height).toBeGreaterThan(0);
  expect(decoded).toEqual(captured);

  const caption = (await frame.locator("figcaption").innerText()).trim();
  const labelled = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(caption)?.[1];
  expect(labelled).toBeDefined();
  const takenAt = Date.parse(labelled ?? "");
  expect(takenAt).toBeGreaterThanOrEqual(startedAt - 1_000);
  expect(takenAt).toBeLessThanOrEqual(Date.now());

  const takeover = card.locator("[data-control-takeover]");
  await expect(takeover).toHaveCount(1);
  await takeover.click();

  /*
   * The two assertions that make this a takeover rather than a label change: the driver is the user, and the card
   * says the agent's earlier action was refused for a stale lease. Without the second, nothing here would show
   * that anything about the agent's ability to act had changed.
   */
  await expect(card).toHaveAttribute("data-control-driver", "user", { timeout: 20_000 });
  const notice = card.locator("[data-control-notice='taken-over']");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("bị từ chối");
  await expect(card).toHaveAttribute("data-control-epoch", "1");

  // Nothing offers a takeover the user already has: a control with nothing left to do is worse than no control.
  await expect(card.locator("[data-control-takeover]")).toHaveCount(0);

  // And the session stops when asked.
  const stop = card.locator("[data-control-stop]");
  await expect(stop).toHaveCount(1);
  await stop.click();

  await expect(card).toHaveAttribute("data-control-status", "stopped", { timeout: 20_000 });
  await expect(card.locator("[data-control-notice='stopped']")).toBeVisible();
  // A stopped session has no verbs left, so none are drawn.
  await expect(card.locator("[data-control-stop]")).toHaveCount(0);
  await expect(card.locator("[data-control-takeover]")).toHaveCount(0);
});
