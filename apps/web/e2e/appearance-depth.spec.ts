import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * A theme's look beyond colour, in the browser.
 *
 * The compiler, the contract and the audits are unit-tested; what only a page can show is that a theme's recipes,
 * effects and Orb default actually reach what is drawn, that a theme pushing as hard as the contract allows still
 * leaves Stop, the approval card and every focus ring plainly visible, that reduced motion stills all of it, that the
 * whole flow works from the keyboard, and that a typed sentence changes the theme through the same write as a click.
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

const DEPTH_PACKAGE = "com.example.theme-depth";
const HOSTILE_PACKAGE = "com.example.theme-hostile";
const DEPTH_REF = `package:${DEPTH_PACKAGE}#depth`;
const FLATLINE_REF = `package:${HOSTILE_PACKAGE}#flatline`;
const CAMOUFLAGE_REF = `package:${HOSTILE_PACKAGE}#camouflage`;
const BLACKOUT_REF = `package:${HOSTILE_PACKAGE}#blackout`;
const LOOKALIKE_REF = `package:${HOSTILE_PACKAGE}#lookalike`;
/** The digests of the fixtures' bytes, as `fixtures/directory.json` lists them (a unit test keeps the two in step). */
const DEPTH_DIGEST = "sha256:14dc35f5d507f28c9fa0c516274e0a61ba4e857fe35a987443621dd16a416b69";
const HOSTILE_DIGEST = "sha256:4258b1eff61513c85652b3b2847411e2fd48721d377784f04750deb1094ba0b9";
const DEPTH_DARK_ACCENT = "#7DB4F0";

const overflowLog: { shot: string; scrollWidth: number; clientWidth: number; overflow: number }[] = [];

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

const headers = (): Record<string, string> => ({ authorization: `Bearer ${token()}` });

async function install(request: APIRequestContext, packageId: string, localDigest: string): Promise<void> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: headers() })).json()) as { packages: { packageId: string }[] };
  if (listed.packages.some((entry) => entry.packageId === packageId)) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, { headers: headers(), data: { packageId, version: "1.0.0", localDigest } });
  if (installed.ok()) return;
  // Uninstalled by an earlier run: restored from what this node kept, as the Extensions tab would.
  const restored = await request.post(`${GATEWAY}/packages/${encodeURIComponent(packageId)}/restore`, { headers: headers() });
  expect(restored.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
}

async function setTheme(request: APIRequestContext, themeRef: string): Promise<void> {
  const written = await request.put(`${GATEWAY}/preferences/experience.themeRef`, { headers: headers(), data: { value: themeRef } });
  expect(written.ok(), `theme write answered ${String(written.status())}: ${await written.text()}`).toBe(true);
}

/** Back to "never chosen", so a theme's Orb default is what decides. */
async function forgetOrbChoice(request: APIRequestContext): Promise<void> {
  for (let step = 0; step < 16; step += 1) {
    const answer = await request.post(`${GATEWAY}/preferences/orb.profile/undo`, { headers: headers() });
    expect(answer.ok()).toBe(true);
    if (((await answer.json()) as { preference: { isDefault: boolean } }).preference.isDefault) return;
  }
  throw new Error("orb.profile did not return to its default");
}

test.beforeEach(async ({ request }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await install(request, DEPTH_PACKAGE, DEPTH_DIGEST);
  await install(request, HOSTILE_PACKAGE, HOSTILE_DIGEST);
  await setTheme(request, "builtin:clark");
  await forgetOrbChoice(request);
});

test.afterEach(async ({ request }) => {
  // Every spec after this one starts from Clark Default and the shipped Orb.
  await setTheme(request, "builtin:clark");
  await forgetOrbChoice(request);
});

async function open(page: Page): Promise<void> {
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(), name);

/** A token as the colour the browser draws, so it compares with a computed `border-color` or `outline-color`. */
const drawnColor = (page: Page, name: string): Promise<string> =>
  page.evaluate((variable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);

async function recordOverflow(page: Page, shot: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  const overflow = scrollWidth - clientWidth;
  overflowLog.push({ shot, scrollWidth, clientWidth, overflow });
  writeFileSync(join(EVIDENCE, "298-overflow.json"), `${JSON.stringify(overflowLog, null, 2)}\n`);
  console.log(`[overflow] ${shot}: scrollWidth ${String(scrollWidth)} - clientWidth ${String(clientWidth)} = ${String(overflow)}`);
  expect(overflow, `${shot} is wider than the window`).toBeLessThanOrEqual(0);
}

async function still(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation instanceof CSSTransition).length))
    .toBe(0);
}

const frames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** Where the conversation's Orb is drawn, or "" when there is none. */
const orbBox = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const box = document.querySelector(".cc-stage-orb")?.getBoundingClientRect();
    return box === undefined ? "" : [box.x, box.y, box.width, box.height].join(",");
  });

/** Screenshots at both widths and both schemes, each with its overflow logged. */
async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      /*
       * The Orb is re-placed for the new width a frame after the resize and then glides there, so the transitions
       * are waited for only once they have started; two more frames let its canvas draw at rest.
       */
      await frames(page);
      await still(page);
      await expect.poll(async () => {
        const before = await orbBox(page);
        await frames(page);
        return before === (await orbBox(page));
      }).toBe(true);
      const shot = `298-${name}-${String(width)}-${scheme}`;
      await page.screenshot({ path: join(EVIDENCE, `${shot}.png`) });
      await recordOverflow(page, shot);
    }
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** The Orb in the conversation, not the preview in Settings. */
const conversationOrb = (page: Page): Locator => page.locator("canvas[data-orb-profile]").first();

test("a recipe-and-effect theme reaches the page, brings its Orb default, and loses the Orb to the person's choice", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await expect(conversationOrb(page)).toHaveAttribute("data-orb-profile", "clark");
  const clarkBackdrop = await page.locator(".cc-dot-grid").evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(await rootVar(page, "--cc-button-shadow")).toBe("");
  await shoot(page, "clark-default");

  await setTheme(request, DEPTH_REF);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => rootVar(page, "--cc-accent"), { timeout: 15_000 }).toBe(DEPTH_DARK_ACCENT);

  // Recipes and effects arrive as the host's own values under the host's own names.
  expect(await rootVar(page, "--cc-button-shadow")).toContain("3px 3px 0");
  expect(await rootVar(page, "--cc-composer-line")).toContain("solid");
  expect(await rootVar(page, "--cc-surface-image")).not.toBe("");
  const backdrop = await page.locator(".cc-dot-grid").evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(backdrop).not.toBe(clarkBackdrop);
  // The theme's Orb, because the person never chose one.
  await expect(conversationOrb(page)).toHaveAttribute("data-orb-profile", "plasma", { timeout: 15_000 });
  await shoot(page, "depth");

  // The person's choice wins over the theme's, and stays when the theme changes.
  const chosen = await request.put(`${GATEWAY}/preferences/orb.profile`, { headers: headers(), data: { value: "calm" } });
  expect(chosen.ok()).toBe(true);
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect(conversationOrb(page)).toHaveAttribute("data-orb-profile", "calm", { timeout: 15_000 });
  await expect.poll(() => rootVar(page, "--cc-accent"), { timeout: 15_000 }).toBe(DEPTH_DARK_ACCENT);
});

test("a hostile theme cannot hide Stop, the approval card, or a focus ring, and a camouflaged one is refused", async ({
  page,
  request,
}) => {
  // Camouflage is readable but draws every status as danger: the node refuses to store it.
  const refused = await request.put(`${GATEWAY}/preferences/experience.themeRef`, { headers: headers(), data: { value: CAMOUFLAGE_REF } });
  expect(refused.ok()).toBe(false);
  expect(await refused.text()).toContain("THEME_PROTECTED");
  // Blackout is readable too, but its Orb palette would draw the Orb as the page itself: refused the same way.
  const blackout = await request.put(`${GATEWAY}/preferences/experience.themeRef`, { headers: headers(), data: { value: BLACKOUT_REF } });
  expect(blackout.status()).toBe(409);
  const blackoutBody = await blackout.text();
  expect(blackoutBody).toContain("THEME_PROTECTED");
  expect(blackoutBody).toContain("orb-visible");

  await setTheme(request, FLATLINE_REF);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await expect.poll(() => rootVar(page, "--cc-card-edge"), { timeout: 15_000 }).toBe("transparent");

  // The approval card keeps the host's edge although the theme draws every card flat.
  await page.locator("[data-composer]").fill("chạy lệnh thử");
  await page.locator("[data-send]").click();
  const card = page.locator('[data-host-card="approval"][data-decision="pending"]').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const edges = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    return (["Top", "Right", "Bottom", "Left"] as const).map((side) => ({
      side,
      color: style.getPropertyValue(`border-${side.toLowerCase()}-color`),
      width: Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)),
    }));
  });
  const hostEdge = await drawnColor(page, "--cc-border");
  for (const edge of edges) {
    expect(edge.width, `${edge.side} edge`).toBeGreaterThanOrEqual(1);
    expect(edge.color, `${edge.side} edge`).toBe(hostEdge);
  }
  // And its plain card surface: the theme's glass tints widget cards, never the card that asks for consent.
  const surface = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fill: style.backgroundColor, image: style.backgroundImage, blur: style.backdropFilter, shadow: style.boxShadow };
  });
  expect(surface).toEqual({ fill: await drawnColor(page, "--cc-card"), image: "none", blur: "none", shadow: "none" });
  await expect(card.locator("[data-approve]")).toBeVisible();
  await expect(card.locator("[data-deny]")).toBeVisible();

  // Reached from the keyboard, the approve button shows the protected focus ring.
  await card.locator("[data-approve]").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(card.locator("[data-approve]")).toBeFocused();
  const ring = await card.locator("[data-approve]").evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor };
  });
  expect(ring.style).not.toBe("none");
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(ring.color).toBe(await drawnColor(page, "--cc-focus"));
  await card.locator("[data-deny]").click();
  await expect(card.locator("[data-approve]")).toHaveCount(0, { timeout: 15_000 });

  // Stop, while a reply is being written, is a visible, named button.
  await page.locator("[data-composer]").fill("viết một câu trả lời thật dài");
  await page.locator("[data-composer]").press("Enter");
  const stop = page.locator("[data-stop]");
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await expect(stop).toHaveAccessibleName(/.+/);
  const box = await stop.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
  expect(await stop.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1);
  await stop.click();
  await expect(stop).toHaveCount(0, { timeout: 15_000 });

  // Nothing on either width and in either scheme is wider than the window under the flattest theme; each is shot.
  await shoot(page, "flatline");

  // Settings lists Camouflage as refused, each hidden state on its own line in the reader's language.
  await page.locator("[data-settings='true']").click();
  const problems = page.locator("[data-theme-problems]");
  await expect(problems).toBeVisible({ timeout: 20_000 });
  await problems.locator("summary").first().click();
  const lines = page.locator(`[data-theme-problem='${CAMOUFLAGE_REF}'] [data-theme-protected] li`);
  await expect(lines.first()).toBeVisible();
  expect(await lines.count()).toBeGreaterThanOrEqual(2);
  // Sentences, not the audit's check codes or token names.
  for (const line of await lines.allInnerTexts()) {
    expect(line).not.toMatch(/status-distinct|status-vs-text|focus-vs-border|disabled-distinct|edge-visible|surface-readable|orb-visible|textTertiary|THEME_|\{/);
  }
  await expect(page.locator(`[data-theme-ref='${CAMOUFLAGE_REF}']`)).toHaveCount(0);
  // Blackout is listed as refused too, with the Orb named in a sentence rather than as a check code.
  const orbLines = page.locator(`[data-theme-problem='${BLACKOUT_REF}'] [data-theme-protected] li`);
  await expect(orbLines.first()).toBeVisible();
  for (const line of await orbLines.allInnerTexts()) {
    expect(line).toMatch(/Orb/);
    expect(line).not.toMatch(/orb-visible|THEME_|\{/);
  }
  await expect(page.locator(`[data-theme-ref='${BLACKOUT_REF}']`)).toHaveCount(0);
  await page.screenshot({ path: join(EVIDENCE, "298-hostile-refused-1280-dark.png") });
  await page.keyboard.press("Escape");
});

/** What a button is drawn with: its fill, its edge and its shadow, as the browser computed them. */
const buttonLook = (button: Locator): Promise<{ fill: string; edge: string; shadow: string }> =>
  button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fill: style.backgroundColor, edge: style.borderTopColor, shadow: style.boxShadow };
  });

test("a theme's button recipe never reaches the host's answers or Stop", async ({ page, request }) => {
  // Flatline draws every button quiet; Lookalike draws them solid in the card's own colour, with a hard accent shadow.
  const themes = [
    { name: "flatline", ref: FLATLINE_REF, buttonFill: "transparent" },
    // The browser reports a custom property with its `var()` resolved, so a token is compared as the value it resolves to.
    { name: "lookalike", ref: LOOKALIKE_REF, buttonFill: "--cc-card" },
  ] as const;
  for (const { name, ref, buttonFill } of themes) {
    await setTheme(request, ref);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page);
    // The theme's recipe is in force on the page; only the host's own buttons are drawn without it.
    const expectedFill = buttonFill.startsWith("--") ? await rootVar(page, buttonFill) : buttonFill;
    await expect.poll(() => rootVar(page, "--cc-button-bg"), { timeout: 15_000 }).toBe(expectedFill);

    await page.locator("[data-composer]").fill("chạy lệnh thử");
    await page.locator("[data-send]").click();
    const card = page.locator('[data-host-card="approval"][data-decision="pending"]').last();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await page.mouse.move(0, 0);
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // The page switches scheme after the media change reaches it; its colour transitions start a frame later.
      await expect(page.locator("html")).toHaveAttribute("data-cc-theme", scheme, { timeout: 15_000 });
      await frames(page);
      await still(page);
      const approve = await buttonLook(card.locator("[data-approve]"));
      const deny = await buttonLook(card.locator("[data-deny]"));
      // Approve is filled with the accent and Deny is Clark's plain button: the two answers never look alike.
      const accent = await drawnColor(page, "--cc-accent");
      expect(approve, `${name} ${scheme} Approve`).toEqual({ fill: accent, edge: accent, shadow: "none" });
      expect(deny, `${name} ${scheme} Deny`).toEqual({
        fill: await drawnColor(page, "--cc-elevated"),
        edge: await drawnColor(page, "--cc-border"),
        shadow: "none",
      });
      expect(approve.fill).not.toBe(deny.fill);
      await card.screenshot({ path: join(EVIDENCE, `298-${name}-approval-card-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await card.locator("[data-deny]").click();
    await expect(card.locator("[data-approve]")).toHaveCount(0, { timeout: 15_000 });

    // Stop, while a reply is being written, keeps the host's own button.
    await page.locator("[data-composer]").fill("viết một câu trả lời thật dài");
    await page.locator("[data-composer]").press("Enter");
    const stop = page.locator("[data-stop]");
    await expect(stop).toBeVisible({ timeout: 15_000 });
    expect(await buttonLook(stop), `${name} Stop`).toEqual({
      fill: await drawnColor(page, "--cc-elevated"),
      edge: await drawnColor(page, "--cc-border"),
      shadow: "none",
    });
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 15_000 });
  }
});

test("reduced motion stills the theme's motion, its backdrop light and its Orb", async ({ page, request }) => {
  await setTheme(request, DEPTH_REF);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  await expect.poll(() => rootVar(page, "--cc-accent"), { timeout: 15_000 }).toBe(DEPTH_DARK_ACCENT);

  // The theme asked for slower, snappier motion; reduced motion is still none at all.
  expect(await rootVar(page, "--cc-motion-micro")).toBe("0ms");
  expect(await rootVar(page, "--cc-motion-normal")).toBe("0ms");
  // The Orb is the theme's, and still.
  await expect(conversationOrb(page)).toHaveAttribute("data-orb-profile", "plasma", { timeout: 15_000 });
  await expect(conversationOrb(page)).toHaveAttribute("data-orb-motion", "reduced");
  // The backdrop keeps its pattern and loses the light that follows the pointer.
  await page.mouse.move(640, 450);
  const lit = await page.locator(".cc-dot-grid").evaluate((element) => getComputedStyle(element, "::after").display);
  expect(lit).toBe("none");
  // Nothing loops.
  const looping = await page.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity).length,
  );
  expect(looping).toBe(0);
});

test("the person's own Reduced setting stills the theme's motion and backdrop light as the system's does", async ({ page, request }) => {
  await setTheme(request, DEPTH_REF);
  const reduced = await request.put(`${GATEWAY}/preferences/experience.motion`, { headers: headers(), data: { value: "reduced" } });
  expect(reduced.ok(), await reduced.text()).toBe(true);
  try {
    // The operating system asks for full motion; only the in-app setting says Reduced.
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    await expect.poll(() => rootVar(page, "--cc-accent"), { timeout: 15_000 }).toBe(DEPTH_DARK_ACCENT);
    await expect(page.locator("body")).toHaveAttribute("data-cc-reduced-motion", "true", { timeout: 15_000 });

    // The theme asked for slower motion; everything under the page reads none.
    const bodyVar = (name: string): Promise<string> =>
      page.evaluate((variable) => getComputedStyle(document.body).getPropertyValue(variable).trim(), name);
    expect(await bodyVar("--cc-motion-micro")).toBe("0ms");
    expect(await bodyVar("--cc-motion-normal")).toBe("0ms");
    await expect(conversationOrb(page)).toHaveAttribute("data-orb-motion", "reduced", { timeout: 15_000 });
    await page.mouse.move(640, 450);
    expect(await page.locator(".cc-dot-grid").evaluate((element) => getComputedStyle(element, "::after").display)).toBe("none");
    const looping = await page.evaluate(
      () => document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity).length,
    );
    expect(looping).toBe(0);
  } finally {
    const restored = await request.put(`${GATEWAY}/preferences/experience.motion`, { headers: headers(), data: { value: "system" } });
    expect(restored.ok()).toBe(true);
  }
});

test("a typed sentence and the keyboard alone choose a theme through the same write as a click", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  const clarkAccent = await rootVar(page, "--cc-accent");

  // Typed: the sentence is understood here, the node checks the theme, and the page stores it through the picker's write.
  const composer = page.locator("[data-composer]");
  await composer.fill("đổi giao diện sang depth");
  await composer.press("Enter");
  await expect.poll(() => rootVar(page, "--cc-accent"), { timeout: 15_000 }).toBe(DEPTH_DARK_ACCENT);
  const stored = (await (await request.get(`${GATEWAY}/preferences`, { headers: headers() })).json()) as {
    preferences: { key: string; value: unknown }[];
  };
  expect(stored.preferences.find((entry) => entry.key === "experience.themeRef")?.value).toBe(DEPTH_REF);
  await recordOverflow(page, "298-typed-depth-390-dark");

  // Opened by a sentence, the gallery puts focus on the theme that is chosen, so the keyboard starts from there.
  await composer.fill("mở danh sách giao diện");
  await composer.press("Enter");
  const depth = page.locator(`[data-theme-ref='${DEPTH_REF}']`);
  await expect(depth).toBeFocused({ timeout: 20_000 });
  await expect(depth).toHaveAttribute("aria-pressed", "true");

  // Keyboard only: walk back to Clark Default and choose it.
  const clark = page.locator("[data-theme-ref='builtin:clark']");
  for (let step = 0; step < 12 && !(await clark.evaluate((element) => element === document.activeElement)); step += 1) {
    await page.keyboard.press("Shift+Tab");
  }
  await expect(clark).toBeFocused();
  const ring = await clark.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(ring).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(clark).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => rootVar(page, "--cc-accent"), { timeout: 15_000 }).toBe(clarkAccent);
  await recordOverflow(page, "298-keyboard-gallery-390-dark");
  await page.keyboard.press("Escape");
  await expect(composer).toBeVisible();

  // Light and dark, typed, through the same call as the Settings control.
  await composer.fill("chuyển giao diện sang sáng");
  await composer.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-cc-theme", "light", { timeout: 15_000 });
  await composer.fill("đổi giao diện theo hệ thống");
  await composer.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-cc-theme", "dark", { timeout: 15_000 });
});
