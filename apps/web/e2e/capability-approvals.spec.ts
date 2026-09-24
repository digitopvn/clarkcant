import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Answering a package's capability question, in Settings.
 *
 * What the node grants, refuses and records is covered against a real node in
 * `apps/runtime/test/package-install-capability-approval.spec.ts`. The browser claims are the host-owned part: the
 * question is shown in Settings with the package it is for, the answer is sent with exactly the digest the row
 * showed, the outcome is announced where focus lands, and a refusal says nothing was granted.
 *
 * The node's answers are stubbed here because producing a pending question needs a package that requests a
 * capability under a policy that asks, and the suite's fixture node has neither; the route under the stub is the
 * one the runtime spec exercises.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

const APPROVAL = {
  approvalId: "appr_calendar",
  ref: "calendar.read@1",
  packageId: "com.example.planner",
  version: "1.2.0",
  operationDigest: "sha256:planner:calendar.read@1",
  description: "cấp quyền calendar.read@1 cho Planner 1.2.0",
  requestedAt: "2026-09-24T06:00:00.000Z",
  expiresAt: "2026-09-24T06:15:00.000Z",
};

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function openExtensions(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-extensions")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-extensions").click();
}

/** A node with one open question until it is answered, recording what the answer carried. */
async function stubOneQuestion(page: Page, answer: { status: number; body: Record<string, unknown> }): Promise<{ sent: unknown[] }> {
  const sent: unknown[] = [];
  let open = true;
  await page.route("**/packages/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ approvals: open ? [APPROVAL] : [] }) }),
  );
  await page.route(`**/packages/approvals/${APPROVAL.approvalId}/decision`, (route) => {
    sent.push(route.request().postDataJSON());
    if (answer.status === 200) open = false;
    return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  return { sent };
}

test("nothing is shown when there is nothing to decide", async ({ page }) => {
  await openExtensions(page);
  await expect(page.locator("section", { hasText: "Đã cài trên node này" }).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-capability-approvals]")).toHaveCount(0);
});

test("a question is answered with the digest it was shown under, and the outcome takes focus", async ({ page }) => {
  const node = await stubOneQuestion(page, {
    status: 200,
    body: { decision: "granted", ref: APPROVAL.ref, alreadyDecided: false },
  });
  await openExtensions(page);

  const row = page.locator(`[data-capability-approval='${APPROVAL.approvalId}']`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText(APPROVAL.ref);
  await expect(row).toContainText(`${APPROVAL.packageId}@${APPROVAL.version}`);

  // Keyboard only.
  await row.locator("[data-capability-grant]").focus();
  await page.keyboard.press("Enter");

  const status = page.locator("[data-capability-status]");
  await expect(status).toHaveAttribute("data-capability-status", "done");
  await expect(status).toContainText("Đã cho phép calendar.read@1");
  await expect(status).toBeFocused();
  await expect(row).toHaveCount(0);
  expect(node.sent).toEqual([{ decision: "granted", digest: APPROVAL.operationDigest }]);
});

test("a refused answer says nothing was granted and keeps the question", async ({ page }) => {
  await stubOneQuestion(page, {
    status: 409,
    body: { code: "APPROVAL_EXPIRED", message: "approval expired" },
  });
  await openExtensions(page);

  const row = page.locator(`[data-capability-approval='${APPROVAL.approvalId}']`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-capability-deny]").click();

  const status = page.locator("[data-capability-status]");
  await expect(status).toHaveAttribute("data-capability-status", "failed");
  await expect(status).toContainText("Không có quyền nào được cấp");
  await expect(row).toBeVisible();
});
