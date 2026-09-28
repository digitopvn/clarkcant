import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A table that honours its whole contract, in a real browser against a real node.
 *
 * Sorting, paging, searching and selecting are decided by shared pure functions that have their own tests; what
 * only a browser can show is that the renderer wires them to controls a person can use, and that the CSV the node
 * writes arrives as a download with its formula cells defused. The table comes from the fixture model: sixty rows
 * in a dataset the person owns, one of whose notes is a spreadsheet formula.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const EVIDENCE = join(process.cwd(), "plans", "reports", "evidence");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`the node did not write its identity to ${path}`, { cause });
  }
  const parsed = JSON.parse(raw) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

/** Opens the app and asks the fixture model for the revenue table. The token is never logged. */
async function openRevenueTable(page: Page): Promise<Locator> {
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("textarea[aria-label='Nhập tin nhắn']")).toBeVisible();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-composer]").click();
  await page.keyboard.type("báo cáo doanh thu");
  await page.keyboard.press("Enter");

  const widget = page
    .locator("[data-widget-role]")
    .filter({ has: page.locator("[data-sort-column='revenue']") })
    .last();
  await expect(widget).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-fallback='true']")).toHaveCount(0);
  return widget;
}

const bodyRows = (widget: Locator) => widget.locator("tbody tr[data-row-id]");
const revenueHeader = (widget: Locator) =>
  widget.locator("th").filter({ has: widget.page().locator("[data-sort-column='revenue']") });
/** A UTF-8 byte order mark, which the node writes first so a spreadsheet reads the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

test("a table sorts, pages, searches, selects and exports a CSV with its formulas defused", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const widget = await openRevenueTable(page);

  // One page of ten, of sixty rows, with the page named in words and the totals under it.
  await expect(bodyRows(widget)).toHaveCount(10);
  await expect(widget.locator("[data-table-page-status]")).toHaveText("Trang 1/6 · 60 dòng");
  await expect(widget.locator("[data-total-fn='sum']")).toBeVisible();
  await expect(widget.locator("[data-total-fn='avg']")).toBeVisible();

  // Sorting from a header, by pointer and by keyboard. Revenue is 100 + (i * 73 mod 900), so the smallest is the
  // first row (P01, 100) and the largest is row 50 (P50, 977).
  await expect(revenueHeader(widget)).toHaveAttribute("aria-sort", "none");
  await widget.locator("[data-sort-column='revenue']").click();
  await expect(revenueHeader(widget)).toHaveAttribute("aria-sort", "ascending");
  await expect(bodyRows(widget).first()).toHaveAttribute("data-row-id", "P01");
  await widget.locator("[data-sort-column='revenue']").focus();
  await page.keyboard.press("Enter");
  await expect(revenueHeader(widget)).toHaveAttribute("aria-sort", "descending");
  await expect(bodyRows(widget).first()).toHaveAttribute("data-row-id", "P50");

  // Paging keeps the sort, and the previous button is only usable once there is a page before this one.
  await expect(widget.locator("[data-table-page='previous']")).toBeDisabled();
  await widget.locator("[data-table-page='next']").click();
  await expect(widget.locator("[data-table-page-status]")).toHaveText("Trang 2/6 · 60 dòng");
  await expect(bodyRows(widget)).toHaveCount(10);
  await expect(widget.locator("[data-table-page='previous']")).toBeEnabled();

  await page.screenshot({ path: join(EVIDENCE, "table-contract-01-desktop-sorted-page-2.png"), fullPage: true });

  // Multi-select through checkboxes: two rows, then the whole page, then the page cleared again.
  const firstCheck = bodyRows(widget).nth(0).locator("input[type='checkbox']");
  const secondCheck = bodyRows(widget).nth(1).locator("input[type='checkbox']");
  await firstCheck.check();
  await secondCheck.check();
  await expect(bodyRows(widget).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(widget.locator("[data-table-selected-count]")).toHaveText("Đã chọn 2 dòng");
  await widget.locator("[data-table-select-page]").check();
  await expect(widget.locator("[data-table-selected-count]")).toHaveText("Đã chọn 10 dòng");
  await widget.locator("[data-table-select-page]").uncheck();
  // Cleared: the live region stays in place, empty, rather than announcing "0 rows selected".
  await expect(widget.locator("[data-table-selected-count='0']")).toHaveText("");
  await secondCheck.check();

  // Search ignores diacritics and goes back to the first page: five rows are "Đồng Nai 1" to "Đồng Nai 5".
  await widget.locator("[data-table-search]").fill("dong nai");
  await expect(widget.locator("[data-table-page-status]")).toHaveText("Trang 1/1 · 5 dòng");
  await expect(bodyRows(widget)).toHaveCount(5);
  await expect(widget.locator("tbody")).toContainText("Đồng Nai 1");

  await page.screenshot({ path: join(EVIDENCE, "table-contract-02-desktop-search-selection.png"), fullPage: true });

  // Export: the node writes the file for the view on screen, and the browser receives it as a download.
  const exportButton = widget.locator("[data-table-export]");
  await expect(exportButton).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent("download"), exportButton.click()]);
  expect(download.suggestedFilename()).toBe("doanh-thu-theo-tinh-fixture.csv");
  const path = await download.path();
  const raw = readFileSync(path, "utf8");
  expect(raw.startsWith(BOM)).toBe(true);
  const csv = raw.slice(BOM.length);
  const lines = csv.split("\r\n");
  expect(lines[0]).toBe("Tỉnh,Doanh thu,Tăng trưởng,Cập nhật,Ghi chú");
  // Header, the five matching rows, and the empty string after the final line break.
  expect(lines).toHaveLength(7);
  // The formula arrives as text a spreadsheet will not run, and no cell anywhere starts with one.
  expect(csv).toContain(`"'=HYPERLINK(""http://example.invalid"",""xem"")"`);
  expect(csv).not.toMatch(/(^|[\n,])"?[=+@]/);
  await expect(widget.locator("[data-table-export-done]")).toBeVisible();

  await page.screenshot({ path: join(EVIDENCE, "table-contract-03-desktop-exported.png"), fullPage: true });
});

test("the table stays usable on a phone-sized screen", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const widget = await openRevenueTable(page);

  await expect(widget.locator("[data-table-page-status]")).toHaveText("Trang 1/6 · 60 dòng");
  await widget.locator("[data-table-page='next']").click();
  await expect(widget.locator("[data-table-page-status]")).toHaveText("Trang 2/6 · 60 dòng");

  // The widget never makes anything around it scroll sideways: wide columns scroll inside the table's own region.
  // Every element wider than its box is named, so a failure says which one pushed the layout.
  const widened = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        if (element.closest(".cc-table-scroll") !== null) return false;
        const style = getComputedStyle(element);
        if (style.overflowX === "visible" || style.overflowX === "clip" || style.overflowX === "hidden") return false;
        return element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")} ${String(element.scrollWidth)}>${String(element.clientWidth)}`),
  );
  expect(widened).toEqual([]);
  const box = await widget.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(390);

  await widget.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(EVIDENCE, "table-contract-04-mobile.png"), fullPage: true });
});
