import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Autonomy, in a real browser.
 *
 * Two claims only a browser can settle. First, that a command the agent proposes *runs* under the default
 * policy, with no approval card anywhere in the conversation — the change this refactor exists for. Second,
 * that the screen which decides that policy shows what this node is actually set to, and that saving it
 * reaches the node. The command comes from the node's scripted fixture, so this stays account-free.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const EVIDENCE = join(process.cwd(), "plans", "reports", "evidence");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error("no local token in the e2e identity file");
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

test("a command runs without an approval card under the default policy", async ({ page }) => {
  await openApp(page);

  await page.locator("[data-composer]").fill("chạy lệnh tự động");
  await page.locator("[data-send]").click();

  // The receipt, and no card. These two assertions together are the whole change: the same command that used
  // to wait for a person now runs, and the evidence of it is in the transcript.
  const receipt = page.locator('[data-tool-name="run_command"]').first();
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  await expect(receipt).toContainText("fixture ran");
  await expect(page.locator('[data-host-card="approval"]')).toHaveCount(0);

  await page.screenshot({ path: join(EVIDENCE, "autonomy-01-guarded-run.png"), fullPage: true });
});

test("the Autonomy control lives in the Control tab, and saving it reaches the node", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-control").click();

  const panel = page.locator("#cc-tabpanel-control");
  await expect(panel).toBeVisible();
  /*
   * The default, read from the node rather than assumed by the panel: the segment the stored policy reads as is
   * the one that is pressed. A node that stored no policy runs Autonomous, and this panel spells Autonomous as
   * `auto` — so the pressed segment is `auto`, and the assertion says so instead of encoding the legacy default.
   */
  const policy = panel.locator('[data-segmented="autonomy-policy"]');
  await expect(policy.locator('[data-segment="auto"]')).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator('[data-toggle="autonomy-guardrails"] input[type="checkbox"]')).toBeChecked();
  // Reads are not guarded by default: a guardrail call on every read spends a provider call to decide nothing.
  await expect(panel.locator('[data-autonomy-class="reads"]')).not.toBeChecked();
  await page.screenshot({ path: join(EVIDENCE, "autonomy-02-settings.png"), fullPage: true });

  // Change it and put it back, so the node this suite shares with the other specs ends where it started.
  await policy.locator('[data-segment="confirm"]').click();
  await panel.locator("[data-autonomy-save]").click();
  await expect(panel).toContainText("Đã lưu", { timeout: 10_000 });

  // Back to the segment that means the default it started on, so the next spec in this suite sees one policy and
  // not a node left asking for every effect.
  await policy.locator('[data-segment="auto"]').click();
  await panel.locator("[data-autonomy-save]").click();
  await expect(panel).toContainText("Đã lưu", { timeout: 10_000 });
});
