import { join } from "node:path";

import { type AutomationAction, observationIdSchema } from "@clarkcant/contracts";
import { createDriver } from "@clarkcant/browser-playwright";

import { type SessionPreviewCaptureOutcome, captureSessionPreview } from "../session-preview.ts";

/**
 * The frame a scripted browser session shows, captured from a real browser.
 *
 * This is the one place the scripted composition opens a browser, and what it opens is not a stand-in: the pack's
 * own driver, Chromium underneath it, a real page over HTTP, and the bytes the driver really took. Everything
 * downstream is production code — `captureSessionPreview` stores them, the node serves them from
 * `/previews/<digest>`, and the card renders what came back.
 *
 * What is scripted is only the decision. A real node would reach this point because a model chose to open a page;
 * with no provider account the composer decides instead, and a fixed PNG used to stand in for the picture. That
 * fixture proved the wiring and could never prove a browser rendered anything: a truncated PNG decodes to no
 * picture at all, so a journey that asserted an `<img>` was present passed on bytes no browser would draw. The
 * frame is now taken the way the product takes it.
 *
 * The page is the app itself. A takeover card is about the screen somebody is watching, and the app the user is
 * looking at is the honest thing to photograph; `CC_APP_ORIGIN` is where the suite already tells the node that
 * app is served from. Without it there is no page to capture, which is reported rather than papered over with a
 * blank frame: a white rectangle labelled "captured at" would be a picture of nothing presented as the screen.
 *
 * The browser is closed once the frame is taken. The fixture owns no session lifetime — the preview is the whole
 * of what it needed a browser for — and a Chromium left running after a test run is a process nobody will clean up.
 */
export async function captureBrowserFrame(input: {
  dataDir: string;
  nodeId: string;
  pageUrl: string;
}): Promise<SessionPreviewCaptureOutcome> {
  let origin: string;
  try {
    origin = new URL(input.pageUrl).origin;
  } catch {
    return { ok: false, code: "CAPTURE_FAILED", message: `${input.pageUrl} is not a page a browser can open` };
  }

  const created = createDriver({
    profileName: "preview",
    nodeId: input.nodeId,
    allowedOrigins: [origin],
    profileDir: join(input.dataDir, "browser-profiles", "preview"),
  });
  if (!created.ok) {
    return { ok: false, code: "CAPTURE_FAILED", message: created.refused };
  }
  const { driver } = created;

  try {
    /*
     * The navigation goes through `act`, not through a shortcut on the driver, because the origin rule has to
     * apply here exactly as it applies to the agent: the page a preview is taken of must be one the profile
     * declared, and a fixture that bypassed that check would be photographing a page the product would refuse.
     */
    const navigation: AutomationAction = {
      actionId: "act_preview_navigate",
      targetId: driver.target.targetId,
      // A navigation is planned against the document it replaces, so this reference is the one the driver would
      // have stamped had it observed first. The driver does not consult it for a navigation, and saying otherwise
      // would be inventing an observation.
      observationId: observationIdSchema.parse("obs_preview_navigation"),
      leaseEpoch: driver.leaseEpoch,
      operation: "navigate",
      arguments: { url: input.pageUrl },
      expectedTargetVersion: driver.targetVersion,
      consequential: false,
    };
    const navigated = await driver.act(navigation, { approvalGranted: true });
    if (navigated.status !== "applied") {
      return {
        ok: false,
        code: "CAPTURE_FAILED",
        message: `the page could not be opened: ${navigated.message}`,
      };
    }
    return await captureSessionPreview({ dataDir: input.dataDir, driver });
  } finally {
    await driver.close();
  }
}

/** Where the page a preview is taken of is served from, as the node was told at startup. */
export function previewPageUrl(env: Record<string, string | undefined>): string | undefined {
  const origin = env["CC_APP_ORIGIN"];
  return origin === undefined || origin.trim() === "" ? undefined : origin;
}
