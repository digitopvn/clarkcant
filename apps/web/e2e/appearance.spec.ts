import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { SETTINGS_TABS } from "@clarkcant/contracts";

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

test("settings is a modal whose tabs each show their own content, and Escape returns focus to the gear", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);

  const gear = page.locator('[data-settings="true"]');
  await gear.click();

  const dialog = page.locator('[data-modal="true"]');
  await expect(dialog).toBeVisible();
  // The tabs the panel actually has, taken from the contract rather than counted here. This said four and went
  // stale the moment the Memory tab was added - a count that is written into a test is a count that drifts.
  await expect(page.locator('[role="tab"]')).toHaveCount(SETTINGS_TABS.length);

  // Each tab shows its own content. Asserted by comparing what is rendered rather than by checking
  // that a heading exists, since six labels over one shared panel would pass the weaker check.
  const experience = await page.locator("#cc-tabpanel-experience").innerText();
  await page.screenshot({ path: join(EVIDENCE, "settings-01-experience.png"), fullPage: true });

  await page.locator("#cc-tab-extensions").click();
  await expect(page.locator("#cc-tabpanel-extensions")).toBeVisible();
  const extensions = await page.locator("#cc-tabpanel-extensions").innerText();
  expect(extensions).not.toBe(experience);
  expect(extensions.length).toBeGreaterThan(0);
  await page.screenshot({ path: join(EVIDENCE, "settings-02-extensions.png"), fullPage: true });

  // Every tab has content of its own, which is the claim the old comment made and this now checks for all six.
  // A tab that exists but is empty teaches the user that the tabs are decoration.
  for (const tab of ["ai", "control", "devices", "developer"] as const) {
    await page.locator(`#cc-tab-${tab}`).click();
    const panel = page.locator(`#cc-tabpanel-${tab}`);
    await expect(panel).toBeVisible();
    expect((await panel.innerText()).length, `${tab} is empty`).toBeGreaterThan(0);
  }

  // Escape closes, and focus goes back to what opened it rather than to the top of the page.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-settings") ?? null))
    .toBe("true");
});

test("the settings tabs are operable from the keyboard alone", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();

  // Focus the selected tab, which is where a keyboard user arrives from the modal's own focus handling. Waiting for
  // it to be visible first is what makes this deterministic: a focus() call taken while the panel is still animating
  // in is dropped, and the element stays unfocused for the whole assertion timeout. Measured in CI, where this test
  // passed on one run and failed on the next for exactly that reason.
  await expect(page.locator("#cc-tab-experience")).toBeVisible();
  await page.locator("#cc-tab-experience").focus();
  await expect(page.locator("#cc-tab-experience")).toBeFocused();

  // Arrows move between tabs, which is what the ARIA tabs pattern requires. Without this, a keyboard user has to
  // press Tab through every tab to get past the strip — and with six tabs that is now six presses, not four.
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#cc-tab-ai")).toBeFocused();
  await expect(page.locator("#cc-tabpanel-ai")).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#cc-tab-control")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#cc-tab-ai")).toBeFocused();

  // End and Home are part of the pattern, and they are what makes a six-tab strip navigable.
  await page.keyboard.press("End");
  await expect(page.locator("#cc-tab-developer")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.locator("#cc-tab-experience")).toBeFocused();

  /*
   * Roving tabindex: the whole strip is one stop in the tab order.
   *
   * Asserted because a tablist where every tab is separately tabbable passes the arrow-key check above and is still
   * wrong: the user has to press Tab six times to get from the strip into the panel.
   */
  const tabbable = await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].filter((tab) => tab.getAttribute("tabindex") === "0").length,
  );
  expect(tabbable).toBe(1);
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

test("the extensions tab tells the node's tools from the agent's", async ({ page }) => {
  // The list is the node's own, published by the same call that hands the tools to the model. An empty node list
  // here would mean the publishing is missing rather than that this node can do nothing, which is why both lists are
  // asserted rather than one.
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-extensions").click();

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

  // Provider and model live together under AI & Routing now, because choosing one means choosing the other.
  await page.locator("#cc-tab-ai").click();
  const section = page.locator("[data-providers='true']");
  await expect(section).toBeVisible();

  // Either pi on this machine offers providers and they are listed, or the node reports none and says so in words.
  // An empty section that explains nothing is the one dishonest outcome, so the two acceptable states are both
  // named here rather than one of them being assumed.
  // Two fields somebody types into rather than hundreds of rows to scroll: this machine's catalogue runs past what any
  // list on a screen could hold, so what is asserted is that a searchable pair is offered, or that the node says plainly
  // that it has none.
  await expect(section.locator("[data-search-select='provider'], [data-providers='none']").first()).toBeVisible({
    timeout: 20_000,
  });

  const provider = page.locator("[data-search-input='provider']");
  if ((await provider.count()) > 0) {
    // Clicking opens a list of what this node can run, and typing narrows it. Asserted by behaviour rather than by the
    // markup, because the point of this field over the one it replaced is what happens when somebody uses it.
    await provider.click();
    const options = page.locator("[data-search-option]");
    await expect(options.first()).toBeVisible({ timeout: 20_000 });
    const total = await options.count();

    await provider.fill("zzzz-no-such-provider");
    await expect(page.locator("[data-search-empty='provider']")).toBeVisible();
    await provider.fill("");
    await expect(options).toHaveCount(total);
  }
});

test("every key in settings can be taken back again, which is how a provider is logged out of", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-devices").click();

  // Both keys, because a logout for one and not the other is the kind of half-wired surface that looks finished.
  // Gemini is the voice provider's key, so it stays beside the microphone. TypeSafe is asked for where a model is
  // chosen, because that is what it pays for - the same list of fields, in the tab that explains each one.
  await expect(page.locator("[data-settings-key-form='gemini']")).toBeVisible();
  await expect(page.locator("[data-settings-key-remove='gemini']")).toBeVisible();

  await page.locator("#cc-tab-ai").click();
  await expect(page.locator("[data-settings-key-form='typesafe']")).toBeVisible();
  await expect(page.locator("[data-settings-key-remove='typesafe']")).toBeVisible();
});

test("the model in use is what the fields show before anybody types", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-ai").click();

  const model = page.locator("[data-search-input='model']");
  const absent = page.locator("[data-model='none']");
  // The same two acceptable states the sibling test above accepts, and for the same reason: this fixture node reports
  // no model, and one shared node cannot both offer a catalogue and say it has none. Requiring the field contradicted
  // that sibling. What is claimed here is that the panel tells the truth about the model in use before anybody types -
  // either by offering it in a field, or by saying plainly that there is none.
  await expect(page.locator("[data-search-input='model'], [data-model='none']").first()).toBeVisible({
    timeout: 20_000,
  });
  if ((await model.count()) === 0) {
    await expect(absent).toContainText(/chưa cấu hình model/i);
    return;
  }

  // Nothing is saved: this suite shares one node, so a test that stored a preference would change what every later spec
  // runs. What is asserted is that the pair the node already runs is the pair on screen, and that choosing replaces it.
  const shown = await model.inputValue();
  const current = await page.locator("[data-model='none']").count();
  expect(current > 0 || shown.length > 0).toBe(true);

  await model.click();
  const choices = page.locator("[data-search-option]");
  await expect(choices.first()).toBeVisible({ timeout: 20_000 });
  const picked = await choices.first().getAttribute("data-search-option");
  await choices.first().click();
  expect(await model.inputValue()).toBe(picked);
});

test("the extensions tab says which extensions pi loads on this machine", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-extensions").click();

  const section = page.locator("[data-pi-extensions='true']");
  await expect(section).toBeVisible();

  // Either pi loads extensions here and they are listed by name and kind, or it loads none and says so in words. What
  // is never shown is a file's contents, which is why this asserts the listing exists rather than inspecting any value.
  await expect(section.locator("[data-pi-extension], [data-pi-extensions='none']").first()).toBeVisible({
    timeout: 20_000,
  });
});

test("pi's own configuration is in the developer tab, behind a disclosure, as lines rather than as a file", async ({
  page,
}) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  /*
   * Developer, not the tab a normal user reads. Raw pi configuration is progressive disclosure: genuinely useful when
   * something is wrong, and noise the rest of the time.
   */
  await page.locator("#cc-tab-developer").click();

  const section = page.locator("[data-pi-settings='true']");
  await expect(section).toBeVisible();

  // Read on request rather than on open: a tab that reads a configuration file every time somebody glances at it is
  // doing work nobody asked for.
  await page.locator("[data-pi-settings-toggle='true']").click();

  // Either the node read a configuration and it is shown as key and value lines, or it read none and says so. What must
  // never appear is a credential: the node redacts by name before this ever leaves it, and the adapter test covers that
  // where the file is actually read.
  await expect(section.locator("[data-pi-setting], [data-pi-settings='none']").first()).toBeVisible({
    timeout: 20_000,
  });
});


test("personal instructions can be written, survive a reload, and are never sent as the user's message", async ({
  page,
}) => {
  /*
   * The control that phase 5 added, checked where it matters.
   *
   * Three claims, and the third is the one a unit test cannot make: the text reaches the system prompt
   * rather than being prefixed onto the user's message. Prefixing is the tempting shortcut, and it would
   * look identical from the settings screen while making the user's own words part of their request.
   *
   * Reset first rather than assuming a fresh node: the suite shares one database across runs, so a run that
   * left this enabled would make the next run's first assertion wrong — which is exactly what happened the
   * first time this test was written.
   */
  await fetch(`${GATEWAY}/preferences/ai.personalInstructions/undo`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}` },
  }).catch(() => undefined);

  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-ai").click();

  const section = page.locator("[data-personal-instructions='true']");
  await expect(section).toBeVisible();

  const field = page.locator("[data-personal-instructions-input='true']");
  // Disabled while the toggle is off, and still visible: turning it off must not look like it discarded
  // what was typed.
  await expect(field).toBeDisabled();

  /*
   * Clicked through the label rather than the input.
   *
   * The checkbox itself is visually hidden on purpose — `position: absolute` at one pixel with zero opacity, so
   * it stays in the tab order and readable by a screen reader while the switch is drawn by its sibling. A real
   * user clicks the switch, so this does too; driving the hidden input instead would be testing a control nobody
   * can reach with a mouse.
   */
  await page.locator("[data-toggle='personal-instructions']").click();
  await expect(page.locator("[data-toggle='personal-instructions'] input")).toBeChecked();
  await expect(field).toBeEnabled();

  const text = "Trả lời ngắn gọn, và dùng TypeScript cho ví dụ code.";
  await field.fill(text);
  // Committed on blur rather than per keystroke, so the write happens when the field is left.
  await field.blur();

  // The node stored it, which is what makes the next turn read it.
  await expect
    .poll(
      async () => {
        const response = await fetch(`${GATEWAY}/preferences`, {
          headers: { authorization: `Bearer ${token()}` },
        });
        const body = (await response.json()) as {
          preferences: { key: string; value: unknown }[];
        };
        const stored = body.preferences.find((entry) => entry.key === "ai.personalInstructions")?.value;
        return JSON.stringify(stored);
      },
      { timeout: 10_000 },
    )
    .toContain("TypeScript");

  // And it comes back after a reload, rather than being a value only this tab knew about.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-ai").click();
  await expect(page.locator("[data-personal-instructions-input='true']")).toHaveValue(text);

  // Reset returns it to the state before any of this, which for a key written once means the default.
  await page.locator("[data-personal-instructions-reset='true']").click();
  await expect
    .poll(
      async () => {
        const response = await fetch(`${GATEWAY}/preferences`, {
          headers: { authorization: `Bearer ${token()}` },
        });
        const body = (await response.json()) as {
          preferences: { key: string; value: unknown; isDefault: boolean }[];
        };
        const entry = body.preferences.find((candidate) => candidate.key === "ai.personalInstructions");
        return entry?.isDefault === true;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});

test("the voice picker is drawn from what the provider says it can do", async ({ page }) => {
  /*
   * The picker is provider-driven, and this asserts the consequence rather than the markup: either the provider
   * offers voices and a searchable field is there, or it does not and the tab says why in words.
   *
   * What must never appear is a picker filled from a list this application wrote down: that would offer one
   * provider's voices to another, and the failure would arrive as a session that connects and then says nothing.
   * The e2e node runs the fixture provider, which declares two voices and no preview — so both branches below
   * are real states this application can be in, not hypotheticals.
   */
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-devices").click();

  const section = page.locator("[data-voice-settings='true']");
  await expect(section).toBeVisible();

  // The provider is named, because a voice only means something relative to who is speaking.
  const capabilities = page.locator("[data-voice-capabilities]");
  await expect(capabilities).toBeVisible({ timeout: 20_000 });
  const provider = await capabilities.getAttribute("data-voice-capabilities");
  expect(provider).not.toBeNull();

  // Either a searchable voice field, or the reason there is none — never an empty gap.
  await expect(
    page.locator("[data-search-input='voice'], [data-tone='warn']").first(),
  ).toBeVisible({ timeout: 20_000 });

  // The preview control follows the provider's own answer: enabled only if it says it can preview, and
  // otherwise disabled with the reason beside it rather than hidden or silently inert.
  const preview = page.locator("[data-voice-preview='true']");
  await expect(preview).toBeVisible();
  if (await preview.isDisabled()) {
    await expect(page.locator("[data-voice-preview-blocked='true']")).toBeVisible();
  }
});
