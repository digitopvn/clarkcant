import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { DEFAULT_EXECUTION_POLICY_CONFIG } from "@clarkcant/contracts";

/**
 * Installing a package listed by a path on this machine from the listing's own Install button, in a mode that installs
 * without asking first.
 *
 * The listing carries the digest the node computed over the package's files when it listed them, and the button sends it
 * back; the node digests the files again and installs them. The runtime's own tests cover each refusal; this covers what
 * only a browser can: that the press installs, and that a row refused for files that changed since its list was made says
 * so, stops offering the same Install, and searches again.
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
/**
 * A file the stale-row test adds to the committed fixture after the list is made, so the node's own digest sees changed
 * files. Removed before and after every test, so an attempt that dies midway leaves neither the fixture nor a retry
 * changed. Only the directory's listing digest is pinned for the fixture, and a local install does not compare files with
 * it, so the addition changes nothing but the content digest.
 */
const CHANGED_FILE = join(process.cwd(), "apps", "web", "e2e", "fixtures", "theme-local", "changed-after-listing.txt");
/** The fixture's theme file, which the copy test edits after the install and puts back afterwards whatever happens. */
const THEME_FILE = join(process.cwd(), "apps", "web", "e2e", "fixtures", "theme-local", "themes", "harbor.json");
const THEME_BYTES = readFileSync(THEME_FILE);

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

/** Put the fixture back as committed: an attempt that died midway must not leave a retry, or another spec, edited files. */
function restoreFixture(): void {
  rmSync(CHANGED_FILE, { force: true });
  writeFileSync(THEME_FILE, THEME_BYTES);
}

test.beforeEach(async ({ request }) => {
  restoreFixture();
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
  restoreFixture();
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

test("an installed package runs from the copy the node made, so edits to its path change nothing until it is installed again", async ({
  page,
  request,
}) => {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("tìm gói trên máy");
  await composer.press("Enter");

  const listed = page.locator(`[data-marketplace-package='${PACKAGE}']`).last();
  await expect(listed).toBeVisible({ timeout: 20_000 });
  await listed.locator(`[data-install-package='${PACKAGE}']`).click();
  await expect(listed.locator("[data-install-state]")).toHaveAttribute("data-install-state", "installed", { timeout: 20_000 });

  const served = async (relativePath: string) =>
    request.get(`${GATEWAY}/packages/${encodeURIComponent(PACKAGE)}/1.0.0/files/${relativePath}`, { headers: headers() });
  const harborName = async (): Promise<string | undefined> => {
    const listedThemes = (await (await request.get(`${GATEWAY}/themes`, { headers: headers() })).json()) as {
      themes: { displayName: string; provider: { kind: string; packageId?: string } }[];
    };
    return listedThemes.themes.find((theme) => theme.provider.packageId === PACKAGE)?.displayName;
  };
  const original = THEME_BYTES.toString("utf8");
  expect(await (await served("themes/harbor.json")).text()).toBe(original);
  expect(await harborName()).toBe("Harbor");

  // The files on the path change after the install: one is edited and one is added.
  const edited = original.replace('"displayName": "Harbor"', '"displayName": "Harbor Edited"');
  expect(edited).not.toBe(original);
  writeFileSync(THEME_FILE, edited);
  writeFileSync(CHANGED_FILE, "added after the install\n");

  // What is served, and the theme the appearance offers, are the installed copy's.
  const after = await served("themes/harbor.json");
  expect(after.status()).toBe(200);
  expect(await after.text()).toBe(original);
  expect((await served("changed-after-listing.txt")).status()).toBe(404);
  expect(await harborName()).toBe("Harbor");

  // Installing again checks the files as they are now and runs them from a new copy.
  const reinstalled = await request.post(`${GATEWAY}/packages/install`, {
    headers: headers(),
    data: { packageId: PACKAGE, version: "1.0.0" },
  });
  expect(reinstalled.ok(), await reinstalled.text()).toBe(true);
  expect(await (await served("themes/harbor.json")).text()).toBe(edited);
  expect(await (await served("changed-after-listing.txt")).text()).toBe("added after the install\n");
  expect(await harborName()).toBe("Harbor Edited");
});

test("a row whose files changed after the list was made goes out of date, and its search again lists them anew", async ({
  page,
  request,
}) => {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("tìm gói trên máy");
  await composer.press("Enter");

  const rows = page.locator(`[data-marketplace-package='${PACKAGE}']`);
  const listed = rows.last();
  await expect(listed).toBeVisible({ timeout: 20_000 });
  const rowsBefore = await rows.count();

  // The files change after the list was made: one is added, and removed again after the test whatever happens.
  writeFileSync(CHANGED_FILE, "added after the list was made\n");
  const refused = page.waitForResponse((answer) => answer.url().endsWith("/packages/install"));
  await listed.locator(`[data-install-package='${PACKAGE}']`).click();
  expect((await refused).status()).toBe(409);

  // Out of date: Install stays disabled with the reason, and the way forward is the same search again.
  await expect(listed.locator("[data-install-state]")).toHaveAttribute("data-install-state", "stale", { timeout: 20_000 });
  await expect(listed.locator(`[data-install-package='${PACKAGE}']`)).toBeDisabled();
  expect(await installed(request)).toEqual([]);

  await listed.locator(`[data-marketplace-search-again='${PACKAGE}']`).click();
  await expect(rows).toHaveCount(rowsBefore + 1, { timeout: 20_000 });

  // The new list shows the files as they are now, so its row installs; the old one stays out of date.
  const relisted = rows.last();
  await expect(relisted.locator("[data-install-state]")).toHaveCount(0);
  await relisted.locator(`[data-install-package='${PACKAGE}']`).click();
  await expect(relisted.locator("[data-install-state]")).toHaveAttribute("data-install-state", "installed", { timeout: 20_000 });
  expect(await installed(request)).toEqual(["1.0.0"]);
});
