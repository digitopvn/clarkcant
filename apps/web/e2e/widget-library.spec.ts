import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The Widget Library and the Widget Lab, in a browser.
 *
 * The claims here are the ones that cannot be checked by reading the source.
 *
 *   - The library is a surface *beside* the conversation, not a destination that replaces it. AGENTS.md
 *     allows the conversation to remain the primary surface, so the composer has to still be mounted
 *     while the library is open.
 *   - A preview is the production renderer. The way to check that is not to look for a class name but
 *     to check that the *unavailable* path, which only the real renderer emits, is absent for a widget
 *     whose dataset the fixture supplies.
 *   - Browsing the catalog must not fetch third-party media. The media widgets exist in the catalog, so
 *     "no request to YouTube while browsing" is a real claim about what browsing mounts.
 *   - Keyboard and focus. Escape has to close the nearest dismissible surface and put focus back where
 *     it came from, and the opener here has unmounted by then, which is the case that is easy to get
 *     wrong.
 *   - A typed command and the buttons reach the same surface.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

/** Hosts that only a mounted media widget would reach. */
const MEDIA_HOSTS = ["youtube.com", "ytimg.com", "googlevideo.com", "youtu.be"];

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** Settings → Extensions, which is where browsing belongs: it is not a navigation destination. */
async function openExtensions(page: Page): Promise<void> {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-extensions")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-extensions").click();
}

async function openLibraryFromExtensions(page: Page): Promise<void> {
  await openExtensions(page);
  await page.locator("[data-widget-library-open='browse']").click();
  await expect(page.locator("[data-widget-library='true']")).toBeVisible({ timeout: 20_000 });
}

test("the library opens from Extensions and the conversation stays mounted", async ({ page }) => {
  await openLibraryFromExtensions(page);

  // Opened in browse mode, which is the catalogue rather than the developer inspector.
  await expect(page.locator("[data-widget-library='true']")).toHaveAttribute("data-widget-library-mode", "browse");

  /*
   * Settings closed itself before the library opened. Two open dialogs would each install their own
   * document-level Escape handler and focus trap, so one Escape would close both and Tab would be
   * trapped behind the library.
   */
  await expect(page.locator("#cc-tab-extensions")).toHaveCount(0);

  /*
   * The conversation is still mounted, not unmounted and restored. This is the difference between a
   * surface beside the conversation and a navigation destination that replaces it, and the product
   * model only allows the former.
   */
  await expect(page.locator("[data-composer='true']")).toHaveCount(1);
});

test("every catalog card previews through the production renderer", async ({ page }) => {
  await openLibraryFromExtensions(page);

  const cards = page.locator("[data-widget-grid] [data-widget-card]");
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);

  const ids = await cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-widget-card") ?? ""),
  );

  for (const id of ids) {
    await page.locator(`[data-widget-card='${id}']`).click();

    // The detail view names the definition it is showing, so a card cannot silently open a different one.
    await expect(page.locator(`[data-widget-detail='${id}']`)).toBeVisible({ timeout: 20_000 });

    /*
     * Either the definition renders through the real renderer, or the surface says why it cannot. What
     * is not allowed is a card that opens onto nothing, which is why "no preview and no explanation"
     * is the failing case rather than a missing preview on its own.
     */
    const rendered = page.locator(`[data-widget-preview='${id}']`);
    const missing = page.locator(`[data-widget-preview-missing='${id}']`);
    await expect(rendered.or(missing)).toHaveCount(1);

    await page.locator("[data-widget-library-back]").click();
    await expect(page.locator("[data-widget-grid]")).toBeVisible({ timeout: 20_000 });
  }
});

test("a data-backed widget renders instead of reporting its dataset unavailable", async ({ page }) => {
  await openLibraryFromExtensions(page);

  /*
   * The table reads rows from the `dataset` prop. Its fixture binds a dataset, so if the preview wired
   * the fixture through correctly the renderer has data and never emits the unavailable path. A
   * screenshot could not tell this apart from a renderer that drew an empty table.
   */
  await page.locator("[data-widget-card='canvas.table@1']").click();
  await expect(page.locator("[data-widget-detail='canvas.table@1']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-preview='canvas.table@1']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-preview='canvas.table@1'] [data-widget-unavailable='true']")).toHaveCount(0);
});

test("browsing the catalog does not fetch third-party media", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    requested.push(request.url());
  });

  await openLibraryFromExtensions(page);

  /*
   * The media widgets are in the catalog, so this is not a vacuous check: it asserts that browsing
   * mounts a text alternative rather than the embed. Displaying the catalogue must not contact a third
   * party on the person's behalf.
   */
  await page.locator("[data-widget-card='canvas.youtube@1']").click();
  await expect(page.locator("[data-widget-detail='canvas.youtube@1']")).toBeVisible({ timeout: 20_000 });

  const thirdParty = requested.filter((url) => MEDIA_HOSTS.some((host) => url.includes(host)));
  expect(thirdParty, `unexpected third-party requests: ${thirdParty.join(", ")}`).toEqual([]);
});

test("the Lab shows developer controls that actually change the preview", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-developer")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-developer").click();
  await page.locator("[data-widget-library-open='develop']").click();

  await expect(page.locator("[data-widget-library='true']")).toHaveAttribute("data-widget-library-mode", "develop");

  /*
   * The controls belong to a selected widget, so a card is chosen first. A Lab that showed fixture and
   * viewport controls for nothing would be a control that looks usable before its subject exists.
   */
  await page.locator("[data-widget-card='canvas.table@1']").click();
  await expect(page.locator("[data-widget-detail='canvas.table@1']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-lab-controls='true']")).toBeVisible({ timeout: 20_000 });

  const frame = page.locator("[data-widget-preview-frame]");
  await expect(frame).toBeVisible({ timeout: 20_000 });

  // The viewport control changes the frame's width, which is the whole point of having it.
  await page.locator("[data-widget-lab-viewport='true']").selectOption("320");
  await expect(frame).toHaveCSS("width", "320px");

  /*
   * Reduced motion and theme are scoped attributes on the preview frame rather than global settings,
   * so a developer can check a widget's dark and reduced-motion rendering without changing the
   * person's own preferences. The scoping is what makes that true, so the scoping is what is asserted.
   */
  await page.locator("[data-widget-lab-reduced-motion='true']").check();
  await expect(page.locator("[data-widget-preview-frame][data-cc-reduced-motion='true']")).toHaveCount(1);

  await page.locator("[data-widget-lab-theme='true']").selectOption("dark");
  await expect(page.locator("[data-widget-preview-frame][data-cc-theme='dark']")).toHaveCount(1);

  /*
   * At a desktop width the Lab shows the preview and the inspector together, so the inspector is part
   * of the same surface rather than a second screen.
   */
  await expect(page.locator("[data-widget-inspector='true']")).toBeVisible({ timeout: 20_000 });
  expect(await page.locator("[data-inspector-panel]").count()).toBeGreaterThan(0);

  /*
   * Narrow, three compressed columns is a layout nobody can read, so the Lab steps between the two
   * panes instead and the toggle only exists at that width - which is why it is checked after resizing.
   * Asserted on the pane attribute rather than on visibility, because which pane is showing is the state
   * the control actually owns.
   */
  await page.setViewportSize({ width: 760, height: 800 });
  const toggle = page.locator("[data-widget-lab-pane-toggle='true']");
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  const detail = page.locator("[data-widget-detail='canvas.table@1']");
  await expect(detail).toHaveAttribute("data-widget-lab-pane", "preview");
  await toggle.click();
  await expect(detail).toHaveAttribute("data-widget-lab-pane", "inspector");
});

test("Escape closes the library and focus returns to the control that opened it", async ({ page }) => {
  await openExtensions(page);

  const browse = page.locator("[data-widget-library-open='browse']");
  await browse.focus();
  await browse.press("Enter");
  await expect(page.locator("[data-widget-library='true']")).toBeVisible({ timeout: 20_000 });

  await page.keyboard.press("Escape");
  await expect(page.locator("[data-widget-library='true']")).toHaveCount(0);

  /*
   * The Browse button has unmounted, because Settings closed. Focus has to land somewhere real rather
   * than on a detached node: it falls back to the anchor the gear carries.
   */
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-widget-library-anchor") ?? null))
    .toBe("true");
});

test("a typed command opens the same library surface", async ({ page }) => {
  await openApp(page);

  // Typed text and the Browse button reach one surface through one intent path, not two implementations.
  const composer = page.locator("[data-composer='true']");
  await composer.fill("mở thư viện widget");
  await composer.press("Enter");

  await expect(page.locator("[data-widget-library='true']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-grid]")).toBeVisible({ timeout: 20_000 });
});

test("installed packages are reported as provenance, never as catalog cards", async ({ page }) => {
  await openLibraryFromExtensions(page);

  // The built-in catalogue is labelled as built in rather than given a version it does not have.
  await expect(page.locator("[data-widget-provenance='built-in']")).toBeVisible({ timeout: 20_000 });

  const installed = page.locator("[data-widget-provenance='installed']");
  await expect(installed).toBeVisible({ timeout: 20_000 });

  /*
   * The installed list resolves to one of three honest states, and never to a row that stands for
   * nothing. "Could not read" is kept apart from "nothing is installed", because an empty list would
   * make a claim the node did not make.
   */
  await expect(installed.locator("[data-provenance-state='loading']")).toHaveCount(0);

  const rows = installed.locator("[data-installed-package]");
  const rowCount = await rows.count();
  if (rowCount === 0) {
    const emptyOrUnread =
      (await installed.locator("[data-provenance-state='empty']").count()) +
      (await installed.locator("[data-provenance-state='unread']").count());
    expect(emptyOrUnread).toBe(1);
  } else {
    // A card is keyed by definition id, so a package id is never a card, however the package was installed.
    await expect(page.locator("[data-widget-card='clark.notes']")).toHaveCount(0);
  }
});

test("an installed package's widget becomes a card, rendered by the catalog", async ({ page }) => {
  /*
   * The whole installed lane, end to end: a package whose bytes are on this machine is installed, its definition is
   * read from disk, and its widget appears as a card that renders through the catalog's own renderer.
   *
   * The package declares `canvas.line@1` on purpose. A renderer owns that id but the catalog lists no entry for it,
   * so the card can only exist because a package declared it. A package re-declaring a widget the catalog already
   * lists is reported as a duplicate instead, which is a different claim.
   */
  const install = await fetch(`${GATEWAY}/packages/install`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({
      packageId: "com.example.chart-widget",
      version: "1.0.0",
      // A local package has no published digest, so the caller hashes it and the digest becomes its identity. The
      // route requires one, and without it the honest answer is LOCAL_DIGEST_REQUIRED.
      localDigest: "sha256:chart-widget-digest",
    }),
  });
  expect(install.ok, `install answered ${String(install.status)}: ${await install.text()}`).toBe(true);

  await openLibraryFromExtensions(page);

  /*
   * The card id is namespaced by the package, because every definition id a renderer can draw is already a catalog
   * entry: without the namespace this card could not exist, and the catalog's own entry would win the id.
   */
  const card = page.locator("[data-widget-card='com.example.chart-widget/canvas.line@1']");
  await expect(card).toBeVisible({ timeout: 20_000 });
  // Labelled for what it is rather than mixed in with the built-ins.
  await expect(card).toContainText("Local development package");
  // And the catalog's own card for the same definition is still there, rather than being replaced by the package's.
  await expect(page.locator("[data-widget-card='canvas.line@1']")).toBeVisible();

  await card.click();
  await expect(page.locator("[data-widget-detail='com.example.chart-widget/canvas.line@1']")).toBeVisible({
    timeout: 20_000,
  });

  /*
   * The renderer has data. This is the assertion the dataset path exists for: without the package's dataset file the
   * same card would draw the "no data" path, which still looks like a widget in a screenshot.
   */
  const preview = page.locator("[data-widget-preview='com.example.chart-widget/canvas.line@1']");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview.locator("[data-widget-unavailable='true']")).toHaveCount(0);
});
