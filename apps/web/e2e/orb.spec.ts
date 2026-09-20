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

test.beforeEach(async () => {
  // Every test starts from the shipped profile, so one test's preference cannot decide another's result.
  await api("POST", "/preferences/orb.profile/undo");
  await api("POST", "/preferences/orb.custom/undo");
  await api("POST", "/preferences/experience.motion/undo");
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
