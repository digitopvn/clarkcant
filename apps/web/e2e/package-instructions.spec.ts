import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";

/**
 * A package's instructions, turned off from Settings, in a real browser.
 *
 * The node's side — who may turn a package's instructions on, the card, the audit, uninstall forgetting the projects — is
 * `apps/runtime/test/package-instructions.spec.ts`. What only a page can show is the journey: a project the package's
 * rules are on for is listed under the package in the Extensions tab, the Turn off button there removes exactly that
 * entry, and the next turn is given no snippet from the package. The turn is the production model turn with a provider
 * that repeats its prompt, so the reply shows what a model would have been told.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

const PACKAGE = "com.example.project-rules";
/** The digest of `fixtures/instructions-package`, as `fixtures/directory.json` lists it (a unit test keeps the two in step). */
const PACKAGE_DIGEST = "sha256:ed9a45c0a2a718967e8345566d2fb8bc6289189552c94ce09c32f17ada72f4f8";
const SNIPPET = "Quy tắc gói mẫu: đặt tên hàm bằng động từ.";
const QUESTION = "hướng dẫn nào đang áp dụng";
/** The fixture node's own `demo-app`, written into its data directory at boot, inside the root it was granted. */
const DEMO = join(DATA_DIR, "workspace", "demo-app");

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("the node's identity file has no local token");
  return parsed.localToken;
}

const headers = (): Record<string, string> => ({ authorization: `Bearer ${token()}` });

async function install(request: APIRequestContext): Promise<void> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: headers() })).json()) as { packages: { packageId: string }[] };
  if (listed.packages.some((entry) => entry.packageId === PACKAGE)) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers: headers(),
    data: { packageId: PACKAGE, version: "1.0.0", localDigest: PACKAGE_DIGEST },
  });
  expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
}

async function preference(request: APIRequestContext, key: string): Promise<unknown> {
  const body = (await (await request.get(`${GATEWAY}/preferences`, { headers: headers() })).json()) as {
    preferences: { key: string; value: unknown }[];
  };
  return body.preferences.find((entry) => entry.key === key)?.value;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

/** A value written inside a quoted CSS attribute selector: a Windows path's backslashes are escapes there. */
const quoted = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function nextMessage(page: Page): Promise<Request> {
  return page.waitForRequest((request) => request.method() === "POST" && /\/messages(\/stream)?$/u.test(request.url()));
}

/**
 * Asks in a new conversation through the gateway, as the composer would, and answers the timeline once the turn has run.
 * The same request before and after Turn off, so the only thing that differs between the two turns is the pair.
 */
async function askInNewConversation(request: APIRequestContext, title: string, message: { text: string; references?: unknown }): Promise<string> {
  const created = await request.post(`${GATEWAY}/conversations`, { headers: headers(), data: { title } });
  expect(created.ok()).toBe(true);
  const conversationId = ((await created.json()) as { conversationId: string }).conversationId;
  const asked = await request.post(`${GATEWAY}/conversations/${encodeURIComponent(conversationId)}/messages`, {
    headers: headers(),
    data: { text: message.text, references: message.references },
  });
  expect(asked.ok(), `send answered ${String(asked.status())}: ${await asked.text()}`).toBe(true);
  let timeline = "";
  await expect
    .poll(
      async () => {
        const response = await request.get(`${GATEWAY}/conversations/${encodeURIComponent(conversationId)}/timeline?after=0`, { headers: headers() });
        timeline = JSON.stringify(await response.json());
        return timeline.includes("scripted reply to:");
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return timeline;
}

// The package leaves with the test, so a later spec on this node finds the directory as the fixtures list it.
test.afterEach(async ({ request }) => {
  const uninstalled = await request.post(`${GATEWAY}/packages/${PACKAGE}/uninstall`, { headers: headers() });
  expect([200, 404], `uninstall answered ${String(uninstalled.status())}: ${await uninstalled.text()}`).toContain(uninstalled.status());
});

test("Turn off in Settings removes the project's entry, and the next turn is given no snippet from the package", async ({ page, request }) => {
  await install(request);
  const project = DEMO;
  // Turned on through the person-only preference route the harness may use, as the Settings write would.
  const enabled = await request.put(`${GATEWAY}/preferences/instructions.packages`, {
    headers: headers(),
    data: { value: [{ project, packageId: PACKAGE }] },
  });
  expect(enabled.ok(), `enable answered ${String(enabled.status())}: ${await enabled.text()}`).toBe(true);

  // While it is on, a turn about a source file in the project is given the package's snippet.
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await page.keyboard.type(`${QUESTION} @demo-app/src/app.t`);
  await expect(page.locator('[data-reference-option="demo-app/src/app.ts"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue(`${QUESTION} @demo-app/src/app.ts `);
  const sent = nextMessage(page);
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { text: string; references?: unknown };
  const reply = page.locator('.cc-row[data-role="assistant"]').last();
  await expect(reply).toContainText(SNIPPET, { timeout: 20_000 });
  await expect(reply).toContainText(PACKAGE);
  // The same request the check after Turn off sends is given the snippet while the pair is on: a positive control.
  const before = await askInNewConversation(request, "Hướng dẫn khi đang bật", body);
  expect(before).toContain(SNIPPET);
  expect(before).toContain(PACKAGE);

  // Settings lists the project under the package, with a button that names both.
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-extensions")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-extensions").click();
  const row = page.locator(`[data-installed-package="${PACKAGE}"]`);
  await expect(row.locator(`[data-package-instructions-project="${quoted(project)}"]`)).toBeVisible({ timeout: 20_000 });
  const off = row.locator(`[data-package-instructions-off="${quoted(project)}"]`);
  await expect(off).toHaveAccessibleName(new RegExp(PACKAGE.replace(/\./g, "\\.")));

  await off.click();
  await expect(row.locator("[data-package-instructions]")).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => JSON.stringify((await preference(request, "instructions.packages")) ?? []), { timeout: 10_000 }).toBe("[]");

  // A new conversation's turn about the same file is a turn that would state the snippet if it were still on.
  const timeline = await askInNewConversation(request, "Hướng dẫn sau khi tắt", body);
  // The turn ran, and was told nothing of the package.
  expect(timeline).not.toContain(SNIPPET);
  expect(timeline).not.toContain(PACKAGE);
});
