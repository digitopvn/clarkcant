import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The empty state.
 *
 * Two claims are worth a browser for. The first is that the four chips are really there and say
 * whether they need a model — a chip that quietly does nothing is worse than a missing one, because
 * the user concludes the app is broken rather than that something is not configured. The second is
 * that pressing one actually sends a message and the empty state goes away; a chip that fills the
 * composer and stops would look identical in a screenshot.
 */

const EVIDENCE = join(process.cwd(), "plans", "reports", "evidence");
const DATA_DIR = join(process.cwd(), ".data", "e2e");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`the node did not write its identity to ${path}`, { cause });
  }
  const parsed = JSON.parse(raw) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  // The node's own suggestions are pinned to empty, so the four written chips are the ones on screen.
  //
  // This suite is about those four chips and what they promise. Once the node can offer suggestions drawn from
  // what a person was actually doing, which chips appear depends on what happens to be in .data/e2e - so a test
  // asserting four would be asserting the database. The dynamic list has its own journey.
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

test("the empty state offers four chips and says which need a model", async ({ page }) => {
  await openApp(page);

  const chips = page.locator("[data-suggestion]");
  await expect(chips).toHaveCount(4);

  // Every chip states whether it needs a model. The detail is visible text, not a tooltip, because
  // the question it answers is asked before the click rather than after. Read from the inner span:
  // the attribute sits on the button, so its text content includes the label as well.
  const details = await page.locator(".cc-chip-detail").allTextContents();
  expect(details).toHaveLength(4);
  for (const detail of details) {
    expect(["chạy trên dữ liệu mẫu", "cần model"]).toContain(detail);
  }
  // Exactly one chip needs a model; if they all did, the three scripted ones would be lying about
  // working on this node, and if none did the fourth would be lying about needing a provider.
  expect(details.filter((detail) => detail === "cần model")).toHaveLength(1);
});

test("a chip sends a real message and the empty state goes away", async ({ page }) => {
  await openApp(page);
  await expect(page.locator(".cc-empty")).toBeVisible();

  // The first chip reaches a scripted recipe, so this holds without a provider account.
  await page.locator("[data-suggestion='cho tui xem biểu đồ']").click();

  // Gone, not merely scrolled past: the timeline replaced it.
  await expect(page.locator(".cc-empty")).toHaveCount(0);
  await expect(page.locator(".cc-timeline")).toBeVisible({ timeout: 20_000 });

  // And the node answered rather than the client rendering an optimistic echo.
  await expect(page.locator("text=dữ liệu mẫu").first()).toBeVisible({ timeout: 20_000 });
});

test.describe("the first run", () => {
  // The state every other spec starts with, cleared here: this screen exists for somebody who has not seen it, and a
  // suite that marked everybody as already onboarded would never look at it at all.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("shows the name, the tagline and one way in, and does not come back", async ({ page }) => {
    // Its own navigation rather than the shared helper: that one waits for the connection status in the header, and this
    // screen deliberately has no header - which is exactly what made the first version of this test fail, and the
    // failure looked like the screen not rendering.
    await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);

    await expect(page.locator("[data-onboarding='true']")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-onboarding='true'] h1")).toHaveText("ClarkCant");
    await expect(page.locator("[data-onboarding='true'] p")).toContainText("Clark Cant Can");

    // A node whose environment already answers goes straight in. The provider, the model and the key were configured
    // before the browser opened, and asking again would be asking somebody to retype a key this machine already holds.
    await page.locator("[data-onboarding-start='true']").click();
    await expect(page.locator("[data-onboarding='true']")).toHaveCount(0);

    // And it stays gone: a screen somebody has dismissed is dismissed, not shown again on the next load.
    await page.reload();
    await expect(page.locator("[data-onboarding='true']")).toHaveCount(0);
  });
});

test.describe("the first run on a node that has been told nothing", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("walks the steps it still needs, in order, and never echoes the key", async ({ page }) => {
    // Answered here rather than by starting a second node: what an answer says is the thing under test, not where the
    // answer came from, and this suite's node has a filled-in environment by design.
    await page.route("**/readiness", (route) => route.fulfill({ json: { model: false, credentials: [] } }));
    await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
    await expect(page.locator("[data-onboarding='true']")).toBeVisible({ timeout: 20_000 });

    await page.locator("[data-onboarding-start='true']").click();
    await expect(page.locator("[data-onboarding-step='provider']")).toBeVisible();

    // Wait for the step to settle before branching: the catalogue is read from the node, so a count taken the instant the
    // step appears sees zero and would take the wrong branch.
    await page.locator("[data-onboarding-provider], [data-onboarding-none='true']").first().waitFor({ timeout: 20_000 });

    const provider = page.locator("[data-onboarding-provider]").first();
    if ((await provider.count()) > 0) {
      await provider.click();
      await expect(page.locator("[data-onboarding-step='model']")).toBeVisible();
      await page.locator("[data-onboarding-model-select]").selectOption({ index: 1 });
      await page.locator("[data-onboarding-continue='true']").click();
    } else {
      await expect(page.locator("[data-onboarding-none='true']")).toBeVisible();
      await page.locator("[data-onboarding-finish='true']").click();
    }

    // The key, which is skippable and never echoed back.
    await expect(page.locator("[data-onboarding-key='typesafe']")).toBeVisible();
    const secret = "not-a-real-typesafe-key";
    await page.locator("[data-onboarding-key-input='true']").fill(secret);
    await expect(page.locator("[data-onboarding-key-input='true']")).toHaveValue(secret);
    // Skipped rather than saved: this suite shares one node, so a credential written here changes what a later spec
    // sees. The save path is covered by secret-input.spec.ts through the same client method and the same route.
    await page.locator("[data-onboarding-finish='true']").click();

    await expect(page.locator("[data-onboarding='true']")).toHaveCount(0);
    // The value must not appear anywhere on the page: a secret echoed into a surface is a secret in a screenshot.
    await expect(page.locator(`text=${secret}`)).toHaveCount(0);
  });
});

test.describe("the first run carries the orb", () => {
  // The same cleared state the other first-run tests use, for the same reason: without it this test opens the app
  // and then reports that the first-run screen has no orb, which is true and tells you nothing.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the first run carries the same orb, drawn into the space it reserves", async ({ page }) => {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);

    const canvas = page.locator("[data-onboarding='true'] canvas").first();
    await expect(canvas).toBeVisible({ timeout: 20_000 });

    // Measured rather than assumed. The canvas is drawn far larger than the box it sits in - 960 across in a 720px
    // stage - so being in the markup says nothing about being where somebody can see it, and that gap is exactly what
    // hid an off-centre orb until it was measured.
    await page.screenshot({ path: join(EVIDENCE, "first-run.png") });

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const anchor = document.querySelector("[data-onboarding='true'] .cc-hero-orb") as HTMLElement | null;
            const drawn = document.querySelector("[data-onboarding='true'] canvas") as HTMLElement | null;
            if (anchor === null || drawn === null) return 999;
            const box = anchor.getBoundingClientRect();
            const orb = drawn.getBoundingClientRect();
            return Math.max(
              Math.abs(box.left + box.width / 2 - (orb.left + orb.width / 2)),
              Math.abs(box.top + box.height / 2 - (orb.top + orb.height / 2)),
            );
          }),
        { timeout: 20_000 },
      )
      .toBeLessThan(4);
  });
});

test.describe("the first run is not covered by its own orb", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("what is on top at the point somebody aims at is the control, not the orb", async ({ page }) => {
    await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
    await expect(page.locator("[data-onboarding='true'] canvas").first()).toBeVisible({ timeout: 20_000 });

    // Measured at the point a person aims at rather than read off the markup. The orb is positioned and the first-run
    // content is not, and a positioned box paints above a static one whatever the order in the document - which is how
    // an orb drawn as a backdrop ended up over the name and the button.
    const covering = await page.evaluate(() => {
      const wanted = ["h1", "p", "[data-onboarding-start='true']"];
      const covered: string[] = [];
      for (const selector of wanted) {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) continue;
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        // The canvas is the orb. Anything else being on top would be a different kind of wrong.
        if (hit === null || hit.tagName.toLowerCase() === "canvas") covered.push(selector);
      }
      return covered.join(",");
    });
    // The heading and the paragraph matter as much as the button: they were behind the ball, which is what "the orb is
    // covering the interface" means when nothing is actually unclickable.
    expect(covering).toBe("");
  });
});

