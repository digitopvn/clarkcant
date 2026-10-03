import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * An update that reaches more than the installed version says so before it is applied.
 *
 * The forecast package is installed at 1.0.0 from the fixture npm registry, and the directory lists 1.1.0, whose service
 * reaches one origin the installed version does not. The update notice shows that origin before Update is pressed, and
 * under a mode that asks first the install question the press raises shows it too. Denying leaves 1.0.0 as it was. The
 * policy decides as it does for any install; what this asserts is what the person is shown before deciding.
 *
 * The node is shared by every spec in the run, so the mode is put back and the package uninstalled afterwards.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.acme.forecast";
const ADDED_ORIGIN = "https://forecast.example.com";
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

async function installedVersions(request: APIRequestContext): Promise<string[]> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: headers() })).json()) as {
    packages: { packageId: string; version: string }[];
  };
  return listed.packages.filter((entry) => entry.packageId === PACKAGE).map((entry) => entry.version);
}

let previousPolicy: Record<string, unknown> | undefined;

test.beforeEach(async ({ request }) => {
  previousPolicy = await storedPolicy(request);
});

test.afterEach(async ({ request }) => {
  if (previousPolicy !== undefined) await writePolicy(request, previousPolicy);
  // Leave the shared node as other specs expect it: the forecast package not installed, and no notice about it.
  if ((await installedVersions(request)).length > 0) {
    await request.post(`${GATEWAY}/packages/${PACKAGE}/uninstall`, { headers: headers(), data: {} });
  }
  const inbox = (await (await request.get(`${GATEWAY}/inbox`, { headers: headers() })).json()) as {
    notices: { noticeId: string; subject?: { kind: string; packageId?: string } }[];
  };
  for (const notice of inbox.notices.filter((item) => item.subject?.kind === "package" && item.subject.packageId === PACKAGE)) {
    await request.post(`${GATEWAY}/inbox/notices/${encodeURIComponent(notice.noticeId)}/actions/dismiss`, { headers: headers(), data: {} });
  }
});

test("the update notice and the install question show the origin 1.1.0 adds, before anything is applied", async ({ page, request }) => {
  // The installed version, from the fixture npm registry, in the mode this node starts in.
  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers: headers(),
    data: { packageId: PACKAGE, version: "1.0.0" },
  });
  expect(installed.status(), await installed.text()).toBe(200);
  expect(await installedVersions(request)).toEqual(["1.0.0"]);

  // The check the node runs every few hours, run now: the directory lists 1.1.0.
  const checked = await request.post(`${GATEWAY}/update-check-fixture/run`, { headers: headers(), data: {} });
  expect(checked.status(), await checked.text()).toBe(200);
  expect(((await checked.json()) as { packageUpdates: number }).packageUpdates).toBeGreaterThanOrEqual(1);

  // A mode that asks before anything is written locally, which is the category an install is decided in.
  if (previousPolicy === undefined) throw new Error("no policy was read");
  await writePolicy(request, { ...previousPolicy, rules: [{ effectCategory: "local-write", decision: "ask" }] });

  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('[data-inbox-panel="ready"]')).toBeVisible({ timeout: 20_000 });

  // The notice says what 1.1.0 reaches that 1.0.0 does not, before Update is pressed.
  const notice = dialog.locator("[data-inbox-notice]").filter({ hasText: PACKAGE });
  await expect(notice).toHaveCount(1);
  const change = notice.locator('[data-reach-change="wider"]');
  await expect(change).toBeVisible();
  await expect(change.locator(`[data-reach-added-origin="${ADDED_ORIGIN}"]`)).toContainText(ADDED_ORIGIN);
  await expect(change.locator(`[data-reach-added-origin="${ADDED_ORIGIN}"]`)).toContainText("Reads the forecast for the week you look at.");
  expect(await installedVersions(request)).toEqual(["1.0.0"]);

  // Update raises the install question the mode asks, and it shows the same added origin.
  const noticeId = await notice.getAttribute("data-inbox-notice");
  await notice.locator(`[data-inbox-update="${noticeId ?? ""}"]`).click();
  const question = dialog.locator('[data-inbox-waiting-item="install-approval"]').filter({ hasText: "1.1.0" });
  await expect(question).toBeVisible({ timeout: 20_000 });
  await expect(question.locator('[data-reach-change="wider"]')).toBeVisible();
  await expect(question.locator(`[data-reach-added-origin="${ADDED_ORIGIN}"]`)).toContainText(ADDED_ORIGIN);
  expect(await installedVersions(request)).toEqual(["1.0.0"]);

  // Denying leaves the installed version as it was.
  await question.locator("[data-inbox-deny]").click();
  await expect(dialog.locator('[data-inbox-status="done"]')).toContainText("1.1.0", { timeout: 20_000 });
  expect(await installedVersions(request)).toEqual(["1.0.0"]);
});
