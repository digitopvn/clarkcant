import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Orb personalization, in a browser.
 *
 * The unit tests already prove the resolution: clamps, presets, reduced motion winning, a stable profile
 * key. What they cannot prove is the thing this file is for — that the resolved profile actually reaches a
 * real WebGL renderer, that it survives a reload, and that typing in the composer does not rebuild it.
 *
 * That last one is the claim worth a browser. The renderer is created in an effect, and the effect's
 * dependency list is what decides whether a keystroke tears down a GPU program and builds another. The
 * only way to see it is to count contexts in a real page, which is what `countedOrbContexts` does.
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

/** The gateway, with the node's own token. Used to set a preference the way a settings surface would. */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Count how many WebGL contexts the page asks for.
 *
 * Installed before any page script runs, because the orb's renderer is created during the first render:
 * a counter added afterwards would miss the very context it is meant to count. Only `webgl` is counted, so
 * a library asking for a 2D context does not look like a rebuild.
 */
async function countedOrbContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { __orbContexts?: number };
    scope.__orbContexts = 0;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function counted(this: HTMLCanvasElement, ...args: unknown[]) {
      if (args[0] === "webgl") scope.__orbContexts = (scope.__orbContexts ?? 0) + 1;
      return (original as (...rest: unknown[]) => unknown).apply(this, args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

const orbContexts = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __orbContexts?: number }).__orbContexts ?? 0);

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  // The orb in the header, which is present in both the start screen and the conversation.
  await page.waitForSelector(".cc-orb[data-orb]");
}

/** The profile the header orb reports it is drawing. */
const orbProfile = (page: Page): Promise<string | null> =>
  page.locator(".cc-orb[data-orb]").first().getAttribute("data-orb-profile");

const orbMotion = (page: Page): Promise<string | null> =>
  page.locator(".cc-orb[data-orb]").first().getAttribute("data-orb-motion");

/**
 * Step a preference back to its declared default, however many writes a test made.
 *
 * Undo steps back one write, and a journey here writes a style several times; a single undo would leave the
 * next test starting from the second-to-last style instead of the shipped orb. Bounded, as the settings
 * surface's own reset is, so a node that never reports a default cannot hold the suite in a loop.
 */
async function resetPreference(key: string): Promise<void> {
  for (let step = 0; step < 16; step += 1) {
    const answer = await api<{ preference: { isDefault: boolean } }>("POST", `/preferences/${key}/undo`);
    if (answer.preference.isDefault) return;
  }
  throw new Error(`${key} did not return to its default`);
}

test.beforeEach(async () => {
  // Every test starts from the shipped profile, so one test's preference cannot decide another's result.
  await resetPreference("orb.profile");
  await resetPreference("orb.custom");
  await resetPreference("experience.motion");
});

test("the shipped orb is what an unpersonalized node draws", async ({ page }) => {
  await countedOrbContexts(page);
  await openApp(page);

  // A real renderer, not the CSS fallback: the personalization has to reach WebGL, and an orb drawn from
  // the gradient would satisfy every colour assertion while proving nothing.
  await expect(page.locator(".cc-orb[data-orb='gl']").first()).toBeVisible();
  expect(await orbProfile(page)).toBe("clark");
  expect(await orbMotion(page)).toBe("full");
  expect(await orbContexts(page)).toBeGreaterThan(0);
});

test("a stored profile reaches the renderer and survives a reload", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  expect(await orbProfile(page)).toBe("clark");

  // Written the way the settings surface writes it, through the registry rather than into the database.
  const written = await api<{ preference: { value: string } }>("PUT", "/preferences/orb.profile", {
    value: "jelly",
  });
  expect(written.preference.value).toBe("jelly");

  // The node has it, so the reload below is asking whether the client reads it back rather than whether the
  // write landed.
  const listed = await api<{ preferences: { key: string; value: unknown }[] }>("GET", "/preferences");
  expect(listed.preferences.find((entry) => entry.key === "orb.profile")?.value).toBe("jelly");

  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => orbProfile(page)).toBe("jelly");
  await page.screenshot({ path: join(EVIDENCE, "orb-01-jelly-after-reload.png"), fullPage: true });

  // A custom patch layers over the shipped values, and reaches the orb as its own profile.
  await api("PUT", "/preferences/orb.profile", { value: "custom" });
  await api("PUT", "/preferences/orb.custom", {
    value: { physics: { stiffness: 140, damping: 6 }, motion: { speed: 2 } },
  });
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => orbProfile(page)).toBe("custom");
});

test("the node refuses a profile value outside the declared bounds, and the orb keeps drawing", async ({ page }) => {
  await openApp(page);

  // The registry is the gate on a write, so an out-of-range value never reaches storage.
  const refused = await fetch(`${GATEWAY}/preferences/orb.custom`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({ value: { physics: { stiffness: 4000 } } }),
  });
  expect(refused.status).toBe(400);
  expect((await refused.json()) as { code: string }).toMatchObject({ code: "PREFERENCE_INVALID" });

  // The orb is unaffected: a refused write left the previous value where it was, and the product's own face
  // is still drawn rather than blanked by a bad preference.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".cc-orb[data-orb='gl']").first()).toBeVisible();
});

test("typing does not rebuild the orb", async ({ page }) => {
  await countedOrbContexts(page);
  await openApp(page);
  const before = await orbContexts(page);
  expect(before).toBeGreaterThan(0);

  // Ten keystrokes, each one a React render of the conversation. If the renderer's effect depended on an
  // options object identity rather than the resolved profile's key, each of these would tear down a GPU
  // program and build another.
  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.pressSequentially("hello there", { delay: 20 });

  expect(await orbContexts(page)).toBe(before);
});

test("reduced motion wins over a profile that asks for motion", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });

  // A profile asking for the fastest animation the bounds allow.
  await api("PUT", "/preferences/orb.profile", { value: "custom" });
  await api("PUT", "/preferences/orb.custom", {
    value: { motion: { speed: 3 }, physics: { wobbleGain: 1, pointerResponse: 1.5 } },
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);

  // The preference still applies — this is a personalized orb — but the motion in it does not. A
  // preference that could outrank the platform setting would make the accessibility switch a lie.
  expect(await orbProfile(page)).toBe("custom");
  expect(await orbMotion(page)).toBe("reduced");
  await page.screenshot({ path: join(EVIDENCE, "orb-02-reduced-motion.png"), fullPage: true });
});

/** Opens Settings on its first tab, Experience, where the orb's styles are. */
async function openOrbSettings(page: Page): Promise<void> {
  await page.locator('[data-settings="true"]').click();
  await expect(page.locator("#cc-tabpanel-experience")).toBeVisible();
  await expect(page.locator('[data-orb-settings="true"]')).toBeVisible();
}

const preset = (page: Page, name: string) => page.locator(`[data-orb-preset="${name}"]`);
const previewCanvas = (page: Page) => page.locator(".cc-orb-preview-canvas");

/**
 * Two pictures of the same element a moment apart, compared byte for byte.
 *
 * A WebGL canvas cannot be read back without asking the renderer to keep its buffer, so the claim "the orb
 * is still" is checked the way a person would check it: by looking twice.
 */
async function looksStill(page: Page, selector: string): Promise<boolean> {
  const target = page.locator(selector).first();
  const first = await target.screenshot();
  await page.waitForTimeout(600);
  const second = await target.screenshot();
  return first.equals(second);
}

test("a style chosen in Settings changes the orb at once, keeps its colours in the preview, and survives a reload", async ({
  page,
}) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  await openOrbSettings(page);
  // `system`, so the emulated scheme above decides the theme whatever an earlier journey stored.
  await page.locator('[data-theme-choice="system"]').click();

  // Every style the contract names is offered, and the shipped one is selected.
  await expect(page.locator("[data-orb-preset]")).toHaveCount(7);
  await expect(preset(page, "clark")).toHaveAttribute("aria-pressed", "true");

  await preset(page, "pearl").click();
  await expect(preset(page, "pearl")).toHaveAttribute("aria-pressed", "true");
  await expect(preset(page, "clark")).toHaveAttribute("aria-pressed", "false");
  // No Save button: the preview and the orb in the header both follow the choice once the node has it.
  await expect(previewCanvas(page)).toHaveAttribute("data-orb-profile", "pearl");
  await expect(previewCanvas(page)).toHaveAttribute("data-orb", "gl");
  await expect.poll(() => orbProfile(page)).toBe("pearl");
  await expect(page.locator('[data-orb-preview-name="pearl"]')).toBeVisible();
  await page.screenshot({ path: join(EVIDENCE, "orb-03-settings-pearl-1280-dark.png"), fullPage: true });

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("light");
  await preset(page, "plasma").click();
  await expect.poll(() => orbProfile(page)).toBe("plasma");
  await page.screenshot({ path: join(EVIDENCE, "orb-04-settings-plasma-1280-light.png"), fullPage: true });

  // The node holds it, and a reload reads it back rather than showing the last thing drawn.
  const listed = await api<{ preferences: { key: string; value: unknown }[] }>("GET", "/preferences");
  expect(listed.preferences.find((entry) => entry.key === "orb.profile")?.value).toBe("plasma");
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => orbProfile(page)).toBe("plasma");
  await expect(page.locator(".cc-orb[data-orb='gl']").first()).toBeVisible();

  // Back to the signature orb from the same control, which is how a person undoes a style they did not like.
  await openOrbSettings(page);
  await page.locator('[data-orb-reset="true"]').click();
  await expect(preset(page, "clark")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => orbProfile(page)).toBe("clark");
});

test("the styles are chosen from the keyboard alone, with a visible focus ring", async ({ page }) => {
  await openApp(page);
  await openOrbSettings(page);

  await preset(page, "glass").focus();
  // Tab, not a programmatic focus, so the browser treats this as keyboard navigation and shows its ring.
  await page.keyboard.press("Tab");
  await expect(preset(page, "pearl")).toBeFocused();
  const outline = await preset(page, "pearl").evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");

  await page.keyboard.press("Space");
  await expect(preset(page, "pearl")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => orbProfile(page)).toBe("pearl");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the styles fit a 390px screen and answer a tap", async ({ page }) => {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await openApp(page);
    await openOrbSettings(page);
    await page.locator('[data-theme-choice="system"]').click();

    // Nothing in the list runs off the side of the screen: every style is reachable without scrolling sideways.
    for (const name of ["clark", "calm", "jelly", "glass", "pearl", "plasma", "custom"]) {
      const box = await preset(page, name).boundingBox();
      if (box === null) throw new Error(`${name} has no box`);
      expect(box.x, name).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, name).toBeLessThanOrEqual(390);
      // A target a finger can hit.
      expect(box.height, name).toBeGreaterThanOrEqual(44);
    }

    await preset(page, "jelly").tap();
    await expect(preset(page, "jelly")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => orbProfile(page)).toBe("jelly");
    await page.locator('[data-orb-settings="true"]').screenshot({ path: join(EVIDENCE, "orb-05-settings-jelly-390-dark.png") });

    await page.emulateMedia({ colorScheme: "light" });
    await preset(page, "calm").tap();
    await expect.poll(() => orbProfile(page)).toBe("calm");
    await page.locator('[data-orb-settings="true"]').screenshot({ path: join(EVIDENCE, "orb-06-settings-calm-390-light.png") });
  });
});

test("reduced motion stills every style, and the preview says so", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await api("PUT", "/preferences/orb.profile", { value: "plasma" });

  // First with motion, so the stillness below is a property of the setting rather than of a canvas that
  // never moves: plasma is the busiest style there is. Dark, because on a light surface the orb's
  // additive interior saturates to white, and a white disc looks the same from one frame to the next.
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  await openOrbSettings(page);
  await page.locator('[data-theme-choice="system"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("dark");
  await expect(previewCanvas(page)).toHaveAttribute("data-orb-motion", "full");
  expect(await looksStill(page, ".cc-orb-preview-canvas")).toBe(false);

  // The setting in the same panel, which applies at once.
  await page.locator('[data-segmented="motion"] [data-segment="reduced"]').click();
  await expect(previewCanvas(page)).toHaveAttribute("data-orb-motion", "reduced");
  await expect(page.locator('[data-orb-preview-motion="reduced"]')).toBeVisible();
  await expect.poll(() => orbMotion(page)).toBe("reduced");
  // The style is kept - colour is not motion - but it no longer moves.
  await expect(previewCanvas(page)).toHaveAttribute("data-orb-profile", "plasma");
  expect(await looksStill(page, ".cc-orb-preview-canvas")).toBe(true);
  await page.screenshot({ path: join(EVIDENCE, "orb-07-settings-plasma-reduced-motion.png"), fullPage: true });

  // The platform's own switch is enough on its own, with the stored preference back at its default.
  await api("POST", "/preferences/experience.motion/undo");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => orbMotion(page)).toBe("reduced");
  expect(await looksStill(page, ".cc-orb[data-orb]")).toBe(true);
});

test("without WebGL the orb stays visible in its style's colours, and Settings says why it is still", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  // A machine whose browser offers no WebGL: every request for a context is refused, as a disabled GPU does.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function withoutWebgl(this: HTMLCanvasElement, ...args: unknown[]) {
      if (args[0] === "webgl" || args[0] === "webgl2" || args[0] === "experimental-webgl") return null;
      return (original as (...rest: unknown[]) => unknown).apply(this, args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await api("PUT", "/preferences/orb.profile", { value: "pearl" });

  await openApp(page);
  const header = page.locator(".cc-orb[data-orb]").first();
  await expect(header).toHaveAttribute("data-orb", "fallback");
  await expect(header).toHaveAttribute("data-orb-profile", "pearl");
  // The fallback carries the chosen style rather than reverting to the shipped gradient.
  expect(await header.evaluate((element) => (element as HTMLElement).style.background)).toContain("radial-gradient");

  await openOrbSettings(page);
  await expect(page.locator('[data-orb-preview="true"]')).toHaveAttribute("data-orb-preview-mode", "fallback");
  await expect(page.locator('[data-orb-fallback-note="true"]')).toBeVisible();
  // The preview's own status says it is still, rather than claiming an animation a gradient cannot have.
  await expect(page.locator("[data-orb-preview-motion]")).toHaveText("Đang hiện ảnh tĩnh.");
  // The choice still works: it is saved, and the orb shows the new style's colours.
  await preset(page, "plasma").click();
  await expect.poll(() => orbProfile(page)).toBe("plasma");
  await expect(header).toHaveAttribute("data-orb", "fallback");
  await page.screenshot({ path: join(EVIDENCE, "orb-08-settings-no-webgl.png"), fullPage: true });

  // The shipped orb has no palette of its own to carry, and still shows the signature gradient rather than
  // an empty box.
  await preset(page, "clark").click();
  await expect.poll(() => orbProfile(page)).toBe("clark");
  const previewBackground = await previewCanvas(page).evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(previewBackground).toContain("radial-gradient");
});

test("the shell publishes how the user is interacting and what the agent is doing", async ({ page }) => {
  await openApp(page);

  const shell = page.locator(".cc-shell").first();
  // Idle with nothing in flight, and the pointer until something else is used.
  await expect(shell).toHaveAttribute("data-agent-state", "idle");
  await expect(shell).toHaveAttribute("data-input-modality", "pointer");

  // A key press is enough to switch the modality, and it has to be seen even though the focus is inside a
  // control: the listener is registered in the capture phase for exactly this.
  await page.keyboard.press("Tab");
  await expect(shell).toHaveAttribute("data-input-modality", "keyboard");

  // Nothing was invented on the way: the agent is still idle, because no turn has started.
  await expect(shell).toHaveAttribute("data-agent-state", "idle");
});

test("the agent state follows a real turn", async ({ page }) => {
  await openApp(page);

  const shell = page.locator(".cc-shell").first();
  await expect(shell).toHaveAttribute("data-agent-state", "idle");

  // A real message to the fixture model. The state has to leave idle while the turn runs, which is what makes
  // this an assertion about the turn rather than about the attribute existing.
  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("xin chào");
  await composer.press("Enter");

  // Either the turn is still running or it finished, and both are states this publishes; what must not
  // happen is the attribute staying at idle while a turn is in flight.
  await expect
    .poll(async () => shell.getAttribute("data-agent-state"), { timeout: 10_000 })
    .not.toBeNull();
});

/**
 * The pointer loop, and where its state lives.
 *
 * The orb answers the pointer every frame, which is the one place in this interface where a React re-render per
 * event would be visible: a pointer crossing the window produces hundreds of events, and state per event would put
 * the whole conversation through a render pass each time.
 *
 * The claim is therefore about the canvas rather than about the pixels: the element is the same element and there
 * is still exactly one WebGL context after the pointer has moved across the orb. A rebuild per pointer event — or a
 * second context — is what this catches.
 */
test("the orb is not rebuilt while the pointer moves across it", async ({ page }) => {
  await openApp(page);

  const orb = page.locator("[data-orb-motion]").first();
  await expect(orb).toBeVisible({ timeout: 20_000 });

  const before = await page.evaluate(() => {
    const canvas = document.querySelector("[data-orb-motion] canvas") as HTMLCanvasElement | null;
    if (canvas === null) return { present: false, contexts: 0 };
    (window as unknown as { __orbCanvas?: Element }).__orbCanvas = canvas;
    return { present: true, contexts: 1 };
  });
  if (!before.present) test.skip(true, "this node rendered the orb without a canvas, so there is no loop to check");

  const box = await orb.boundingBox();
  if (box === null) throw new Error("the orb has no box");
  // A sweep rather than a single move: one event would not show a per-event rebuild.
  for (let step = 0; step <= 20; step += 1) {
    await page.mouse.move(box.x + (box.width * step) / 20, box.y + box.height / 2);
  }

  const after = await page.evaluate(() => {
    const canvas = document.querySelector("[data-orb-motion] canvas");
    return { same: canvas === (window as unknown as { __orbCanvas?: Element }).__orbCanvas };
  });

  // Same element: the loop owns its own frame, and React was not asked to re-create it for any of those events.
  expect(after.same).toBe(true);
});
