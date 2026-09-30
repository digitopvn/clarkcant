import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * An install the person's execution mode asks about, decided in the inbox.
 *
 * The runtime's own tests cover what the decision route refuses (a changed listing, a forged digest, an expired or
 * repeated decision, a machine surface); this covers what only a browser can: that pressing Install in the marketplace
 * under a mode that asks first says where the decision waits and leads there, that the inbox shows the package, the
 * version and what it asks for, and that Approve installs while Deny leaves what is installed as it was.
 *
 * The node is shared by every spec in the run and keeps its preferences, so the mode this spec sets is put back after
 * each test. Whether the package is already installed depends on which specs ran before, so each test compares what is
 * installed before and after rather than assuming a fresh node.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.acme.dashboard";
const POLICY_KEY = "execution.policy";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

const headers = () => ({ authorization: `Bearer ${token()}` });

async function storedPolicy(request: APIRequestContext): Promise<Record<string, unknown>> {
  const listed = (await (await request.get(`${GATEWAY}/preferences`, { headers: headers() })).json()) as {
    preferences: { key: string; value: unknown }[];
  };
  const policy = listed.preferences.find((entry) => entry.key === POLICY_KEY)?.value;
  if (typeof policy !== "object" || policy === null) throw new Error("the node reports no execution policy");
  return policy as Record<string, unknown>;
}

async function writePolicy(request: APIRequestContext, value: Record<string, unknown>): Promise<void> {
  const written = await request.put(`${GATEWAY}/preferences/${POLICY_KEY}`, { headers: headers(), data: { value } });
  expect(written.ok(), await written.text()).toBe(true);
}

/** The active generation of the package, as the node lists it: its version and when it became active. */
async function installed(request: APIRequestContext): Promise<string[]> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: headers() })).json()) as {
    packages: { packageId: string; version: string; activatedAt: string }[];
  };
  return listed.packages.filter((entry) => entry.packageId === PACKAGE).map((entry) => `${entry.version}@${entry.activatedAt}`);
}

let previousPolicy: Record<string, unknown> | undefined;

test.beforeEach(async ({ request }) => {
  previousPolicy = await storedPolicy(request);
  // Asks before anything is written locally, which is the category an install is decided in.
  await writePolicy(request, { ...previousPolicy, rules: [{ effectCategory: "local-write", decision: "ask" }] });
});

test.afterEach(async ({ request }) => {
  if (previousPolicy !== undefined) await writePolicy(request, previousPolicy);
});

/** Press Install on the listing and follow the chip to the inbox item it waits as. */
async function askFromMarketplace(page: Page): Promise<{ approvalId: string }> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("tìm gói");
  await composer.press("Enter");

  const listed = page.locator(`[data-marketplace-package='${PACKAGE}']`).last();
  await expect(listed).toBeVisible({ timeout: 20_000 });
  await listed.locator("[data-install-package]").click();

  // Where the decision waits is said beside the button, and nothing claims it was installed.
  const waitingState = listed.locator("[data-install-state='approval-required']");
  await expect(waitingState).toBeVisible({ timeout: 20_000 });
  await expect(waitingState).toContainText("Hộp thư");
  await expect(waitingState).toContainText("chưa cài gì");
  const chip = listed.locator("[data-install-open-inbox]");
  const approvalId = await chip.getAttribute("data-install-open-inbox");
  if (approvalId === null || approvalId === "") throw new Error("the waiting install names no approval");

  await chip.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('[data-inbox-panel="ready"]')).toBeVisible({ timeout: 20_000 });
  const item = dialog.locator(`[data-inbox-waiting-key="install-approval:${approvalId}"]`);
  await expect(item).toBeVisible();
  // The chip leads to this item, not merely to the inbox.
  await expect(item).toHaveAttribute("data-inbox-target", "true");
  await expect(item).toContainText("Cài Dashboard 1.0.0?");
  await expect(item.locator("[data-inbox-install-permissions]")).toContainText("Không xin quyền nào");
  return { approvalId };
}

test("Deny leaves what is installed as it was", async ({ page, request }) => {
  const before = await installed(request);
  const { approvalId } = await askFromMarketplace(page);
  const dialog = page.getByRole("dialog");

  await dialog.locator(`[data-inbox-deny="${approvalId}"]`).click();
  const status = dialog.locator('[data-inbox-status="done"]');
  await expect(status).toContainText("Đã từ chối", { timeout: 20_000 });
  await expect(status).toContainText("Dashboard 1.0.0");
  await expect(dialog.locator(`[data-inbox-waiting-key="install-approval:${approvalId}"]`)).toHaveCount(0);
  expect(await installed(request)).toEqual(before);
});

test("Approve installs exactly the version that was asked about", async ({ page, request }) => {
  const before = await installed(request);
  const { approvalId } = await askFromMarketplace(page);
  const dialog = page.getByRole("dialog");

  await dialog.locator(`[data-inbox-install-approve="${approvalId}"]`).click();
  const status = dialog.locator('[data-inbox-status="done"]');
  await expect(status).toContainText("Đã cài Dashboard 1.0.0", { timeout: 30_000 });
  await expect(dialog.locator(`[data-inbox-waiting-key="install-approval:${approvalId}"]`)).toHaveCount(0);
  const after = await installed(request);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatch(/^1\.0\.0@/);
  expect(after).not.toEqual(before);
});
