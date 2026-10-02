import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type FrameLocator, type Page } from "@playwright/test";

/**
 * The reference text editor, from the conversation: a package on disk that opens a real file, edits it and saves it.
 *
 * The editor's rules have unit tests and the artifact bridge has its own journey; this is the app between them. A
 * person opens a file through the host's chrome, edits it in the frame, saves it — as a download on the web, back over
 * the original on the desktop — and opens what was saved to find the edit there. They select a sentence and ask Clark
 * to rewrite it: the editor presses its own `agent` button, the host reads the selection from what the editor
 * published, and the reply comes back to the editor, which changes the text only when the person accepts it.
 *
 * The desktop path here is the page's half only: the shell's preload is simulated in the page, with the same contract
 * (`pickFile`/`saveFile`, an opaque handle), so the page's Replace original path runs for real against it. The shell's
 * helpers (handle to path, keeping the type, the atomic write) are unit-tested in `apps/desktop/test/file-bridge.spec.ts`;
 * the shell's IPC handler and its confirm dialog are not exercised by either.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

const FILE_NAME = "ghi-chu.txt";
const FILE_TEXT = "Dòng một của ghi chú.\nhãy viết lại câu này.\nDòng ba.\n";
const SENTENCE = "hãy viết lại câu này.";

/** What a place on disk looks like in a message: a drive, a home directory, the node's data or blob directories. */
const PLACE = /(?<![A-Za-z])[A-Za-z]:(?:\\\\|\/)|\/(?:Users|home|tmp|var)\/|\.data(?:\\\\|\/)|blobs(?:\\\\|\/)|staging(?:\\\\|\/)|\.part\b/;
/** What the simulated shell names a picked file by. It must never reach the frame. */
const HANDLE = /fh_[a-f0-9]{32}/;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Every bridge message, recorded on both sides before any page script runs, serialized as it arrived. */
async function recordBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = window as unknown as { __ccBridge: string[] };
    probe.__ccBridge = [];
    window.addEventListener("message", (event: MessageEvent) => {
      try {
        probe.__ccBridge.push(JSON.stringify(event.data));
      } catch {
        probe.__ccBridge.push("[unserializable]");
      }
    });
  });
}

const FRAME = "[data-pin-live] [data-widget-frame] iframe";

/** What the page heard from the frame (`outer`), and what the frame heard from the host (`inner`). */
async function frameTraffic(page: Page): Promise<{ outer: string[]; inner: string[] }> {
  const outer = await page.evaluate(() => (window as unknown as { __ccBridge?: string[] }).__ccBridge ?? []);
  const element = await page.locator(FRAME).elementHandle();
  const inner = (await (await element?.contentFrame())?.evaluate(() => (window as unknown as { __ccBridge?: string[] }).__ccBridge ?? [])) ?? [];
  return { outer, inner };
}

async function expectNoPlaceInTraffic(page: Page): Promise<void> {
  const { outer, inner } = await frameTraffic(page);
  // Both directions were heard: the frame's file requests, and the host's answers carrying refs. A recording that
  // missed either would pass the checks below without having looked at it.
  expect(outer.some((message) => message.includes('"kind":"artifact.request"'))).toBe(true);
  expect(inner.some((message) => message.includes('"kind":"artifact-result"'))).toBe(true);
  const messages = [...outer, ...inner];
  expect(messages.filter((message) => PLACE.test(message))).toEqual([]);
  expect(messages.filter((message) => HANDLE.test(message))).toEqual([]);
}

/**
 * A simulated desktop preload: a disk of one file, named by the path only the shell knows and by an opaque handle the
 * page is given. Installed in the top window only; a widget frame never sees the shell's bridge.
 */
async function simulateDesktop(page: Page, file: { name: string; text: string }): Promise<void> {
  await page.addInitScript((picked) => {
    if (window.top !== window) return;
    const handle = `fh_${"0123456789abcdef".repeat(2)}`;
    const disk = { path: `C:\\Users\\nguoi-dung\\Documents\\${picked.name}`, name: picked.name, text: picked.text, writes: 0, replaced: 0 };
    const encode = (text: string): string => {
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const decode = (base64: string): string => new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
    const scope = window as unknown as { clarkcant: unknown; __ccDisk: typeof disk };
    scope.__ccDisk = disk;
    scope.clarkcant = {
      setCompactMode: () => Promise.resolve({ ok: true }),
      pickFile: () =>
        Promise.resolve({ ok: true, canceled: false, file: { name: disk.name, mimeType: "text/plain", contentBase64: encode(disk.text), handle } }),
      saveFile: (input: { suggestedName: string; contentBase64: string; replaceHandle?: string }) => {
        disk.writes += 1;
        if (input.replaceHandle === undefined) return Promise.resolve({ ok: true, canceled: true });
        if (input.replaceHandle !== handle) return Promise.resolve({ ok: false, refused: "HANDLE_UNKNOWN" });
        disk.text = decode(input.contentBase64);
        disk.replaced += 1;
        return Promise.resolve({ ok: true, saved: true, name: disk.name });
      },
    };
  }, file);
}

async function openEditor(page: Page): Promise<FrameLocator> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await say(page, "mở trình soạn thảo văn bản");
  await expect(page.getByText("Fixture: trình soạn thảo văn bản mẫu").last()).toBeVisible({ timeout: 20_000 });
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  await expect(page.locator("[data-pin-live] [data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
  const frame = page.frameLocator(FRAME);
  await expect(frame.locator("#root[data-editor-ready='true']")).toHaveCount(1, { timeout: 20_000 });
  return frame;
}

/** Open a file through the browser's own chooser, from the host's question. */
async function openInBrowser(page: Page, frame: FrameLocator, name: string, text: string): Promise<void> {
  await frame.locator("[data-editor-open]").click();
  const prompt = page.locator("[data-artifact-prompt='pick']");
  await expect(prompt).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await prompt.locator("[data-artifact-choose]").click();
  await (await chooser).setFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
  await expect(frame.locator("[data-editor-status='opened']")).toHaveCount(1, { timeout: 20_000 });
}

/** Select a substring of the editor's text, as a person dragging over it would. */
async function selectText(frame: FrameLocator, text: string): Promise<void> {
  await frame.locator("[data-editor-text]").evaluate((element, wanted) => {
    const area = element as HTMLTextAreaElement;
    const start = area.value.indexOf(wanted);
    if (start < 0) throw new Error(`"${wanted}" is not in the editor`);
    area.focus();
    area.setSelectionRange(start, start + wanted.length);
    area.dispatchEvent(new Event("select"));
  }, text);
}

test("on the web, a file is opened, edited, saved as a download and opened again with the edit", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await recordBridge(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const frame = await openEditor(page);

  // Nothing is open yet, and asking Clark says why it cannot.
  await expect(frame.locator("[data-editor-name]")).toHaveText("Chưa mở tệp nào");
  await expect(frame.locator("[data-editor-ask]")).toBeDisabled();

  await openInBrowser(page, frame, FILE_NAME, FILE_TEXT);
  await expect(frame.locator("[data-editor-name]")).toHaveText(FILE_NAME);
  await expect(frame.locator("[data-editor-text]")).toHaveValue(FILE_TEXT);
  await expect(frame.locator("[data-editor-meta]")).toHaveText("3 dòng");
  await expect(frame.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "false");

  const edited = `${FILE_TEXT}Dòng bốn, thêm trên web.\n`;
  const area = frame.locator("[data-editor-text]");
  await area.focus();
  await area.press("ControlOrMeta+End");
  await area.pressSequentially("Dòng bốn, thêm trên web.\n");
  await expect(area).toHaveValue(edited);
  await expect(frame.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "true");
  await expect(frame.locator("[data-editor-meta]")).toHaveText("4 dòng");

  // The unsaved draft is in widget state: reloading the page brings it back, still unsaved.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  // The editor was pinned open, so the page brings it back by itself.
  await expect(page.locator("[data-pin-live] [data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
  const restored = page.frameLocator(FRAME);
  await expect(restored.locator("#root[data-editor-ready='true']")).toHaveCount(1, { timeout: 20_000 });
  await expect(restored.locator("[data-editor-text]")).toHaveValue(edited);
  await expect(restored.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "true");
  await expect(restored.locator("[data-editor-status='restored']")).toHaveCount(1);

  // Save As is the host's. The web says replacing the original is a desktop thing, and saves through the download.
  await restored.locator("[data-editor-save]").click();
  const savePrompt = page.locator("[data-artifact-prompt='export']");
  await expect(savePrompt).toBeVisible({ timeout: 20_000 });
  await expect(savePrompt.locator("[data-artifact-web-original]")).toBeVisible();
  await expect(savePrompt.locator("[data-artifact-replace]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("text-editor-save-1280.png"), fullPage: true });
  const download = page.waitForEvent("download");
  await savePrompt.locator("[data-artifact-save]").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe(FILE_NAME);
  const savedText = readFileSync(await saved.path(), "utf8");
  expect(savedText).toBe(edited);
  await expect(restored.locator("[data-editor-status='saved']")).toHaveCount(1, { timeout: 20_000 });
  // On the web a download has only started, so the editor does not say the file was saved.
  await expect(restored.locator("[data-editor-status]")).not.toContainText("đã lưu");
  await expect(restored.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "false");

  // The saved file, opened again, has the edit.
  await openInBrowser(page, restored, FILE_NAME, savedText);
  await expect(restored.locator("[data-editor-text]")).toHaveValue(edited);
  await expect(restored.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "false");

  // A file that is not text is refused with the reason, and the open file stays.
  await restored.locator("[data-editor-open]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-artifact-prompt='pick'] [data-artifact-choose]").click();
  await (await chooser).setFiles({ name: "khong-phai-van-ban.txt", mimeType: "text/plain", buffer: Buffer.from([0xff, 0xfe, 0x00, 0x41]) });
  await expect(restored.locator("[data-editor-status='refused']")).toHaveCount(1, { timeout: 20_000 });
  await expect(restored.locator("[data-editor-name]")).toHaveText(FILE_NAME);

  await expectNoPlaceInTraffic(page);
  expect(await horizontalOverflow(page)).toBe(0);
});

test("on the desktop, a save replaces the original the person opened, and opening it again shows the edit", async ({ page }) => {
  test.setTimeout(180_000);
  await recordBridge(page);
  await simulateDesktop(page, { name: FILE_NAME, text: FILE_TEXT });
  await page.setViewportSize({ width: 1280, height: 900 });
  const frame = await openEditor(page);

  // The desktop asks the shell for the file: no browser chooser, and the frame gets a ref, never the handle.
  await frame.locator("[data-editor-open]").click();
  await page.locator("[data-artifact-prompt='pick'] [data-artifact-choose]").click();
  await expect(frame.locator("[data-editor-status='opened']")).toHaveCount(1, { timeout: 20_000 });
  await expect(frame.locator("[data-editor-text]")).toHaveValue(FILE_TEXT);

  const area = frame.locator("[data-editor-text]");
  await area.focus();
  await area.press("ControlOrMeta+Home");
  await area.pressSequentially("Đã sửa trên máy tính. ");
  const edited = `Đã sửa trên máy tính. ${FILE_TEXT}`;
  await expect(area).toHaveValue(edited);

  // Ctrl/Cmd+S saves. The host offers to write over the original, which only it can name.
  await area.press("ControlOrMeta+s");
  const savePrompt = page.locator("[data-artifact-prompt='export']");
  await expect(savePrompt).toBeVisible({ timeout: 20_000 });
  await expect(savePrompt.locator("[data-artifact-web-original]")).toHaveCount(0);
  const replace = savePrompt.locator("[data-artifact-replace]");
  await expect(replace).toBeVisible();
  await expect(replace).toContainText(FILE_NAME);
  await replace.click();
  await expect(frame.locator("[data-editor-status='saved']")).toHaveCount(1, { timeout: 20_000 });
  await expect(frame.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "false");

  const disk = await page.evaluate(() => (window as unknown as { __ccDisk: { text: string; replaced: number } }).__ccDisk);
  expect(disk.replaced).toBe(1);
  expect(disk.text).toBe(edited);

  // Opening the file again reads what is on disk now.
  await frame.locator("[data-editor-open]").click();
  await page.locator("[data-artifact-prompt='pick'] [data-artifact-choose]").click();
  await expect(frame.locator("[data-editor-status='opened']")).toHaveCount(1, { timeout: 20_000 });
  await expect(frame.locator("[data-editor-text]")).toHaveValue(edited);

  await expectNoPlaceInTraffic(page);
});

test("a person selects a sentence, asks Clark to rewrite it, and accepts the reply into the text", async ({ page }) => {
  test.setTimeout(180_000);
  await recordBridge(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const frame = await openEditor(page);
  await openInBrowser(page, frame, FILE_NAME, FILE_TEXT);

  // With nothing selected there is nothing to ask about, and the editor says so before anything is sent.
  await frame.locator("[data-editor-text]").evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(0, 0);
  });
  await expect(frame.locator("[data-editor-ask]")).toBeDisabled();
  await expect(frame.locator("[data-editor-ask-reason]")).toContainText("Chọn một đoạn");

  await selectText(frame, SENTENCE);
  await expect(frame.locator("[data-editor-meta]")).toContainText(`đã chọn ${String(Array.from(SENTENCE).length)} ký tự`);
  const ask = frame.locator("[data-editor-ask]");
  await expect(ask).toBeEnabled();
  await ask.click();

  // The reply in the conversation quotes what the host read from the editor — the selection, not the button's words.
  await expect(page.getByText(`Fixture: viết lại đoạn host đọc được "${SENTENCE}"`).last()).toBeVisible({ timeout: 30_000 });

  // The editor shows the proposal for review; nothing has changed yet.
  const proposal = frame.locator("[data-editor-proposal]");
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator("[data-editor-proposal-text]")).toHaveText(SENTENCE.toLocaleUpperCase("vi"));
  // It names the text it would replace, which is the text Clark read.
  await expect(frame.locator("[data-editor-proposal-replaces]")).toHaveText(`Thay cho: «${SENTENCE}»`);
  await expect(frame.locator("[data-editor-text]")).toHaveValue(FILE_TEXT);
  await expect(frame.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "false");
  // The text area is editable again once Clark answered.
  await expect(frame.locator("[data-editor-text]")).not.toHaveAttribute("readonly");

  await frame.locator("[data-editor-apply]").click();
  await expect(proposal).toBeHidden();
  await expect(frame.locator("[data-editor-text]")).toHaveValue(FILE_TEXT.replace(SENTENCE, SENTENCE.toLocaleUpperCase("vi")));
  await expect(frame.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "true");
  await expect(frame.locator("[data-editor-status='applied']")).toHaveCount(1);

  // The accepted change went in as an edit, so Undo takes it back like anything typed.
  await frame.locator("[data-editor-text]").press("ControlOrMeta+z");
  await expect(frame.locator("[data-editor-text]")).toHaveValue(FILE_TEXT);
  await expect(frame.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "false");

  // A selection over two lines would reach Clark flattened onto one, so it is not sent, and the editor says why.
  await selectText(frame, "của ghi chú.\nhãy");
  await expect(frame.locator("[data-editor-ask]")).toBeDisabled();
  await expect(frame.locator("[data-editor-ask-reason]")).toContainText("một dòng");

  // A reply to a selection that changed while Clark answered is not applied over the new text.
  await selectText(frame, "Dòng ba.");
  await frame.locator("[data-editor-ask]").click();
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await frame.locator("[data-editor-text]").evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.value = area.value.replace("Dòng ba.", "Dòng 3.");
    area.dispatchEvent(new Event("input"));
  });
  await frame.locator("[data-editor-apply]").click();
  await expect(frame.locator("[data-editor-status='changed']")).toHaveCount(1);
  await expect(frame.locator("[data-editor-text]")).toHaveValue(/Dòng 3\./u);

  await expectNoPlaceInTraffic(page);
});

test("typing on while the draft is being kept is not mistaken for another window's change", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const frame = await openEditor(page);
  await openInBrowser(page, frame, FILE_NAME, FILE_TEXT);

  // Hold the first draft write on its way to the node, so the person types on before it is committed.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  await page.route("**/widgets/*/state", async (route) => {
    if (holding && route.request().method() === "POST") {
      holding = false;
      await held;
    }
    await route.continue();
  });

  const area = frame.locator("[data-editor-text]");
  await area.focus();
  await area.press("ControlOrMeta+End");
  await area.pressSequentially("Một");
  // Past the pause after which the draft is written; that write is now held.
  await expect.poll(() => holding, { timeout: 10_000 }).toBe(false);
  await area.pressSequentially(" hai ba");
  release?.();

  // The write comes back committed while the text has moved on: that is this view's own write, not a conflict.
  await page.waitForTimeout(1_500);
  await expect(frame.locator("[data-editor-conflict]")).toBeHidden();
  await expect(area).toBeFocused();
  await expect(area).toHaveValue(`${FILE_TEXT}Một hai ba`);

  // And the newer text is kept too: after a reload it is all there.
  await page.waitForTimeout(800);
  await page.unroute("**/widgets/*/state");
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-pin-live] [data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
  const restored = page.frameLocator(FRAME);
  await expect(restored.locator("#root[data-editor-ready='true']")).toHaveCount(1, { timeout: 20_000 });
  await expect(restored.locator("[data-editor-text]")).toHaveValue(`${FILE_TEXT}Một hai ba`);
});

test("asking Clark waits for the selection still on its way, and is refused with what happens next when it cannot arrive", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const frame = await openEditor(page);
  await openInBrowser(page, frame, FILE_NAME, FILE_TEXT);
  await page.waitForTimeout(800);

  // Every description the editor sends from here on is held on its way to the node, as a stalled request would be.
  const held: (() => void)[] = [];
  let holding = true;
  await page.route("**/widgets/*/semantic", async (route) => {
    if (holding) await new Promise<void>((resolve) => held.push(resolve));
    await route.continue().catch(() => undefined);
  });
  const actions: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/widgets\/[^/]+\/actions$/.test(new URL(request.url()).pathname)) actions.push(request.url());
  });

  // The selection settles and is sent; the press comes while that send is still on its way, so the editor publishes
  // nothing new and the press has only the send in flight to wait for.
  await selectText(frame, SENTENCE);
  await expect.poll(() => held.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await frame.locator("[data-editor-ask]").click();
  await page.waitForTimeout(1_500);
  // The agent press reads the selection, so it waits for it rather than running against an older description.
  expect(actions).toEqual([]);
  await expect(frame.locator("[data-editor-status='asking']")).toHaveCount(1);

  // The wait is bounded: the press is refused with the host's sentence, which says what failed, what is kept and what
  // to do next, and the text area is editable again.
  const refused = frame.locator("[data-editor-status='refused']");
  await expect(refused).toHaveCount(1, { timeout: 15_000 });
  await expect(refused).toContainText("Chưa gửi kịp cho Clark điều widget đang hiển thị");
  await expect(refused).toContainText("Hãy thử lại sau giây lát.");
  expect(actions).toEqual([]);
  await expect(frame.locator("[data-editor-text]")).not.toHaveAttribute("readonly");
  await expect(frame.locator("[data-editor-text]")).toHaveValue(FILE_TEXT);

  // Once the node answers again, the same press goes through and Clark reads the selection.
  holding = false;
  for (const release of held.splice(0)) release();
  await page.unroute("**/widgets/*/semantic");
  await selectText(frame, SENTENCE);
  await frame.locator("[data-editor-ask]").click();
  await expect(page.getByText(`Fixture: viết lại đoạn host đọc được "${SENTENCE}"`).last()).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator("[data-editor-proposal]")).toBeVisible({ timeout: 30_000 });
});

test("a view that could not reopen the file never writes, so another view's unsaved draft is kept", async ({ page, context }) => {
  test.setTimeout(180_000);
  const other = page;
  await other.setViewportSize({ width: 1280, height: 900 });
  const frame = await openEditor(other);
  await openInBrowser(other, frame, FILE_NAME, FILE_TEXT);
  await other.waitForTimeout(800);

  // A second view of the same conversation, whose read of the saved copy is refused, as after its grant lapsed.
  const conversation = await other.evaluate(() => window.sessionStorage.getItem("cc_conversation"));
  expect(conversation).not.toBeNull();
  const empty = await context.newPage();
  await empty.setViewportSize({ width: 1280, height: 900 });
  await empty.route("**/artifacts/*/content*", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "ARTIFACT_GRANT_EXPIRED", message: "the grant has lapsed" }) }),
  );
  const writes: string[] = [];
  empty.on("request", (request) => {
    if (request.method() === "POST" && /\/widgets\/[^/]+\/state$/.test(new URL(request.url()).pathname)) writes.push(request.url());
  });
  await empty.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await empty.evaluate((id) => window.sessionStorage.setItem("cc_conversation", id as string), conversation);
  await empty.reload();
  await expect(empty.locator("[data-pin-live] [data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", { timeout: 30_000 });
  const emptyFrame = empty.frameLocator(FRAME);
  await expect(emptyFrame.locator("#root[data-editor-ready='true']")).toHaveCount(1, { timeout: 20_000 });
  // It shows no document, and says why, rather than an empty text that would pass for the file.
  await expect(emptyFrame.locator("[data-editor-name]")).toHaveText("Chưa mở tệp nào");
  await expect(emptyFrame.locator("[data-editor-status='refused']")).toContainText("Hãy mở lại tệp");

  // The first view types a draft, which is kept in widget state.
  const area = frame.locator("[data-editor-text]");
  await area.focus();
  await area.press("ControlOrMeta+End");
  await area.pressSequentially("Nháp chưa lưu.");
  await other.waitForTimeout(1_200);

  // In the view with no document, Escape has nothing to keep, offers no conflict, and writes nothing.
  await emptyFrame.locator("#root").click();
  await empty.keyboard.press("Escape");
  await empty.waitForTimeout(1_000);
  await expect(emptyFrame.locator("[data-editor-conflict]")).toBeHidden();
  expect(writes).toEqual([]);

  // The first view's draft is still what the node keeps: a reload brings it back.
  await other.reload();
  await expect(other.locator("[data-pin-live] [data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", { timeout: 30_000 });
  const restored = other.frameLocator(FRAME);
  await expect(restored.locator("#root[data-editor-ready='true']")).toHaveCount(1, { timeout: 20_000 });
  await expect(restored.locator("[data-editor-text]")).toHaveValue(`${FILE_TEXT}Nháp chưa lưu.`);
  await expect(restored.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "true");
  await empty.close();
});

test("the editor is usable by keyboard alone", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const frame = await openEditor(page);

  // Into the frame by keyboard: its first control takes focus, and Enter opens the host's question.
  await frame.locator("[data-editor-open]").focus();
  await expect(frame.locator("[data-editor-open]")).toBeFocused();
  await page.keyboard.press("Enter");
  const prompt = page.locator("[data-artifact-prompt='pick']");
  await expect(prompt.locator("[data-artifact-title]")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(prompt.locator("[data-artifact-choose]")).toBeFocused();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: FILE_NAME, mimeType: "text/plain", buffer: Buffer.from(FILE_TEXT) });
  await expect(frame.locator("[data-editor-status='opened']")).toHaveCount(1, { timeout: 20_000 });

  // Tab order: open, save, attach, ask (disabled until a selection, so skipped), then the text.
  await frame.locator("[data-editor-open]").focus();
  await page.keyboard.press("Tab");
  await expect(frame.locator("[data-editor-save]")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(frame.locator("[data-editor-attach]")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(frame.locator("[data-editor-text]")).toBeFocused();

  // Select the second line with the keyboard and ask Clark.
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect(frame.locator("[data-editor-meta]")).toContainText(`đã chọn ${String(Array.from(SENTENCE).length)} ký tự`);
  await page.keyboard.press("Shift+Tab");
  await expect(frame.locator("[data-editor-ask]")).toBeFocused();
  await page.keyboard.press("Enter");

  // The proposal takes focus at its title; one Tab reaches Apply, and Enter applies it.
  await expect(frame.locator("#editor-proposal-title")).toBeFocused({ timeout: 30_000 });
  await page.keyboard.press("Tab");
  await expect(frame.locator("[data-editor-apply]")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(frame.locator("[data-editor-text]")).toBeFocused();
  await expect(frame.locator("[data-editor-text]")).toHaveValue(FILE_TEXT.replace(SENTENCE, SENTENCE.toLocaleUpperCase("vi")));

  // Opening another file with unsaved changes asks first; Escape closes the question and returns to Open.
  await frame.locator("[data-editor-open]").focus();
  await page.keyboard.press("Enter");
  await expect(frame.locator("#editor-discard-title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(frame.locator("[data-editor-discard]")).toBeHidden();
  await expect(frame.locator("[data-editor-open]")).toBeFocused();
  await frame.locator("[data-editor-text]").focus();

  // Ctrl/Cmd+S from the text, Tab to Save As, Enter: the download carries the edit.
  await page.keyboard.press("ControlOrMeta+s");
  const savePrompt = page.locator("[data-artifact-prompt='export']");
  await expect(savePrompt.locator("[data-artifact-title]")).toBeFocused({ timeout: 20_000 });
  await page.keyboard.press("Tab");
  await expect(savePrompt.locator("[data-artifact-save]")).toBeFocused();
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect(readFileSync(await (await download).path(), "utf8")).toBe(FILE_TEXT.replace(SENTENCE, SENTENCE.toLocaleUpperCase("vi")));
  await expect(frame.locator("[data-editor-status='saved']")).toHaveCount(1, { timeout: 20_000 });
});

test("the editor fits a phone, follows light and dark, and keeps still under reduced motion", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const frame = await openEditor(page);
  await openInBrowser(page, frame, FILE_NAME, FILE_TEXT);

  // Under reduced motion nothing in the frame transitions.
  const transition = await frame.locator("[data-editor-save]").evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(transition.split(",").every((value) => Number.parseFloat(value) === 0)).toBe(true);

  const overflow: Record<string, number> = {};
  const canvas: Record<string, string> = {};
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.locator("[data-pin-live] [data-widget-frame]").scrollIntoViewIfNeeded();
    await expect
      .poll(async () => frame.locator("html").evaluate((element) => element.getAttribute("data-scheme") ?? getComputedStyle(element).colorScheme))
      .toContain(colorScheme);
    canvas[colorScheme] = await frame.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.screenshot({ path: testInfo.outputPath(`text-editor-390-${colorScheme}.png`), fullPage: true });
    overflow[`390-${colorScheme}`] = await horizontalOverflow(page);
    const frameOverflow = await frame.locator("html").evaluate((element) => element.scrollWidth - element.clientWidth);
    overflow[`390-${colorScheme}-frame`] = frameOverflow;
  }
  expect(canvas.light).not.toBe(canvas.dark);

  // On a phone the toolbar wraps; the frame asks for its content's height, so the status line is inside it.
  const frameBox = await page.locator(FRAME).boundingBox();
  const statusBox = await frame.locator("[data-editor-status]").boundingBox();
  expect(frameBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  if (frameBox !== null && statusBox !== null) {
    expect(frameBox.x + frameBox.width).toBeLessThanOrEqual(390);
    expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height + 1);
  }

  testInfo.annotations.push({ type: "horizontal-overflow", description: JSON.stringify(overflow) });
  expect(overflow).toEqual({ "390-light": 0, "390-light-frame": 0, "390-dark": 0, "390-dark-frame": 0 });
});
