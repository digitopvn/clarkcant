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
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
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
  // The directory arrives exactly as the shell has it; a Windows path once lost the `\` before each `.` on the way.
  await expect(sent).toContainText(DATA_DIR);
  // Only the bash integration marks where a command ends, so only there is an exit code known. Windows runs PowerShell
  // without that integration, and the message says so instead of inventing one.
  await expect(sent).toContainText(process.platform === "win32" ? "shell không báo exit code" : "exit 0");
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

test("a shell ended by a press is said aloud, the same card after a reload shows it quietly, and a terminal asked for next is said", async ({
  page,
}) => {
  await openApp(page);
  const card = await openTerminal(page);
  const terminalId = (await card.getAttribute("data-terminal-id")) ?? "";
  // The terminal's own state note is the first live note in its status line; the second is for a kill that failed.
  const stateNote = (of: typeof card) => of.locator(".cc-terminal-status .cc-live-note").first();
  await card.locator("[data-terminal-kill='true']").click();
  await expect(card.locator("[data-terminal-notice='exited']")).toBeVisible({ timeout: 10_000 });
  await expect(stateNote(card)).toHaveAttribute("data-surface-live", "polite");

  // Routed before the reload, since a route reaches only sockets of a page loaded after it; passed through until the
  // terminal asked for after the reload, whose socket is then closed before its shell is attached.
  let refuseTerminalSockets = false;
  await page.routeWebSocket(
    (url) => url.pathname === "/terminal",
    (socket) => {
      if (refuseTerminalSockets) socket.close();
      else socket.connectToServer();
    },
  );
  await page.reload();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  const again = page.locator(`[data-host-card='terminal-session'][data-terminal-id='${terminalId}']`);
  await expect(again).toBeVisible({ timeout: 20_000 });
  // Exited, or gone once the node let it go: either way it was true before the card was drawn again.
  await expect(again.locator("[data-terminal-notice='exited'], [data-terminal-notice='gone']")).toBeVisible({ timeout: 15_000 });
  await expect(stateNote(again)).toHaveAttribute("data-surface-live", "off");

  // A terminal asked for after the reload is news: its card's first state, a failure to connect here, interrupts, while
  // the card drawn again from history stays quiet.
  refuseTerminalSockets = true;
  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("mở terminal giúp tôi");
  await composer.press("Enter");
  const asked = page.locator(`[data-host-card='terminal-session']:not([data-terminal-id='${terminalId}'])`).last();
  await expect(asked).toHaveAttribute("data-terminal-mode", "live", { timeout: 20_000 });
  await expect(asked.locator("[data-terminal-notice='disconnected']")).toBeVisible({ timeout: 15_000 });
  await expect(stateNote(asked)).toHaveAttribute("data-surface-live", "assertive");
  await expect(stateNote(again)).toHaveAttribute("data-surface-live", "off");
});

test("a terminal just asked for that cannot be reached says so at once, rather than showing it silently", async ({ page }) => {
  // The card's socket is closed before the shell is attached: the first state this new card settles on is a failure.
  await page.routeWebSocket((url) => url.pathname === "/terminal", (socket) => socket.close());
  await openApp(page);
  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("mở terminal giúp tôi");
  await composer.press("Enter");
  const card = page.locator("[data-host-card='terminal-session']").last();
  await expect(card).toHaveAttribute("data-terminal-mode", "live", { timeout: 20_000 });
  await expect(card.locator("[data-terminal-notice='disconnected']")).toBeVisible({ timeout: 15_000 });
  // Asked for just now, so its first state is news: an error interrupts. Only a card drawn again from history is quiet.
  await expect(card.locator(".cc-terminal-status .cc-live-note").first()).toHaveAttribute("data-surface-live", "assertive");
  await expect(card.locator("[role='alert'] [data-terminal-notice='disconnected']")).toBeVisible();
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

test("a terminal asked for a conversation that does not exist is never opened", async ({ request }) => {
  const headers = { authorization: `Bearer ${token()}` };
  const running = async (): Promise<number> => {
    const listed = (await (await request.get(`${GATEWAY}/terminals`, { headers })).json()) as { terminals: { status: string }[] };
    return listed.terminals.filter((terminal) => terminal.status === "running").length;
  };
  const before = await running();
  const response = await request.post(`${GATEWAY}/terminals`, { headers, data: { conversationId: "conv_does_not_exist" } });
  expect(response.status()).toBe(404);
  // No shell was started that no card could show or close.
  expect(await running()).toBe(before);
});
