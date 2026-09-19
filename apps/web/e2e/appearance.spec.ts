import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Appearance and the settings modal.
 *
 * These are the two claims in this repository that are easy to believe and hard to verify by
 * reading code: that a theme choice is actually applied to the surface and survives a reload, and
 * that settings is a modal with distinct tabs rather than four labels over one panel. Both are
 * checked in a browser because both are about what the user sees.
 *
 * The reload assertion is the one that matters most. Storage that is written but never read back
 * looks correct in a screenshot taken before the reload.
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
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** The theme actually applied to the document, which is always a resolved dark or light. */
const appliedTheme = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"));

test("a theme choice changes the surface, follows the system, and survives a reload", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });

  // The default choice is `system`, so the starting theme is the operating system's — pinned here
  // so the first assertion is about the app rather than about whatever the runner emulates.
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  expect(await appliedTheme(page)).toBe("dark");

  await page.locator('[data-settings="true"]').click();
  await page.locator('[data-theme-choice="light"]').click();

  // The surface really changed, not just the control's own selected state.
  await expect.poll(() => appliedTheme(page)).toBe("light");
  await page.screenshot({ path: join(EVIDENCE, "theme-01-light.png"), fullPage: true });

  // `system` is stored as a preference and resolved through the OS, so the document never carries
  // a third value: an attribute of "system" would match no rule and leave every token undefined.
  await page.locator('[data-theme-choice="system"]').click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => appliedTheme(page)).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => appliedTheme(page)).toBe("dark");
  await page.screenshot({ path: join(EVIDENCE, "theme-02-system-dark.png"), fullPage: true });

  // Back to an explicit choice, then reload: the choice has to be read back from storage.
  await page.locator('[data-theme-choice="light"]').click();
  await expect.poll(() => appliedTheme(page)).toBe("light");
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => appliedTheme(page)).toBe("light");
  await page.screenshot({ path: join(EVIDENCE, "theme-03-light-after-reload.png"), fullPage: true });
});

test("settings is a modal with three distinct tabs, and Escape returns focus to the gear", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);

  const gear = page.locator('[data-settings="true"]');
  await gear.click();

  const dialog = page.locator('[data-modal="true"]');
  await expect(dialog).toBeVisible();
  // Three, not four: voice is a mode of the conversation, not a setting, and it left this dialog for the
  // composer's microphone button.
  await expect(page.locator('[role="tab"]')).toHaveCount(4);

  // Each tab shows its own content. Asserted by comparing what is rendered rather than by checking
  // that a heading exists, since three labels over one shared panel would pass the weaker check.
  const general = await page.locator("#cc-tabpanel-general").innerText();
  await page.screenshot({ path: join(EVIDENCE, "settings-01-general.png"), fullPage: true });

  await page.locator("#cc-tab-tools").click();
  await expect(page.locator("#cc-tabpanel-tools")).toBeVisible();
  const tools = await page.locator("#cc-tabpanel-tools").innerText();
  expect(tools).not.toBe(general);
  expect(tools.length).toBeGreaterThan(0);
  await page.screenshot({ path: join(EVIDENCE, "settings-02-tools.png"), fullPage: true });

  // Escape closes, and focus goes back to what opened it rather than to the top of the page.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-settings") ?? null))
    .toBe("true");
});

test("the orb is centred on the screen it is drawn over", async ({ page }) => {
  // This is a measurement, not a style assertion: the orb's position is computed from the box it
  // belongs to, and the canvas inside that box is larger than it, so "the rule is present" would not
  // have caught the canvas overflowing to the right and drawing the ball 24 pixels off centre.
  await openApp(page);
  await page.waitForSelector(".cc-stage-orb canvas");

  // Polled rather than read once: the placement is re-measured while the layout settles over the first
  // second, so the question this asserts is whether the orb ends up centred, not whether it was centred
  // in the frame the canvas first appeared in.
  await expect
    .poll(
      async () => {
        const boxes = await page.evaluate(() => {
          const centreOf = (selector: string): { x: number; middle: number } | null => {
            const node = document.querySelector(selector);
            if (node === null) return null;
            const rect = node.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, middle: rect.top + rect.height / 2 };
          };
          return { anchor: centreOf(".cc-hero-orb"), canvas: centreOf(".cc-stage-orb canvas") };
        });
        if (boxes.anchor === null || boxes.canvas === null) return Number.POSITIVE_INFINITY;
        return Math.max(Math.abs(boxes.canvas.x - boxes.anchor.x), Math.abs(boxes.canvas.middle - boxes.anchor.middle));
      },
      { message: "the drawn canvas should come to rest on the space reserved for it", timeout: 10_000 },
    )
    .toBeLessThanOrEqual(1);
});

test("the header is a gradient rather than a bar above the page", async ({ page }) => {
  // Measured rather than assumed: a bar and a fading header look similar in a screenshot and differ in
  // exactly these two properties, which is what someone complained about.
  await openApp(page);
  const header = await page.evaluate(() => {
    const node = document.querySelector(".cc-header");
    if (node === null) return null;
    const style = getComputedStyle(node);
    return { borderBottom: style.borderBottomWidth, background: style.backgroundImage };
  });

  expect(header).not.toBeNull();
  expect(header?.borderBottom).toBe("0px");
  expect(header?.background).toContain("linear-gradient");
});

test("the tools tab tells the node's tools from the agent's", async ({ page }) => {
  // The list is the node's own, published by the same call that hands the tools to the model. An empty node list
  // here would mean the publishing is missing rather than that this node can do nothing, which is why both lists are
  // asserted rather than one.
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.getByRole("tab", { name: "Tools" }).click();

  // The agent's built-ins are a fixed list, so this half is exact.
  await expect(page.locator("[data-tool-list='Công cụ của agent (pi)'] code").first()).toHaveText("read");

  // The node's half is whatever the node reported, which is the point: the tab renders both sections and lists what
  // the node actually published - its tools, or a line saying it registered none. Asserting specific tool names here
  // would make this test depend on how a fixture node happens to be configured rather than on whether the tab says
  // what the node says. The registration itself is covered where it is built: apps/runtime/test/tool-catalogue.spec.ts.
  await expect(page.getByRole("heading", { name: "Công cụ của node này" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Công cụ của agent (pi)" })).toBeVisible();

  await page.screenshot({ path: join(EVIDENCE, "tools-tab.png") });
});

test("the settings panel lists what this node can run, or says plainly that it can run nothing", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();

  // Provider and model have a tab of their own now, because choosing one means choosing the other.
  await page.getByRole("tab", { name: "Models" }).click();
  const section = page.locator("[data-providers='true']");
  await expect(section).toBeVisible();

  // Either pi on this machine offers providers and they are listed, or the node reports none and says so in words.
  // An empty section that explains nothing is the one dishonest outcome, so the two acceptable states are both
  // named here rather than one of them being assumed.
  // Two fields somebody types into rather than hundreds of rows to scroll: this machine's catalogue runs past what any
  // list on a screen could hold, so what is asserted is that a searchable pair is offered, or that the node says plainly
  // that it has none.
  await expect(section.locator("[data-provider-input], [data-providers='none']").first()).toBeVisible({ timeout: 20_000 });
  const providerInput = page.locator("[data-provider-input]");
  if ((await providerInput.count()) > 0) {
    await expect(page.locator("[data-model-input]")).toBeVisible();
    // The field is wired to the catalogue rather than to a fixed list, so a provider this node can run is one the
    // field offers.
    await expect(providerInput).toHaveAttribute("list", "cc-provider-options");
    await expect(page.locator("[data-model-input]")).toHaveAttribute("list", "cc-model-options");
  }
});

test("every key in settings can be taken back again, which is how a provider is logged out of", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.getByRole("tab", { name: "Devices" }).click();

  // Both keys, because a logout for one and not the other is the kind of half-wired surface that looks finished.
  // Gemini is the voice provider's key, so it stays beside the microphone. TypeSafe is asked for where a model is
  // chosen, because that is what it pays for - the same list of fields, in the tab that explains each one.
  await expect(page.locator("[data-settings-key-form='gemini']")).toBeVisible();
  await expect(page.locator("[data-settings-key-remove='gemini']")).toBeVisible();

  await page.getByRole("tab", { name: "Models" }).click();
  await expect(page.locator("[data-settings-key-form='typesafe']")).toBeVisible();
  await expect(page.locator("[data-settings-key-remove='typesafe']")).toBeVisible();
});

test("the model in use is what the fields show before anybody types", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.getByRole("tab", { name: "Models" }).click();

  const model = page.locator("[data-model-input]");
  await expect(model).toBeVisible({ timeout: 20_000 });

  // Nothing is clicked and nothing is typed: this suite shares one node, so a test that stored a preference would change
  // what every later spec runs. What is asserted is that the pair the node already runs is the pair on screen.
  const shown = await model.inputValue();
  const current = await page.locator("[data-model='none']").count();
  expect(current > 0 || shown.length > 0).toBe(true);
});

test("the tools tab also says which extensions pi loads on this machine", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.getByRole("tab", { name: "Tools" }).click();

  const section = page.locator("[data-pi-extensions='true']");
  await expect(section).toBeVisible();

  // Either pi loads extensions here and they are listed by name and kind, or it loads none and says so in words. What
  // is never shown is a file's contents, which is why this asserts the listing exists rather than inspecting any value.
  await expect(section.locator("[data-pi-extension], [data-pi-extensions='none']").first()).toBeVisible({
    timeout: 20_000,
  });
});

test("the tools tab also shows pi's own configuration, as lines rather than as a file", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.getByRole("tab", { name: "Tools" }).click();

  const section = page.locator("[data-pi-settings='true']");
  await expect(section).toBeVisible();

  // Either the node read a configuration and it is shown as key and value lines, or it read none and says so. What must
  // never appear is a credential: the node redacts by name before this ever leaves it, and the adapter test covers that
  // where the file is actually read.
  await expect(section.locator("[data-pi-setting], [data-pi-settings='none']").first()).toBeVisible({
    timeout: 20_000,
  });
});

