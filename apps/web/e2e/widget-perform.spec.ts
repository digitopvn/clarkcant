import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

/**
 * Clark performing an action an isolated widget offers, from what the person types in the composer.
 *
 * Each package is installed first and its widget placed through `place_widget`, the tool a model has, so the widget's
 * offered actions are bound the way a real install binds them. The person selects something in the widget, then types a
 * request; the fixture model calls `perform_widget_action`, the node checks it like any bound action, the page hands it
 * to the mounted frame, and the frame's answer becomes the tool's result. What changes is asserted in the frame itself.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const FRAME = "[data-pin-live] [data-widget-frame] iframe";

const SPREADSHEET = { packageId: "com.example.spreadsheet", digest: "sha256:spreadsheet-digest", widgetId: "com.example.spreadsheet.main@1" };
const TEXT_EDITOR = {
  packageId: "com.clarkcant.reference.text-editor",
  digest: "sha256:text-editor-reference-digest",
  widgetId: "com.clarkcant.reference.text-editor.main@1",
};

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

const headers = (): Record<string, string> => ({ authorization: `Bearer ${token()}` });

/** Installed for the journey, or restored when an earlier run uninstalled it. */
async function install(request: APIRequestContext, packageId: string, localDigest: string): Promise<void> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: headers() })).json()) as { packages: { packageId: string }[] };
  if (listed.packages.some((entry) => entry.packageId === packageId)) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, { headers: headers(), data: { packageId, version: "1.0.0", localDigest } });
  if (installed.ok()) return;
  const restored = await request.post(`${GATEWAY}/packages/${encodeURIComponent(packageId)}/restore`, { headers: headers() });
  expect(restored.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
}

async function uninstall(request: APIRequestContext, packageId: string): Promise<void> {
  await request.post(`${GATEWAY}/packages/${encodeURIComponent(packageId)}/uninstall`, { headers: headers() });
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

/** Place the widget through `place_widget` and open it live, as the person would. */
async function placeAndOpen(page: Page, widgetId: string, ready: string): Promise<FrameLocator> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await say(page, `place widget ${widgetId}`);
  await expect(page.getByText("Fixture: tui gọi place_widget").last()).toContainText("Actions you can perform on it", { timeout: 20_000 });
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  await expect(page.locator("[data-pin-live] [data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
  const frame = page.frameLocator(FRAME);
  await expect(frame.locator(ready)).toHaveCount(1, { timeout: 20_000 });
  return frame;
}

test.afterAll(async ({ request }) => {
  await uninstall(request, SPREADSHEET.packageId);
  await uninstall(request, TEXT_EDITOR.packageId);
});

test("a range selected in the spreadsheet is formatted as a percentage when the person asks in the composer", async ({ page, request }) => {
  test.setTimeout(180_000);
  await install(request, SPREADSHEET.packageId, SPREADSHEET.digest);
  await page.setViewportSize({ width: 1280, height: 900 });
  const frame = await placeAndOpen(page, SPREADSHEET.widgetId, "#root[data-widget-ready='true']");

  // A value to format: 0.25 in B2 and C3, shown plain.
  for (const cell of ["B2", "C3"]) {
    await frame.locator(`.cell[data-cell='${cell}']`).click();
    await page.keyboard.press("Enter");
    const editor = frame.locator("[data-sheet-editor]");
    await expect(editor).toBeVisible();
    await editor.fill("0.25");
    await page.keyboard.press("Enter");
    await expect(editor).toBeHidden();
  }
  await expect(frame.locator(".cell[data-cell='B2']").first()).toHaveText("0.25");

  await frame.locator(".cell[data-cell='B2']").click();
  await frame.locator(".cell[data-cell='C3']").click({ modifiers: ["Shift"] });
  await expect(frame.locator("[data-sheet-address]")).toHaveText("C3 · B2:C3");

  await say(page, "format this as a percentage");
  await expect(page.getByText("Fixture: tui gọi perform_widget_action").last()).toContainText("Done", { timeout: 30_000 });
  await expect(frame.locator("[data-sheet-status]")).toHaveText("Clark đã định dạng B2:C3 thành phần trăm.");
  await expect(frame.locator(".cell[data-cell='B2']").first()).toHaveText("25%");
  await expect(frame.locator(".cell[data-cell='C3']").first()).toHaveText("25%");

  // Undo steps back the format Clark applied, like one the person asked for.
  await frame.locator("[data-sheet-undo-format]").click();
  await expect(frame.locator(".cell[data-cell='B2']").first()).toHaveText("0.25");
});

test("the text selected in the editor is replaced when the person asks in the composer", async ({ page, request }) => {
  test.setTimeout(180_000);
  await install(request, TEXT_EDITOR.packageId, TEXT_EDITOR.digest);
  await page.setViewportSize({ width: 1280, height: 900 });
  const frame = await placeAndOpen(page, TEXT_EDITOR.widgetId, "#root[data-editor-ready='true']");

  await frame.locator("[data-editor-open]").click();
  const prompt = page.locator("[data-artifact-prompt='pick']");
  await expect(prompt).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await prompt.locator("[data-artifact-choose]").click();
  await (await chooser).setFiles({ name: "ghi-chu.txt", mimeType: "text/plain", buffer: Buffer.from("Dòng một.\nhãy viết hoa câu này.\nDòng ba.\n") });
  await expect(frame.locator("[data-editor-status='opened']")).toHaveCount(1, { timeout: 20_000 });

  // The editor says what is selected once the selection settles; the request is sent after the node holds it, as a
  // person typing would be.
  const published = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/widgets\/[^/]+\/semantic$/.test(new URL(response.url()).pathname) &&
      (response.request().postData() ?? "").includes("selectedText") &&
      response.ok(),
  );
  await frame.locator("[data-editor-text]").evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    const start = area.value.indexOf("hãy viết hoa câu này.");
    area.focus();
    area.setSelectionRange(start, start + "hãy viết hoa câu này.".length);
    area.dispatchEvent(new Event("select"));
  });
  await expect(frame.locator("[data-editor-meta]")).toContainText("đã chọn 21 ký tự");
  await published;

  await say(page, "uppercase the selection");
  await expect(page.getByText("Fixture: tui gọi perform_widget_action").last()).toContainText("Done", { timeout: 30_000 });
  await expect(frame.locator("[data-editor-text]")).toHaveValue("Dòng một.\nHÃY VIẾT HOA CÂU NÀY.\nDòng ba.\n");
  await expect(frame.locator("[data-editor-status]")).toContainText("Clark đã thay đoạn đã chọn.");
  await expect(frame.locator("[data-editor-dirty]")).toHaveAttribute("data-editor-dirty", "true");
});
