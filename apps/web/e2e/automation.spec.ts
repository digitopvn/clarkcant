import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

/**
 * A standing request, in a real browser.
 *
 * Said once in the conversation, answered later by a fact the node hears over `POST /signals`: the reminder lands in
 * the conversation that is still open — without a reload — and in the inbox. The sentence that sets it up is the
 * fixture model's; the automation is the node's own, stored, matched and reported by the automation service.
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
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

test("a reminder set up in the conversation is said there, and left in the inbox, when its signal arrives", async ({ page }) => {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });

  // A topic of this run's own, so a signal another spec or an earlier run sends never answers it. Base 36 rather than a
  // long run of digits, which the inbox would rightly mask as something that could be a secret.
  const topic = `e2e.build.done-${Date.now().toString(36)}`;
  await page.locator("[data-composer]").fill(`nhắc tôi khi có ${topic}: kiểm tra bản build`);
  await page.locator("[data-send]").click();
  await expect(page.getByText("Set up.", { exact: false }).last()).toBeVisible({ timeout: 20_000 });

  const listed = await page.request.get(`${GATEWAY}/automations`, { headers: { authorization: `Bearer ${token()}` } });
  expect(listed.status()).toBe(200);
  const { automations } = (await listed.json()) as { automations: { intent: { when: { topic: string }; state: string } }[] };
  expect(automations.some((entry) => entry.intent.when.topic === topic && entry.intent.state === "active")).toBe(true);

  const signal = {
    source: { kind: "external", provider: "e2e", sourceId: "e2e:ci" },
    topic,
    subject: { type: "build", id: "42" },
    payload: { status: "green" },
    occurredAt: new Date().toISOString(),
    dedupeKey: `${topic}:1`,
  };
  const sent = await page.request.post(`${GATEWAY}/signals`, { headers: { authorization: `Bearer ${token()}` }, data: signal });
  expect(sent.status()).toBe(202);
  // The same delivery again is heard, and answered as the one already recorded.
  const again = await page.request.post(`${GATEWAY}/signals`, { headers: { authorization: `Bearer ${token()}` }, data: signal });
  expect(again.status()).toBe(200);

  // In the conversation that is still open, without a reload, and once.
  const reminder = page.getByText(`Nhắc bạn — Nhắc khi có ${topic}: kiểm tra bản build`, { exact: true });
  await expect(reminder).toBeVisible({ timeout: 20_000 });
  await expect(reminder).toHaveCount(1);
  await page.screenshot({ path: join(EVIDENCE, "automation-01-reminder.png"), fullPage: true, animations: "disabled" });

  // And in the inbox, where something that happened on its own is found later.
  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('[data-inbox-panel="ready"]')).toBeVisible({ timeout: 10_000 });
  const notice = dialog.locator("[data-inbox-notice]").filter({ hasText: `Nhắc khi có ${topic}` });
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("kiểm tra bản build");
  await page.screenshot({ path: join(EVIDENCE, "automation-02-inbox.png"), fullPage: true, animations: "disabled" });
});

test("an address in what the node says on its own opens as a link, the way a task's pull request is reported", async ({ page }) => {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });

  // A task's result and a reminder reach the conversation the same way, as a plain sentence from the node; a
  // fixture node runs no worker, so the reminder is the one of the two a browser can be sent here.
  const topic = `e2e.pr.opened-${Date.now().toString(36)}`;
  const pullRequest = "https://github.com/Codertocat/Hello-World/pull/42";
  await page.locator("[data-composer]").fill(`nhắc tôi khi có ${topic}: xem draft PR ${pullRequest}`);
  await page.locator("[data-send]").click();
  await expect(page.getByText("Set up.", { exact: false }).last()).toBeVisible({ timeout: 20_000 });

  const sent = await page.request.post(`${GATEWAY}/signals`, {
    headers: { authorization: `Bearer ${token()}` },
    data: {
      source: { kind: "external", provider: "e2e", sourceId: "e2e:github" },
      topic,
      subject: { type: "pull_request", id: "42" },
      payload: {},
      occurredAt: new Date().toISOString(),
      dedupeKey: `${topic}:1`,
    },
  });
  expect(sent.status()).toBe(202);

  const said = page.locator("p.cc-text").filter({ hasText: `Nhắc bạn — Nhắc khi có ${topic}` });
  await expect(said).toHaveCount(1, { timeout: 20_000 });
  const link = said.getByRole("link", { name: pullRequest, exact: true });
  await expect(link).toHaveAttribute("href", pullRequest);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  // The sentence itself is unchanged around the link.
  await expect(said).toHaveText(`Nhắc bạn — Nhắc khi có ${topic}: xem draft PR ${pullRequest}`);
  // Reachable from the keyboard, like every other control in the conversation.
  await link.focus();
  await expect(link).toBeFocused();
  await said.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(EVIDENCE, "automation-03-linked-result.png"), fullPage: true, animations: "disabled" });
});