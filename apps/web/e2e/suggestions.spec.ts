import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * The suggestions the node offers, and what pressing one does.
 *
 * Seeded through the gateway's own API rather than by hoping the database already holds a session: the claim is
 * that a node which has seen work offers it back, and that claim has to be made about data this test put there.
 *
 * The chip's `text` is asserted to be what gets sent. A suggestion whose label is not the sentence it sends is a
 * chip that lies about what it does, and nothing else in the suite would catch that.
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

/** Put a session in the node's own records, so there is something to be reminded of. */
async function seedConversation(request: APIRequestContext, title = "Phiên để kiểm tra gợi ý"): Promise<string> {
  const response = await request.post(`${GATEWAY}/conversations`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { title },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { conversationId?: unknown };
  if (typeof body.conversationId !== "string" || body.conversationId === "") {
    throw new Error("the node created a conversation without naming it");
  }
  return body.conversationId;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
}

test("a chip drawn from the node's own records says where it came from", async ({ page, request }) => {
  await seedConversation(request);
  await openApp(page);

  const chip = page.locator("[data-suggestion-source]").first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  // The source is one of the records the node reads, and the chip says which one in words a person can read.
  await expect(chip).toHaveAttribute("data-suggestion-source", /^(conversation|task|pin|project|memory)$/);
  await expect(chip.locator(".cc-chip-detail")).not.toBeEmpty();
});

test("pressing a suggestion sends the sentence it showed", async ({ page, request }) => {
  await seedConversation(request);
  await openApp(page);

  const chip = page.locator("[data-suggestion-source]").first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  const sentence = await chip.getAttribute("data-suggestion");
  expect(sentence).toBeTruthy();

  await chip.click();
  // It went through the same turn a typed message takes, so the timeline shows it as a message from the person.
  await expect(page.locator('.cc-row[data-role="user"]').last()).toContainText(sentence!.slice(0, 16), {
    timeout: 20_000,
  });
});

/**
 * The issue's own criterion for this feature: seed two different sessions, and the next open offers the one that was
 * touched last.
 *
 * The two are made distinguishable on purpose. Two conversations created in the same millisecond tie on
 * `updated_at`, and a test that passes on a tie says nothing about recency, so the older one is created first and the
 * clock is given a moment before the newer one exists.
 */
test("with two sessions behind it, the offer is the one touched last", async ({ page, request }) => {
  const older = await seedConversation(request, "Phiên cũ hơn");
  await new Promise((resolve) => setTimeout(resolve, 25));
  const newer = await seedConversation(request, "Phiên mới nhất");

  const listed = await request.get(`${GATEWAY}/suggestions`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  expect(listed.ok()).toBe(true);
  const body = (await listed.json()) as { items?: { source?: string; ref?: string }[] };
  const session = body.items?.find((item) => item.source === "conversation");

  // The offer points at the session touched last, not at the first one that happens to exist.
  expect(session?.ref).toBe(newer);
  expect(session?.ref).not.toBe(older);

  // And the app draws it: a chip whose source is the session, on the first screen, from the node rather than a
  // static list.
  await openApp(page);
  await expect(page.locator('[data-suggestion-source="conversation"]')).toBeVisible({ timeout: 20_000 });
});
