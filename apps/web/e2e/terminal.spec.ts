import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The terminal card: a real shell on the node, typed into from the conversation.
 *
 * The fixture only decides to call `terminal_open`; the PTY, the socket, the shell integration and the card are the
 * node's own. So the claims below are about a real bash: what is typed runs, its exit code comes back from the shell's
 * own marks, and the result reaches the conversation as the person's message.
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
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function openTerminal(page: Page) {
  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("mở terminal giúp tôi");
  await composer.press("Enter");
  const card = page.locator("[data-host-card='terminal-session']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute("data-terminal-mode", "live");
  await expect(card).toHaveAttribute("data-terminal-phase", "attached", { timeout: 15_000 });
  return card;
}

test("a command typed into the terminal runs, and its result goes back to the conversation", async ({ page }) => {
  await openApp(page);
  const card = await openTerminal(page);
  await expect(card).toHaveAttribute("data-terminal-driver", "true");
  await expect(card).toHaveAttribute("data-terminal-status", "running");

  const screen = card.locator("[data-terminal-screen='true']");
  await screen.click();
  // Arithmetic in the shell, so the output on screen cannot be the echo of what was typed.
  await page.keyboard.type("echo cc-e2e-$((40+2))");
  await page.keyboard.press("Enter");
  await expect(screen.locator(".xterm-rows")).toContainText("cc-e2e-42", { timeout: 10_000 });

  const share = card.locator("[data-terminal-share]");
  await expect(share).toHaveAttribute("data-terminal-share", "command", { timeout: 10_000 });
  await expect(share).toHaveText("Gửi kết quả lệnh");
  await share.click();

  const sent = page.locator("[data-bubble='user']").last();
  await expect(sent).toContainText("cc-e2e-42", { timeout: 10_000 });
  await expect(sent).toContainText("exit 0");
});

test("the keyboard can leave the terminal, and the process panel closes back to its button", async ({ page }) => {
  await openApp(page);
  const card = await openTerminal(page);

  // Escape belongs to the shell, so F6 is the way out; the card says so.
  await expect(card.locator(".cc-terminal-hint")).toHaveText("F6 để rời terminal");
  await card.locator("[data-terminal-screen='true']").click();
  await page.keyboard.press("F6");
  await expect(card.locator("[data-terminal-share]")).toBeFocused();

  const toggle = card.locator("[data-terminal-processes='true']");
  await toggle.focus();
  await page.keyboard.press("Enter");
  const panel = card.locator("[data-terminal-panel='true']");
  await expect(panel).toBeVisible();
  const terminalId = await card.getAttribute("data-terminal-id");
  await expect(panel.locator(`[data-panel-terminal='${terminalId ?? ""}']`)).toContainText("thẻ này", { timeout: 10_000 });
  // The card's own terminal is already on screen, so viewing it again is not offered as an action.
  await expect(panel.locator(`[data-panel-view='${terminalId ?? ""}']`)).toBeDisabled();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

test("closing the terminal says the shell ended instead of leaving a dead prompt that looks live", async ({ page }) => {
  await openApp(page);
  const card = await openTerminal(page);
  await card.locator("[data-terminal-kill='true']").click();
  await expect(card).toHaveAttribute("data-terminal-status", "exited", { timeout: 10_000 });
  await expect(card.locator("[data-terminal-notice='exited']")).toBeVisible();
  await expect(card.locator("[data-terminal-kill='true']")).toHaveCount(0);
});

test("the card fits a narrow window without scrolling the page sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  const card = await openTerminal(page);
  const box = await card.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
