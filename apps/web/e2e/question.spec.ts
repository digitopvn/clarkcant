import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A question the agent asks, answered by pressing one of the answers it named.
 *
 * This is the primitive the plan singles out, and the claim worth a browser is that the answer becomes the
 * user's *own message* rather than a second, parallel route into the agent. Two consequences follow, and both
 * are asserted here: the transcript reads as a conversation rather than as a form submission, and the card stops
 * being answerable once the conversation has moved past it — so a click cannot send a second answer to a
 * question that was already answered.
 *
 * The node runs the scripted model, so the card is produced without a provider account.
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

test("an answer becomes the user's own message, and the card stops asking", async ({ page }) => {
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("hỏi tôi một câu");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='question']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The scripted producer names the answers, so the card offers exactly those and no free-text field.
  await expect(card).toContainText("Bạn muốn tôi mở dự án nào?");
  await expect(card).toHaveAttribute("data-answered", "false");

  const answer = card.locator("[data-question-option='option-2']");
  // The label, then the fixture's description of it: what the button says is what the person is choosing between.
  await expect(answer).toContainText("Dự án khác");
  await answer.click();

  // The answer is in the transcript as the user's message — the same shape a typed reply has.
  await expect(page.locator("[data-role='user']").last()).toContainText("Dự án khác");

  /*
   * And the card is no longer answerable. The transcript is immutable, so the card derives this from the record
   * the node wrote when the answer arrived — which is the only rule that cannot offer a second answer to a question
   * already answered.
   */
  await expect(card).toHaveAttribute("data-answered", "true");
  await expect(card.locator("[data-question-option='option-1']")).toHaveCount(0);
  // The options stay readable as text, which is what makes this card's text alternative the same thing as its
  // control: a reader who cannot press anything still learns what was offered.
  await expect(card).toContainText("Câu trả lời đã được ghi");
  await expect(card).toContainText("Dự án khác");
});

test("a form's draft survives a rerender, and submitting sends the answers as a message", async ({ page }) => {
  /*
   * Two claims, and the first is the one a unit test cannot make here: the form holds its draft in component
   * state, so its behaviour only exists inside React. This suite is where React runs.
   *
   * A half-typed form has to survive every rerender the app does around it — a turn streaming, a widget
   * resolving, a panel opening — and it must not survive as a preference, because a form is a message being
   * composed rather than a setting.
   */
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("cho tôi một biểu mẫu");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='form']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute("data-form-open", "true");

  // A required field with nothing in it cannot be submitted, and the form says which one is missing rather than
  // leaving a disabled button unexplained.
  const submit = card.locator("[data-form-submit='true']");
  await expect(submit).toBeDisabled();
  await expect(card.locator("[data-form-incomplete='true']")).toContainText("Tên dự án");

  const name = card.locator("[data-form-input='field-1']");
  const note = card.locator("[data-form-input='field-2']");
  await name.fill("clarkcant");
  await note.fill("ghi chú đang gõ dở");
  await expect(submit).toBeEnabled();

  /*
   * Force a rerender of the app around the card: opening and closing settings changes state at the shell, which
   * is exactly the kind of churn a streaming turn produces. The draft must come through it untouched.
   */
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-experience")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-modal='true']")).toBeHidden();
  await expect(name).toHaveValue("clarkcant");
  await expect(note).toHaveValue("ghi chú đang gõ dở");

  await submit.click();

  // The answers arrive as the user's own message, labelled — not as a JSON blob, which would put a machine shape
  // into the transcript and lose the labels that make it readable.
  const userMessage = page.locator("[data-role='user']").last();
  await expect(userMessage).toContainText("Tên dự án: clarkcant");
  await expect(userMessage).toContainText("ghi chú đang gõ dở");

  // And the form stops accepting input, because a second submission would send a second message.
  await expect(card).toHaveAttribute("data-form-open", "false");
  await expect(card.locator("[data-form-submit='true']")).toHaveCount(0);
});
