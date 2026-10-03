import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { DEFAULT_EXECUTION_POLICY_CONFIG } from "@clarkcant/contracts";

/**
 * Installing a package listed by a path on this machine from the listing's own Install button, in a mode that installs
 * without asking first.
 *
 * The listing carries the digest the node computed over the package's files when it listed them, and the button sends it
 * back; the node digests the files again and installs them. The runtime's own tests cover the refusals (files changed since
 * the listing, a path that cannot be read); this covers what only a browser can: that the press installs.
 *
 * The node is shared by every spec in the run and keeps its preferences and packages, so the mode this spec sets is put
 * back afterwards and the package is uninstalled before and after, which also makes a retry start from the same state.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.example.theme-local";
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

async function installed(request: APIRequestContext): Promise<string[]> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: headers() })).json()) as {
    packages: { packageId: string; version: string }[];
  };
  return listed.packages.filter((entry) => entry.packageId === PACKAGE).map((entry) => entry.version);
}

async function uninstall(request: APIRequestContext): Promise<void> {
  if ((await installed(request)).length === 0) return;
  const removed = await request.post(`${GATEWAY}/packages/${encodeURIComponent(PACKAGE)}/uninstall`, { headers: headers() });
  expect(removed.ok(), `uninstall answered ${String(removed.status())}: ${await removed.text()}`).toBe(true);
}

let previousPolicy: Record<string, unknown> | undefined;

test.beforeEach(async ({ request }) => {
  await uninstall(request);
  previousPolicy = await storedPolicy(request);
  /*
   * The default mode, which installs without a question: the person asked for this package by pressing Install. Written
   * whole rather than derived from what is stored, so an attempt that dies before restoring leaves a retry, and the specs
   * after it, with nothing but a fresh node's own default.
   */
  await writePolicy(request, { ...DEFAULT_EXECUTION_POLICY_CONFIG });
});

test.afterEach(async ({ request }) => {
  if (previousPolicy !== undefined) await writePolicy(request, previousPolicy);
  await uninstall(request);
});

test("Install on a listing by a path on this machine installs it, without asking first", async ({ page, request }) => {
  expect(await installed(request)).toEqual([]);

  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("tìm gói trên máy");
  await composer.press("Enter");

  const listed = page.locator(`[data-marketplace-package='${PACKAGE}']`).last();
  await expect(listed).toBeVisible({ timeout: 20_000 });
  // The listing names the path the package is read from, which is what makes it a local one.
  await expect(listed.locator("[data-marketplace-source='true']")).toContainText("theme-local");

  const install = page.waitForRequest((sent) => sent.url().endsWith("/packages/install") && sent.method() === "POST");
  await listed.locator(`[data-install-package='${PACKAGE}']`).click();
  // What the button sent back is what the node read of the files when it listed them.
  const body = (await install).postDataJSON() as { packageId?: unknown; contentDigest?: unknown };
  expect(body.packageId).toBe(PACKAGE);
  expect(body.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

  const state = listed.locator("[data-install-state]");
  await expect(state).toHaveAttribute("data-install-state", "installed", { timeout: 20_000 });
  await expect(listed.locator("[data-install-open-inbox]")).toHaveCount(0);
  expect(await installed(request)).toEqual(["1.0.0"]);
});
