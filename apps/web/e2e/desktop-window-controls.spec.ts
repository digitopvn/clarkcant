import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Minimize and full screen in the desktop window's own chrome.
 *
 * The window is frameless, so these buttons stand in for the ones a title bar would have. The shell's half (a real
 * window entering and leaving full screen) is proven by the Electron smoke. What this suite proves is the client's
 * half, against a stand-in bridge shaped like the preload's:
 *
 * - the buttons appear only when the shell has both verbs;
 * - they work from the keyboard;
 * - the chrome shows what the window reported, including a change the OS made on its own;
 * - a refusal is shown rather than swallowed;
 * - saying "phóng to toàn màn hình" reaches the same verb as the button.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

type BridgeShape = "current" | "older" | "refusing";

/**
 * A stand-in for the preload bridge, installed before the client loads.
 *
 * It answers the way the main process does, with the window's state after the call. It also records every call on
 * `window.__windowCalls`, and keeps the push callback on `window.__pushWindowState` so a test can play the OS.
 * There is no `getSession`, so the client takes its session from the URL like any other suite.
 */
async function installBridge(page: Page, shape: BridgeShape): Promise<void> {
  await page.addInitScript((kind: BridgeShape) => {
    const scope = window as unknown as Record<string, unknown>;
    const calls: unknown[] = [];
    scope.__windowCalls = calls;
    const bridge: Record<string, unknown> = {
      setCompactMode: async (action: unknown) => {
        calls.push(["setCompactMode", action]);
        return { ok: true, mode: "normal", bounds: { x: 0, y: 0, width: 1100, height: 760 }, alwaysOnTop: false };
      },
    };
    if (kind !== "older") {
      bridge.minimizeWindow = async () => {
        calls.push(["minimizeWindow"]);
        return { ok: true, fullScreen: false, minimized: true };
      };
      bridge.setFullScreen = async (value: unknown) => {
        calls.push(["setFullScreen", value]);
        if (kind === "refusing") return { ok: false, refused: "this window cannot go full screen" };
        const state = { ok: true, fullScreen: value === true, minimized: false };
        // The main process pushes the same state from the window's own enter/leave events.
        (scope.__pushWindowState as ((payload: unknown) => void) | undefined)?.(state);
        return state;
      };
      bridge.onWindowStateChanged = (callback: (payload: unknown) => void) => {
        scope.__pushWindowState = callback;
        return () => {
          scope.__pushWindowState = undefined;
        };
      };
    }
    scope.clarkcant = bridge;
  }, shape);
}

async function openApp(page: Page): Promise<void> {
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function windowCalls(page: Page): Promise<unknown[]> {
  return await page.evaluate(() => (window as unknown as { __windowCalls: unknown[] }).__windowCalls);
}

const minimize = (page: Page) => page.locator('[data-desktop-minimize="true"]');
const fullScreen = (page: Page) => page.locator('[data-desktop-fullscreen="true"]');

test("a plain browser draws no window chrome at all", async ({ page }) => {
  await openApp(page);
  await expect(page.locator('[data-desktop-chrome="true"]')).toHaveCount(0);
});

test("an older shell keeps its chrome but gets no minimize or full screen button", async ({ page }) => {
  await installBridge(page, "older");
  await openApp(page);
  await expect(page.locator('[data-desktop-chrome="true"]')).toBeVisible();
  await expect(minimize(page)).toHaveCount(0);
  await expect(fullScreen(page)).toHaveCount(0);
});

test("full screen and back from the keyboard, showing what the window reported", async ({ page }) => {
  await installBridge(page, "current");
  await openApp(page);

  await expect(fullScreen(page)).toHaveAttribute("aria-pressed", "false");
  await expect(fullScreen(page)).toHaveAttribute("aria-label", "Phóng to cửa sổ ra toàn màn hình");

  await fullScreen(page).focus();
  await page.keyboard.press("Enter");
  await expect(fullScreen(page)).toHaveAttribute("aria-pressed", "true");
  await expect(fullScreen(page)).toHaveAttribute("aria-label", "Thoát toàn màn hình, trả cửa sổ về kích thước cũ");
  await expect(page.locator('[data-desktop-mode="fullscreen"]')).toBeVisible();
  // Focus stays on the control that was used, so the same key takes the window back.
  await expect(fullScreen(page)).toBeFocused();

  await page.keyboard.press("Space");
  await expect(fullScreen(page)).toHaveAttribute("aria-pressed", "false");

  await minimize(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => windowCalls(page)).toEqual([["setFullScreen", true], ["setFullScreen", false], ["minimizeWindow"]]);
});

test("a change the OS made on its own is reflected without anybody clicking", async ({ page }) => {
  await installBridge(page, "current");
  await openApp(page);
  await expect(fullScreen(page)).toHaveAttribute("aria-pressed", "false");

  await page.evaluate(() => {
    const push = (window as unknown as { __pushWindowState?: (payload: unknown) => void }).__pushWindowState;
    push?.({ ok: true, fullScreen: true, minimized: false });
  });
  await expect(fullScreen(page)).toHaveAttribute("aria-pressed", "true");
  expect(await windowCalls(page)).toEqual([]);
});

test("a shell that refuses full screen says so and the button does not pretend", async ({ page }) => {
  await installBridge(page, "refusing");
  await openApp(page);

  await fullScreen(page).click();
  await expect(page.locator(".cc-desktop-problem")).toHaveText("this window cannot go full screen");
  await expect(fullScreen(page)).toHaveAttribute("aria-pressed", "false");
});

/** Script what the fixture voice provider will hear next. */
async function scriptVoice(request: APIRequestContext, words: string): Promise<void> {
  const response = await request.post(`${GATEWAY}/voice-fixture/words`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { words },
  });
  expect(response.status()).toBe(200);
}

test("saying “phóng to toàn màn hình” reaches the same verb as the button", async ({ page, request }) => {
  await installBridge(page, "current");
  await openApp(page);
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1, { timeout: 15_000 });

  await scriptVoice(request, "phóng to toàn màn hình");
  await page.locator('[data-voice-open="true"]').click();
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible({ timeout: 15_000 });

  await expect(page.getByText("Tôi phóng to cửa sổ ra toàn màn hình").first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => windowCalls(page), { timeout: 20_000 }).toContainEqual(["setFullScreen", true]);
  await expect(fullScreen(page)).toHaveAttribute("aria-pressed", "true");
});
