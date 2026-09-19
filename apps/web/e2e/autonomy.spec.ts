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

test("the Autonomy tab shows what this node is set to, and saving reaches the node", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-autonomy").click();

  const panel = page.locator("#cc-tabpanel-autonomy");
  await expect(panel).toBeVisible();
  const policy = panel.locator('[data-autonomy-policy="true"]');
  // The default, read from the node rather than assumed by the panel.
  await expect(policy).toHaveValue("guarded");
  await expect(panel.locator('[data-autonomy-guardrails="true"]')).toBeChecked();
  // Reads are not guarded by default: a guardrail call on every read spends a provider call to decide nothing.
  await expect(panel.locator('[data-autonomy-class="reads"]')).not.toBeChecked();
  await page.screenshot({ path: join(EVIDENCE, "autonomy-02-settings.png"), fullPage: true });

  // Change it and put it back, so the node this suite shares with the other specs ends where it started.
  await policy.selectOption("confirm");
  await panel.locator("[data-autonomy-save]").click();
  await expect(panel).toContainText("Đã lưu", { timeout: 10_000 });

  await policy.selectOption("guarded");
  await panel.locator("[data-autonomy-save]").click();
  await expect(panel).toContainText("Đã lưu", { timeout: 10_000 });
});
