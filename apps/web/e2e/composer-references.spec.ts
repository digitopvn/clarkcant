import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";

/**
 * Naming a skill with `/` and a project or file with `@`, in a real browser.
 *
 * The picker, the keys and the pointer, the chips, the send, the timeline, and a reference that went stale between
 * choosing it and sending it. The node's side — what a reference is checked against and what the turn is told — is
 * `apps/runtime/test/composer-references.spec.ts`; here the fixture model repeats the brief it was given, so the
 * reply shows that the chosen skill's instructions reached the turn without claiming anything about a provider.
 *
 * The project is the fixture node's own `demo-app`, written into its data directory at boot (`arrangeModelNode`), so
 * nothing here depends on the folders of the machine running the suite.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const DEMO = join(DATA_DIR, "workspace", "demo-app");
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
    throw new Error("the node's identity file has no local token");
  }
  return parsed.localToken;
}

/** Open the app against the node this run started. The token is never logged or screenshotted. */
async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
}

function authorized(): { authorization: string } {
  return { authorization: `Bearer ${token()}` };
}

function composer(page: Page) {
  return page.locator("[data-composer]");
}

function picker(page: Page) {
  return page.locator("[data-reference-picker]");
}

function option(page: Page, label: string) {
  return page.locator(`[data-reference-option="${label}"]`);
}

/** The body of the next message the page sends, read from the request itself. */
function nextMessage(page: Page): Promise<Request> {
  return page.waitForRequest((request) => request.method() === "POST" && /\/messages(\/stream)?$/u.test(request.url()));
}

test("a skill chosen after a slash with the keyboard is sent, shown and briefed to the turn", async ({ page }) => {
  await openApp(page);
  await composer(page).click();
  await page.keyboard.type("/rev");

  await expect(picker(page)).toBeVisible();
  await expect(option(page, "review")).toBeVisible();
  // The field drives the list: focus never leaves what the person is typing into.
  await expect(composer(page)).toHaveAttribute("role", "combobox");
  await expect(composer(page)).toHaveAttribute("aria-expanded", "true");
  const active = await composer(page).getAttribute("aria-activedescendant");
  expect(active).not.toBeNull();
  await expect(page.locator(`#${active ?? ""}`)).toHaveAttribute("data-reference-option", "review");

  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE, "composer-references-01-slash.png") });

  await page.keyboard.press("Enter");
  await expect(composer(page)).toHaveValue("/review ");
  await expect(picker(page)).toHaveCount(0);
  await expect(page.locator('[data-reference-chip="review"]')).toBeVisible();

  await page.keyboard.type("xem giúp thay đổi này");
  const sent = nextMessage(page);
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { text: string; references?: { version: number; items: { kind: string; skillId?: string }[] } };
  expect(body.text).toBe("/review xem giúp thay đổi này");
  expect(body.references?.version).toBe(1);
  expect(body.references?.items).toEqual([expect.objectContaining({ kind: "skill", skillId: "review", label: "review" })]);

  const userRow = page.locator('.cc-row[data-role="user"]').last();
  await expect(userRow.locator('[data-reference-block="review"]')).toContainText("/review");
  const reply = page.locator('.cc-row[data-role="assistant"]').last();
  await expect(reply).toContainText("Fixture: lượt này được đưa phần tham chiếu sau.");
  await expect(reply).toContainText('<skill name="review">');
  await expect(reply).toContainText("Tham chiếu là con trỏ, không phải quyền");
  // The message was sent: its chip went with it.
  await expect(page.locator("[data-reference-chips]")).toHaveCount(0);
});

test("a file inside a project is reached by opening folders with Tab and sent with Enter", async ({ page }) => {
  await openApp(page);
  await composer(page).click();
  await page.keyboard.type("đọc @demo");
  await expect(option(page, "demo-app")).toBeVisible();
  await expect(option(page, "demo-app")).toHaveAttribute("data-reference-kind", "project");

  await page.keyboard.press("Tab");
  await expect(composer(page)).toHaveValue("đọc @demo-app/");
  // One directory, folders first.
  const rows = page.locator("[data-reference-option]");
  await expect(rows.first()).toHaveAttribute("data-reference-option", "demo-app/docs");
  await expect(rows.nth(1)).toHaveAttribute("data-reference-option", "demo-app/src");
  await expect(option(page, "demo-app/README.md")).toHaveAttribute("data-reference-kind", "file");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(composer(page)).toHaveValue("đọc @demo-app/src/");
  await expect(option(page, "demo-app/src/app.ts")).toBeVisible();
  await page.screenshot({ path: join(EVIDENCE, "composer-references-02-path.png") });

  await page.keyboard.press("Enter");
  await expect(composer(page)).toHaveValue("đọc @demo-app/src/app.ts ");
  const sent = nextMessage(page);
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { references?: { items: { kind: string; path?: string }[] } };
  expect(body.references?.items).toEqual([expect.objectContaining({ kind: "file", path: "src/app.ts" })]);

  const userRow = page.locator('.cc-row[data-role="user"]').last();
  const chip = userRow.locator('[data-reference-block="demo-app/src/app.ts"]');
  await expect(chip).toContainText("@demo-app/src/app.ts");
  // What the node found when it checked the file.
  await expect(chip).toContainText("22 byte");
  // Briefed by the path under the approved folder, never an absolute one.
  const reply = page.locator('.cc-row[data-role="assistant"]').last();
  await expect(reply).toContainText('Tệp "demo-app/src/app.ts" (22 byte) — đường dẫn workspace/demo-app/src/app.ts');
  await expect(reply).not.toContainText(DATA_DIR);
});

test("Escape closes the picker and leaves the draft as it was", async ({ page }) => {
  await openApp(page);
  await composer(page).click();
  await page.keyboard.type("xem @de");
  await expect(option(page, "demo-app")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue("xem @de");
  await expect(composer(page)).toHaveAttribute("aria-expanded", "false");
  await expect(composer(page)).toBeFocused();

  // An email address is text, not a mention.
  await composer(page).fill("");
  await page.keyboard.type("gửi an@example.com");
  await expect(picker(page)).toHaveCount(0);
});

test("the pointer chooses a row and opens a folder, and removing a chip takes its token out", async ({ page }) => {
  await openApp(page);
  await composer(page).click();
  await page.keyboard.type("@");
  await expect(option(page, "demo-app")).toBeVisible();

  await page.locator('[data-reference-open="demo-app"]').click();
  await expect(composer(page)).toHaveValue("@demo-app/");
  await option(page, "demo-app/docs").click();
  await expect(composer(page)).toHaveValue("@demo-app/docs ");
  await expect(page.locator('[data-reference-chip="demo-app/docs"]')).toBeVisible();
  await expect(composer(page)).toBeFocused();

  await page.keyboard.type("và /");
  await option(page, "release-notes").click();
  await expect(composer(page)).toHaveValue("@demo-app/docs và /release-notes ");
  await expect(page.locator("[data-reference-chip]")).toHaveCount(2);
  await page.screenshot({ path: join(EVIDENCE, "composer-references-03-chips.png") });

  await page.locator('[data-reference-remove="demo-app/docs"]').click();
  await expect(composer(page)).toHaveValue("và /release-notes ");
  await expect(page.locator("[data-reference-chip]")).toHaveCount(1);

  // Deleting the token by typing drops the reference too, so nothing rides along unseen.
  await composer(page).fill("và");
  await expect(page.locator("[data-reference-chips]")).toHaveCount(0);
});

test("a file deleted after it was chosen refuses the send by name and keeps the draft", async ({ page }) => {
  await openApp(page);
  await composer(page).click();
  await page.keyboard.type("@demo-app/docs/gu");
  await expect(option(page, "demo-app/docs/guide.md")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("tóm tắt");

  const guide = join(DEMO, "docs", "guide.md");
  rmSync(guide);
  try {
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-statusline]")).toContainText("@demo-app/docs/guide.md: không còn tồn tại");
    await expect(composer(page)).toHaveValue("@demo-app/docs/guide.md tóm tắt");
    await expect(page.locator('[data-reference-chip="demo-app/docs/guide.md"]')).toBeVisible();
    await page.screenshot({ path: join(EVIDENCE, "composer-references-04-stale.png") });
  } finally {
    writeFileSync(guide, "# Hướng dẫn\n");
  }

  // With the file back, the same draft goes through.
  await composer(page).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.locator('.cc-row[data-role="user"]').last().locator('[data-reference-block="demo-app/docs/guide.md"]')).toBeVisible();
});

test("an input method's Enter finishes its word instead of choosing a row or sending, and Shift+Enter starts a line", async ({ page }) => {
  await openApp(page);
  let sends = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/messages(\/stream)?$/u.test(request.url())) sends += 1;
  });
  // What an input method does while a word is being put together: the Enter that finishes the word arrives inside
  // the composition, and belongs to it.
  const composingEnter = () =>
    composer(page).evaluate((field) => {
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing: true }));
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    });

  await composer(page).click();
  await page.keyboard.type("@demo");
  await expect(option(page, "demo-app")).toBeVisible();
  await composingEnter();
  await expect(composer(page)).toHaveValue("@demo");
  await expect(option(page, "demo-app")).toBeVisible();
  await expect(page.locator("[data-reference-chip]")).toHaveCount(0);

  // The word is finished: Enter chooses the row.
  await page.keyboard.press("Enter");
  await expect(composer(page)).toHaveValue("@demo-app ");

  // With the picker closed, a composing Enter still does not send.
  await page.keyboard.type("dòng một");
  await composingEnter();
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("dòng hai");
  await expect(composer(page)).toHaveValue("@demo-app dòng một\ndòng hai");

  const sent = nextMessage(page);
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { text: string; references?: { items: { kind: string }[] } };
  expect(body.text).toBe("@demo-app dòng một\ndòng hai");
  expect(body.references?.items).toEqual([expect.objectContaining({ kind: "project", label: "demo-app" })]);
  expect(sends).toBe(1);
});

test("background work is pointed at with an at sign and briefed by what the node holds of it", async ({ page, request }) => {
  const created = await request.post(`${GATEWAY}/conversations`, { headers: authorized(), data: { title: "Việc nền để nhắc tới" } });
  const { conversationId } = (await created.json()) as { conversationId: string };
  const started = await request.post(`${GATEWAY}/background-sessions`, {
    headers: authorized(),
    data: { conversationId, text: "tóm tắt nhật ký tuần" },
  });
  expect(started.status()).toBe(202);
  const { sessionId } = (await started.json()) as { sessionId: string };

  await openApp(page);
  await composer(page).click();
  await page.keyboard.type("kết quả của @tóm");
  const row = option(page, "tóm tắt nhật ký tuần");
  await expect(row).toHaveAttribute("data-reference-kind", "background-work");
  await expect(row).toContainText("việc nền");
  await page.screenshot({ path: join(EVIDENCE, "composer-references-05-work.png") });

  await page.keyboard.press("Enter");
  await expect(composer(page)).toHaveValue("kết quả của @tóm tắt nhật ký tuần ");
  const sent = nextMessage(page);
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { references?: { items: unknown[] } };
  expect(body.references?.items).toEqual([{ kind: "background-work", workId: sessionId, label: "tóm tắt nhật ký tuần" }]);

  await expect(page.locator('.cc-row[data-role="user"]').last().locator('[data-reference-block="tóm tắt nhật ký tuần"]')).toBeVisible();
  const reply = page.locator('.cc-row[data-role="assistant"]').last();
  await expect(reply).toContainText(`Việc nền "tóm tắt nhật ký tuần"`);
  await expect(reply).toContainText(`workId ${sessionId}`);
});

/** The notes package, whose service the node runs in a container; installed once, like the service journey does. */
async function installNotes(request: APIRequestContext): Promise<void> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: authorized() })).json()) as { packages: { packageId: string }[] };
  if (listed.packages.some((entry) => entry.packageId === "com.example.notes")) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers: authorized(),
    data: { packageId: "com.example.notes", version: "1.0.0", localDigest: "sha256:notes-service-digest" },
  });
  expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
}

test("a package's service is pointed at by its name and offered with its state only", async ({ page, request }) => {
  await installNotes(request);
  // The host picks the service up once it has looked for a container engine, after the install answered.
  await expect
    .poll(
      async () => {
        const response = await request.get(`${GATEWAY}/composer/suggestions`, {
          headers: authorized(),
          params: { trigger: "@", q: "com.example.notes" },
        });
        const body = (await response.json()) as { suggestions?: { kind: string }[] };
        return body.suggestions?.some((row) => row.kind === "mcp-server") ?? false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await openApp(page);
  await composer(page).click();
  await page.keyboard.type("dùng @com.example.notes.se");
  const row = option(page, "com.example.notes.service");
  await expect(row).toHaveAttribute("data-reference-kind", "mcp-server");
  // Its state, in words; whatever it is, never why it is in it or what it was started with.
  await expect(row).toContainText(/dịch vụ (đang chạy|đang lỗi|chưa chạy)/u);

  await page.keyboard.press("Enter");
  await expect(composer(page)).toHaveValue("dùng @com.example.notes.service ");
  const sent = nextMessage(page);
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { references?: { items: { kind: string; serviceKey?: string; label?: string }[] } };
  const [reference] = body.references?.items ?? [];
  expect(reference).toMatchObject({ kind: "mcp-server", label: "com.example.notes.service" });
  // Referenced by the key the host runs it under, which names the package generation; shown by the id a person reads.
  expect(reference?.serviceKey).toMatch(/#com\.example\.notes\.service$/u);

  await expect(page.locator('.cc-row[data-role="user"]').last().locator('[data-reference-block="com.example.notes.service"]')).toBeVisible();
  const reply = page.locator('.cc-row[data-role="assistant"]').last();
  await expect(reply).toContainText('Dịch vụ MCP "com.example.notes.service"');
  await expect(reply).toContainText("Tham chiếu là con trỏ, không phải quyền");
});