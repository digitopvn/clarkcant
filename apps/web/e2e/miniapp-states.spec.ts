import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Miniapp states, read through the shared status contract, in a real browser.
 *
 * The unit specs prove the tables and the placement rule. What only a browser shows is the result a person gets: a
 * press that was answered is heard once, from a live region that existed before the answer arrived; an error
 * interrupts and nothing else does; a card drawn again after a reload says what happened without announcing it again;
 * and each state carries a mark as well as a colour, with nothing moving under reduced motion. Run once in Vietnamese
 * on a phone-sized viewport with reduced motion, and once in English, against the scripted node fixtures
 * `task-stop.spec.ts` and `approval.spec.ts` drive.
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
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

async function switchToEnglish(page: Page): Promise<void> {
  await page.locator("[data-settings='true']").click();
  await page.locator('[data-segment="en"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("en");
  await page.keyboard.press("Escape");
}

/** Text inside any live region of the conversation: what a screen reader would be told about right now. */
function announced(page: Page): Locator {
  return page.locator("[data-surface-live] [role='status'] p, [data-surface-live] [role='alert'] p");
}

/** The mark a badge draws before its words, and whether anything about it moves. */
async function badgeMark(badge: Locator): Promise<{ content: string; animation: string }> {
  return badge.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { content: style.content, animation: style.animationName };
  });
}

/** The node keeps the language choice, and the suite shares one node: put it back for the specs after this one. */
test.afterEach(async ({ request }) => {
  await request.put(`${GATEWAY}/preferences/experience.language`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { value: "vi" },
  });
});

test("a stopped task is said once, politely, on a phone with reduced motion, and not again after a reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("cho tôi một task dài");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='task-progress']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The state is a phase with a mark, not a colour alone, and the mark is still under reduced motion.
  const badge = card.locator(".cc-card-head .cc-badge");
  await expect(badge).toHaveAttribute("data-surface-phase", "pending");
  const mark = await badgeMark(badge);
  expect(mark.content).toContain("◐");
  expect(mark.animation).toBe("none");

  // The live regions exist, empty, before anything is pressed: a region created with its text is not announced.
  await expect(card.locator("[data-surface-live] [role='status']")).toHaveCount(1);
  await expect(card.locator("[data-surface-live] [role='alert']")).toHaveCount(1);
  await expect(card.locator("[data-surface-live] [role='status'] p")).toHaveCount(0);

  await card.locator("[data-task-stop]").click();

  // Confirmed by the node, said politely, and not as an error.
  const outcome = card.locator("[role='status'] [data-task-stop-outcome='cancelled']");
  await expect(outcome).toHaveAttribute("data-task-stop-confirmed", "true", { timeout: 20_000 });
  await expect(outcome).toContainText("Đã dừng");
  await expect(card.locator("[role='alert'] p")).toHaveCount(0);

  // The card fits the phone: nothing in it is wider than the viewport.
  const overflow = await card.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // After a reload the transcript says the task stopped, and nothing on the page is announced as if it just happened.
  await page.reload();
  await expect(page.locator("[data-role='assistant']").last()).toContainText("Đã dừng task", { timeout: 20_000 });
  await expect(page.locator("[data-host-card='task-progress']").last()).toBeVisible();
  await expect(announced(page)).toHaveCount(0);
});

/** The newest card a slash command answered with. */
function commandCard(page: Page, command: string): Locator {
  return page.locator(`.cc-row[data-role="assistant"] [data-command="${command}"]`).last();
}

async function sendCommand(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
}

test("a command card press is said once from a region that was already there, and a cancelled sign-in is not a failure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);

  await sendCommand(page, "/thinking");
  const thinking = commandCard(page, "thinking");
  await expect(thinking).toBeVisible({ timeout: 20_000 });
  const high = thinking.locator('[data-row-id="high"]');
  // The row's regions exist, empty, before the press: the answer is a change a screen reader hears.
  await expect(high.locator("[data-surface-live] [role='status']")).toHaveCount(1);
  await expect(high.locator("[data-surface-live] [role='alert']")).toHaveCount(1);
  await expect(high.locator("[data-surface-live] p")).toHaveCount(0);

  await high.getByRole("button").click();
  const set = high.locator("[role='status'] .cc-command-status[data-surface-phase='success']");
  await expect(set).toContainText("Đã đặt", { timeout: 10_000 });
  await expect(high.locator("[role='alert'] p")).toHaveCount(0);
  const overflow = await thinking.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Back to the model's default, so the rest of the suite runs as it always has.
  await sendCommand(page, "/thinking");
  const again = commandCard(page, "thinking");
  await expect(again.locator('[data-row-id="high"]')).toHaveAttribute("data-current", "true", { timeout: 20_000 });
  await again.locator('[data-row-id="default"]').getByRole("button").click();
  await expect(again.locator('[data-row-id="default"] .cc-command-status')).toContainText("Đã đặt", { timeout: 10_000 });

  await sendCommand(page, "/login");
  const login = commandCard(page, "login");
  await expect(login).toBeVisible({ timeout: 20_000 });
  // The node's badge carries a mark as well as a colour, and nothing about it moves under reduced motion.
  const signedIn = login.locator('[data-row-id="fake"] .cc-badge');
  await expect(signedIn).toHaveAttribute("data-surface-phase", "success");
  const mark = await badgeMark(signedIn);
  expect(mark.content).toContain("✓");
  expect(mark.animation).toBe("none");

  const other = login.locator('[data-row-id="fake-other"]');
  await other.getByRole("button", { name: "Dùng API key" }).click();
  await expect(other.locator('.cc-sign-in input[type="password"]')).toBeVisible({ timeout: 10_000 });
  await other.locator(".cc-sign-in").getByRole("button", { name: "Hủy" }).click();

  // Cancelled reads as cancelled — said politely, marked cancelled — never as a failure.
  const cancelled = other.locator(".cc-sign-in [role='status'] [data-sign-in-status='cancelled']");
  await expect(cancelled).toHaveAttribute("data-result", "cancelled", { timeout: 10_000 });
  await expect(cancelled).toHaveAttribute("data-surface-phase", "cancelled");
  await expect(cancelled).toContainText("Đã hủy");
  await expect(other.locator("[role='alert'] p")).toHaveCount(0);

  // A reload draws the cards again and announces none of what already happened.
  await page.reload();
  await expect(commandCard(page, "login")).toBeVisible({ timeout: 20_000 });
  await expect(announced(page)).toHaveCount(0);
});

test("a command card press in English is said in English", async ({ page }) => {
  await openApp(page);
  await switchToEnglish(page);

  await sendCommand(page, "/thinking");
  const thinking = commandCard(page, "thinking");
  await expect(thinking).toBeVisible({ timeout: 20_000 });
  const high = thinking.locator('[data-row-id="high"]');
  await high.getByRole("button").click();
  await expect(high.locator("[role='status'] .cc-command-status[data-surface-phase='success']")).toContainText("Set.", {
    timeout: 10_000,
  });

  await sendCommand(page, "/thinking");
  const again = commandCard(page, "thinking");
  await expect(again.locator('[data-row-id="high"]')).toHaveAttribute("data-current", "true", { timeout: 20_000 });
  await again.locator('[data-row-id="default"]').getByRole("button").click();
  await expect(again.locator('[data-row-id="default"] .cc-command-status')).toContainText("Set.", { timeout: 10_000 });
});

test("an approval answered in English is said once, and a reload draws the decision without announcing it", async ({
  page,
}) => {
  await openApp(page);
  await switchToEnglish(page);

  await page.locator("[data-composer]").fill("chạy lệnh thử");
  await page.locator("[data-send]").click();
  const card = page.locator('[data-host-card="approval"]').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator("[data-approval-live] , [data-surface-live] p")).toHaveCount(0);

  await card.locator("[data-approve]").click();

  // The decision lands as a success, in the reader's language, in the polite region.
  const decision = card.locator('[data-approval-decision="answered"]');
  await expect(decision).toHaveText("approved", { timeout: 30_000 });
  await expect(decision).toHaveAttribute("data-surface-phase", "success");
  expect((await badgeMark(decision)).content).toContain("✓");
  await expect(card.locator("[role='status'] [data-approval-live]")).toHaveText("approved");
  await expect(card.locator("[role='alert'] p")).toHaveCount(0);

  await page.reload();
  const restored = page.locator('[data-host-card="approval"]').first();
  await expect(restored).toBeVisible({ timeout: 20_000 });
  await expect(restored.locator("[data-approve]")).toHaveCount(0);
  await expect(announced(page)).toHaveCount(0);
});
