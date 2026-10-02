import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type FrameLocator, type Page, type Request } from "@playwright/test";

/**
 * The reference spreadsheet, from the conversation.
 *
 * Its parser, formulas, bounds and semantic document have unit tests beside the package; this is the journey through a
 * browser with the package's own code in its frame: a file picked in host chrome, edited, exported through the browser's
 * download and picked again; a selection Clark formats through the action the host bound to the instance; a file larger
 * than the sheet holds; and the grid used from the keyboard, in both themes and on a phone.
 *
 * Clark's side is the fixture model. What it answers is computed from the data section of the turn the host started,
 * so a format that lands on the selected range shows that the range the host read from the widget reached the model.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const EVIDENCE = join(process.cwd(), "plans", "reports", "evidence", "spreadsheet");

const BOM = String.fromCharCode(0xfeff);

/** A small sheet with a quoted comma, a formula, and text a spreadsheet would run if it were written back raw. */
const SOURCE_NAME = "doanh-thu.csv";
const SOURCE_CSV = [
  "Tên,Số,Tỉ lệ,Ghi chú",
  'An,10,0.25,"Nguyễn, An"',
  "Bình,30,0.5,-dash",
  "Tổng,=SUM(B2:B3),=C2+C3,'@mention",
  "",
].join("\r\n");

/** What a place on disk looks like in a message: a drive, a home directory, the node's data or blob directories. */
const PLACE = /(?<![A-Za-z])[A-Za-z]:(?:\\\\|\/)|\/(?:Users|home|tmp|var)\/|\.data(?:\\\\|\/)|blobs(?:\\\\|\/)|staging(?:\\\\|\/)|\.part\b/;

const CELLS = ["A", "B", "C", "D"].flatMap((column) => [1, 2, 3, 4].map((row) => `${column}${String(row)}`));

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

async function bridgeMessages(page: Page): Promise<string[]> {
  const outer = await page.evaluate(() => (window as unknown as { __ccBridge?: string[] }).__ccBridge ?? []);
  const element = await page.locator("[data-pin-live] [data-widget-frame] iframe").elementHandle();
  const inner = (await (await element?.contentFrame())?.evaluate(() => (window as unknown as { __ccBridge?: string[] }).__ccBridge ?? [])) ?? [];
  return [...outer, ...inner];
}

async function openSpreadsheet(page: Page): Promise<FrameLocator> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await say(page, "bảng tính tham chiếu");
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  await expect(page.locator("[data-pin-live] [data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", {
    timeout: 20_000,
  });
  const frame = page.frameLocator("[data-pin-live] [data-widget-frame] iframe");
  await expect(frame.locator("#root[data-widget-ready='true']")).toHaveCount(1, { timeout: 20_000 });
  return frame;
}

/** Import through the host's own question: the widget asks, the person chooses in host chrome. */
async function importFile(page: Page, frame: FrameLocator, name: string, mimeType: string, text: string): Promise<void> {
  await frame.locator("[data-sheet-import]").click();
  const prompt = page.locator("[data-artifact-prompt='pick']");
  await expect(prompt).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await prompt.locator("[data-artifact-choose]").click();
  await (await chooser).setFiles({ name, mimeType, buffer: Buffer.from(text, "utf8") });
  await expect(frame.locator("[data-sheet-status='loaded']")).toHaveCount(1, { timeout: 30_000 });
}

/** Export through the host's Save As, which a browser answers with its own download. */
async function exportFile(page: Page, frame: FrameLocator, kind: "csv" | "tsv"): Promise<{ name: string; text: string }> {
  await frame.locator(`[data-sheet-export='${kind}']`).click();
  const prompt = page.locator("[data-artifact-prompt='export']");
  await expect(prompt).toBeVisible();
  const download = page.waitForEvent("download");
  await prompt.locator("[data-artifact-save]").click();
  const saved = await download;
  await expect(frame.locator("[data-sheet-status='saved']")).toHaveCount(1, { timeout: 20_000 });
  return { name: saved.suggestedFilename(), text: readFileSync(await saved.path(), "utf8") };
}

async function shownValues(frame: FrameLocator): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const name of CELLS) values[name] = (await frame.locator(`.cell[data-cell='${name}']`).first().textContent()) ?? "";
  return values;
}

async function edit(page: Page, frame: FrameLocator, cell: string, text: string): Promise<void> {
  await frame.locator(`.cell[data-cell='${cell}']`).click();
  await expect(frame.locator("[data-sheet-address]")).toHaveText(cell);
  await page.keyboard.press("Enter");
  const editor = frame.locator("[data-sheet-editor]");
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await page.keyboard.press("Enter");
  await expect(editor).toBeHidden();
}

test("a sheet imported, edited and exported reads back to the same values, and Clark formats the selected range", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  mkdirSync(EVIDENCE, { recursive: true });
  await recordBridge(page);
  // Everything the frame's own document asks the network for, which is where a path would leak to a server.
  const frameRequests: Request[] = [];
  page.on("request", (request) => {
    if (request.frame() !== page.mainFrame()) frameRequests.push(request);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  const frame = await openSpreadsheet(page);

  await importFile(page, frame, SOURCE_NAME, "text/csv", SOURCE_CSV);
  await expect(frame.locator("[data-sheet-status]")).toContainText("Đã nhập doanh-thu.csv: 4 hàng × 4 cột.");
  await expect(frame.locator(".cell[data-cell='D2']")).toHaveText("Nguyễn, An");
  await expect(frame.locator(".cell[data-cell='B4']")).toHaveText("40");
  await expect(frame.locator(".cell[data-cell='D4']")).toHaveText("@mention");

  // Edits: a formula, and a number another formula reads.
  await edit(page, frame, "D2", "=B2*2");
  await expect(frame.locator(".cell[data-cell='D2']")).toHaveText("20");
  await edit(page, frame, "C3", "0.75");
  await expect(frame.locator(".cell[data-cell='C4']")).toHaveText("1");
  await frame.locator(".cell[data-cell='B4']").click();
  await expect(frame.locator("[data-sheet-formula]")).toHaveText("=SUM(B2:B3)");
  const before = await shownValues(frame);
  expect(before).toMatchObject({ A1: "Tên", D2: "20", C3: "0.75", B4: "40", C4: "1", D3: "-dash", D4: "@mention" });

  /*
   * The export holds values, never formulas, and text a spreadsheet would run is written behind a quote — the same
   * rule as the host's own table export. Read back, each file shows the same values as the sheet it came from.
   */
  const expectedRows = [
    ["Tên", "Số", "Tỉ lệ", "Ghi chú"],
    ["An", "10", "0.25", "20"],
    ["Bình", "30", "0.75", "'-dash"],
    ["Tổng", "40", "1", "'@mention"],
  ];
  const csv = await exportFile(page, frame, "csv");
  expect(csv.name).toBe("doanh-thu.csv");
  expect(csv.text).toBe(`${BOM}${expectedRows.map((row) => row.join(",")).join("\r\n")}\r\n`);
  const tsv = await exportFile(page, frame, "tsv");
  expect(tsv.name).toBe("doanh-thu.tsv");
  expect(tsv.text).toBe(`${BOM}${expectedRows.map((row) => row.join("\t")).join("\r\n")}\r\n`);

  await importFile(page, frame, "doanh-thu-xuat.tsv", "text/tab-separated-values", tsv.text);
  expect(await shownValues(frame)).toEqual(before);
  await importFile(page, frame, "doanh-thu-xuat.csv", "text/csv", csv.text);
  expect(await shownValues(frame)).toEqual(before);
  // What came back is the values: the formula is gone, and the quoted text is text again.
  await frame.locator(".cell[data-cell='B4']").click();
  await expect(frame.locator("[data-sheet-formula]")).toHaveText("40");

  /*
   * Select B2:C3 and ask Clark. The press sends nothing: the host reads the selection from the document the widget
   * published, and the fixture model names the range it found in the turn's data. The widget applies the reply only
   * because it is exactly the instruction for the range that was selected.
   */
  const published = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/widgets\/[^/]+\/semantic$/u.test(new URL(response.url()).pathname) &&
      (response.request().postData() ?? "").includes("B2:C3"),
  );
  await frame.locator(".cell[data-cell='B2']").click();
  await frame.locator(".cell[data-cell='C3']").click({ modifiers: ["Shift"] });
  const address = frame.locator("[data-sheet-address]");
  await expect(address).toHaveText("C3 · B2:C3");
  // TODO(#383): drop this wait once the host sends a frame's pending semantic update before it runs an `agent` binding.
  // Until then a press inside the host's 250 ms settle reaches the node before the selection does, Clark is given the
  // previous range, and the widget refuses the reply (which is the safe outcome, but the press does nothing useful).
  expect((await published).ok()).toBe(true);
  const ask = frame.locator("[data-sheet-ask-format]");
  await expect(ask).toBeEnabled();

  // The press is held at the network so the sheet can be seen while Clark answers: the selection does not move.
  let releaseInvoke: () => void = () => undefined;
  const invokeHeld = new Promise<void>((resolve) => {
    releaseInvoke = resolve;
  });
  const actionsPath = /\/conversations\/[^/]+\/widgets\/[^/]+\/actions$/u;
  await page.route(actionsPath, async (route) => {
    await invokeHeld;
    await route.continue();
  });
  await ask.click();
  await expect(frame.locator("[data-sheet-grid]")).toHaveAttribute("data-selection-locked");
  await frame.locator(".cell[data-cell='A1']").click();
  await page.keyboard.press("ArrowDown");
  await expect(address).toHaveText("C3 · B2:C3");
  releaseInvoke();
  await expect(ask).toHaveAttribute("data-format-result", "applied", { timeout: 60_000 });
  await page.unroute(actionsPath);
  await expect(frame.locator("[data-sheet-grid]")).not.toHaveAttribute("data-selection-locked");
  await expect(frame.locator("[data-sheet-status]")).toHaveText("Clark đã định dạng B2:C3 thành phần trăm.");
  await expect(frame.locator(".cell[data-cell='B2']")).toHaveText("1000%");
  await expect(frame.locator(".cell[data-cell='C2']")).toHaveText("25%");
  await expect(frame.locator(".cell[data-cell='C3']")).toHaveText("75%");
  // Outside the range nothing changed.
  await expect(frame.locator(".cell[data-cell='B4']")).toHaveText("40");
  await expect(frame.locator(".cell[data-cell='D2']")).toHaveText("20");
  await page.screenshot({ path: join(EVIDENCE, "spreadsheet-formatted-1280-light.png"), fullPage: true });

  // What Clark applied can be taken back: the Undo button, or Ctrl+Z in the grid, restores the formats before it.
  const undo = frame.locator("[data-sheet-undo-format]");
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(frame.locator(".cell[data-cell='B2']")).toHaveText("10");
  await expect(frame.locator(".cell[data-cell='C3']")).toHaveText("0.75");
  await expect(frame.locator("[data-sheet-status]")).toHaveText("Đã hoàn tác định dạng.");
  await expect(undo).toBeHidden();

  // The reply the widget received came back across the bridge, naming the range the host read.
  const messages = await bridgeMessages(page);
  expect(messages.some((message) => message.includes("format: percent B2:C3"))).toBe(true);

  // Nothing that crossed the bridge or left the frame for the network named a place on disk.
  expect(messages.some((message) => message.includes("artifact.request"))).toBe(true);
  expect(messages.filter((message) => PLACE.test(message))).toEqual([]);
  const leaks = frameRequests
    .map((request) => `${request.url()} ${request.postData() ?? ""}`)
    .filter((line) => PLACE.test(decodeURIComponent(line)));
  expect(frameRequests.length).toBeGreaterThan(0);
  expect(leaks).toEqual([]);

  testInfo.annotations.push({ type: "bridge-messages", description: String(messages.length) });
  expect(await horizontalOverflow(page)).toBe(0);
});

test("a file larger than the sheet holds loads its first part, says so, and stays responsive", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(EVIDENCE, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const frame = await openSpreadsheet(page);

  // 12,000 rows of 5 columns, about 0.5 MB: more rows than the sheet takes and more than one read.
  const rows = ["Mã,Tên,Số lượng,Đơn giá,Thành tiền"];
  for (let row = 2; row <= 12_001; row += 1) rows.push(`SP${String(row)},Hàng ${String(row)},${String(row % 97)},${String(row % 13)}.5,=C${String(row)}*D${String(row)}`);
  const text = `${rows.join("\n")}\n`;
  expect(Buffer.byteLength(text)).toBeGreaterThan(262_144);

  const started = Date.now();
  await importFile(page, frame, "lon.csv", "text/csv", text);
  const loadMs = Date.now() - started;

  const notice = frame.locator("[data-sheet-notice]");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-truncated", "true");
  await expect(notice).toContainText("Chỉ hiện 5000 hàng và 5 cột đầu tiên");
  await expect(frame.locator("[data-sheet-status]")).toContainText("5000 hàng × 5 cột");

  // Only the rows in view are in the document.
  const rendered = Number(await frame.locator(".canvas").getAttribute("data-rendered-rows"));
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(80);
  expect(await frame.locator(".cell[data-cell]").count()).toBeLessThan(1_000);

  // The last row is one keystroke away, and the grid answers within a frame or two rather than seconds.
  await frame.locator("[data-sheet-grid]").focus();
  let moved = Date.now();
  await page.keyboard.press("Control+End");
  await expect(frame.locator("[data-sheet-address]")).toHaveText("E5000");
  const endMs = Date.now() - moved;
  await expect(frame.locator(".cell[data-cell='E5000']")).toHaveText(String((5_000 % 97) * ((5_000 % 13) + 0.5)));
  moved = Date.now();
  await page.keyboard.press("Control+Home");
  await expect(frame.locator("[data-sheet-address]")).toHaveText("A1");
  await expect(frame.locator(".cell[data-cell='A1']")).toHaveText("Mã");
  const homeMs = Date.now() - moved;
  moved = Date.now();
  for (let step = 0; step < 5; step += 1) await page.keyboard.press("PageDown");
  await expect(frame.locator("[data-sheet-address]")).not.toHaveText("A1");
  const pageMs = Date.now() - moved;

  // An edit recomputes a sheet of 5,000 formulas and shows the result.
  moved = Date.now();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("4");
  await page.keyboard.press("Enter");
  await expect(frame.locator(".cell[data-cell='E2']")).toHaveText("10");
  const editMs = Date.now() - moved;
  expect(Number(await frame.locator(".canvas").getAttribute("data-rendered-rows"))).toBeLessThan(80);

  // Clearing every loaded cell is one pass over the sheet, not a copy of the edits per cell.
  moved = Date.now();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Shift+End");
  await expect(frame.locator("[data-sheet-address]")).toHaveText("E5000 · A1:E5000");
  await page.keyboard.press("Delete");
  await expect(frame.locator(".cell[data-cell='E5000']")).toHaveText("");
  await page.keyboard.press("Control+Home");
  await expect(frame.locator(".cell[data-cell='A1']")).toHaveText("");
  const clearMs = Date.now() - moved;
  // The grid still answers straight after.
  await page.keyboard.press("ArrowDown");
  await expect(frame.locator("[data-sheet-address]")).toHaveText("A2");

  const timings = { loadMs, endMs, homeMs, pageMs, editMs, clearMs };
  test.info().annotations.push({ type: "timings", description: JSON.stringify(timings) });
  expect(endMs).toBeLessThan(2_000);
  expect(homeMs).toBeLessThan(2_000);
  expect(pageMs).toBeLessThan(3_000);
  expect(editMs).toBeLessThan(3_000);
  expect(clearMs).toBeLessThan(5_000);
  await page.locator("[data-pin-live] [data-widget-frame]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(EVIDENCE, "spreadsheet-large-1280-dark.png"), fullPage: true });
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("the grid is used from the keyboard, by touch and by mouse, follows both themes, and scrolls inside its card on a phone", async ({ page }) => {
    test.setTimeout(180_000);
    mkdirSync(EVIDENCE, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light" });
    const frame = await openSpreadsheet(page);
    await importFile(page, frame, SOURCE_NAME, "text/csv", SOURCE_CSV);

    const grid = frame.locator("[data-sheet-grid]");
    const address = frame.locator("[data-sheet-address]");
    await expect(grid).toHaveAttribute("role", "grid");
    await grid.focus();
    await expect(grid).toBeFocused();
    await expect(grid).toHaveAttribute("aria-activedescendant", "cell-0-0");

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await expect(address).toHaveText("B2");
    await expect(grid).toHaveAttribute("aria-activedescendant", "cell-1-1");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(address).toHaveText("C3 · B2:C3");
    await expect(frame.locator(".cell[data-cell='B2']")).toHaveAttribute("aria-selected", "true");
    await expect(frame.locator(".cell[data-cell='C3']")).toHaveAttribute("aria-selected", "true");
    await expect(frame.locator(".cell[data-cell='D3']")).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("End");
    await expect(address).toHaveText("D3");
    await page.keyboard.press("Home");
    await expect(address).toHaveText("A3");
    await page.keyboard.press("ArrowRight");
    await expect(address).toHaveText("B3");

    /*
     * The grid is one stop in the tab order. Shift+Tab leaves it for the buttons before it — "Ask Clark" among them —
     * and Tab comes back to it with the cell where it was; Tab from the grid leaves the widget altogether.
     */
    const ask = frame.locator("[data-sheet-ask-format]");
    await expect(ask).toBeEnabled();
    let presses = 0;
    while (!(await ask.evaluate((node) => node === document.activeElement)) && presses < 6) {
      await page.keyboard.press("Shift+Tab");
      presses += 1;
    }
    await expect(ask).toBeFocused();
    for (const name of ["[data-sheet-export='tsv']", "[data-sheet-export='csv']", "[data-sheet-import]"]) {
      await page.keyboard.press("Shift+Tab");
      await expect(frame.locator(name)).toBeFocused();
    }
    for (let step = 0; step < 8 && !(await grid.evaluate((node) => node === document.activeElement)); step += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(grid).toBeFocused();
    await expect(address).toHaveText("B3");
    await expect(frame.locator(".viewport:focus-visible")).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(grid).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName ?? "")).not.toBe("IFRAME");
    await grid.focus();
    await expect(address).toHaveText("B3");

    // F2 edits; Escape leaves the cell as it was; typing starts an edit that Enter commits and moves down.
    await page.keyboard.press("F2");
    const editor = frame.locator("[data-sheet-editor]");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("30");
    await page.keyboard.type("0");
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await expect(grid).toBeFocused();
    await expect(frame.locator(".cell[data-cell='B3']")).toHaveText("30");
    await page.keyboard.type("50");
    await page.keyboard.press("Enter");
    await expect(frame.locator(".cell[data-cell='B3']")).toHaveText("50");
    await expect(frame.locator(".cell[data-cell='B4']")).toHaveText("60");
    await expect(address).toHaveText("B4");
    await page.keyboard.press("Delete");
    await expect(frame.locator(".cell[data-cell='B4']")).toHaveText("");
    await page.keyboard.press("Control+Home");
    await expect(address).toHaveText("A1");

    // Touch has no Shift: "Select range" makes a tap extend the selection from the cell tapped before it.
    await frame.locator(".cell[data-cell='B2']").tap();
    await expect(address).toHaveText("B2");
    const selectRange = frame.locator("[data-sheet-select-range]");
    await selectRange.tap();
    await expect(selectRange).toHaveAttribute("aria-pressed", "true");
    await frame.locator(".cell[data-cell='C3']").tap();
    await expect(address).toHaveText("C3 · B2:C3");
    await expect(frame.locator(".cell[data-cell='C2']")).toHaveAttribute("aria-selected", "true");
    await selectRange.tap();
    await expect(selectRange).toHaveAttribute("aria-pressed", "false");
    await frame.locator(".cell[data-cell='A1']").tap();
    await expect(address).toHaveText("A1");

    // A mouse selects a range by dragging across it.
    const from = await frame.locator(".cell[data-cell='A2']").boundingBox();
    const to = await frame.locator(".cell[data-cell='B4']").boundingBox();
    if (from === null || to === null) throw new Error("the cells to drag across are not on screen");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(address).toHaveText("B4 · A2:B4");
    await page.keyboard.press("Escape");
    await expect(address).toHaveText("B4");

    // Every button is a touch target of at least 40 px.
    for (const button of await frame.locator("button:visible").all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0, (await button.textContent()) ?? "").toBeGreaterThanOrEqual(40);
    }
    await grid.focus();
    await page.keyboard.press("Control+Home");
    await expect(address).toHaveText("A1");

    // The grid is wider than the phone, and it scrolls inside its card: the page itself does not.
    const sizes = await grid.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    expect(sizes.scrollWidth).toBeGreaterThan(sizes.clientWidth);
    for (let step = 0; step < 7; step += 1) await page.keyboard.press("ArrowRight");
    await expect(address).toHaveText("H1");
    expect(await grid.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const frameBox = await page.locator("[data-pin-live] [data-widget-frame] iframe").boundingBox();
    expect(frameBox === null ? Number.POSITIVE_INFINITY : frameBox.x + frameBox.width).toBeLessThanOrEqual(390);

    const overflow: Record<string, number> = {};
    const schemes: Record<string, string | null> = {};
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(frame.locator("html")).toHaveAttribute("data-scheme", colorScheme);
      schemes[colorScheme] = await frame.locator("html").getAttribute("data-scheme");
      // The focus ring is visible against both canvases.
      const ring = await frame.locator(".cell.active").evaluate((node) => getComputedStyle(node).outlineStyle);
      expect(ring).not.toBe("none");
      await page.locator("[data-pin-live] [data-widget-frame]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(EVIDENCE, `spreadsheet-390-${colorScheme}.png`), fullPage: true });
      overflow[`390-${colorScheme}`] = await horizontalOverflow(page);
    }
    test.info().annotations.push({ type: "horizontal-overflow", description: JSON.stringify(overflow) });
    expect(overflow).toEqual({ "390-light": 0, "390-dark": 0 });
    expect(schemes).toEqual({ light: "light", dark: "dark" });
  });
});
