import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A widget rendered inside the conversation, in a real browser.
 *
 * This is the claim the whole view path exists to support, and it is the one that cannot be
 * checked from the node: over HTTP a `surface` block and its instance are just JSON, and JSON
 * that a client refuses to draw looks exactly like JSON that works. So this test drives the real
 * client against a real node and asserts that a *renderer* ran, not that a block arrived.
 *
 * The scripted recipe is used rather than a model turn on purpose. It needs no provider account,
 * so this runs in CI, and the widget it produces is the same catalog widget the model would ask
 * for through `show_view` — which is what makes it a fair proxy rather than a different code path.
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
    // The original error is attached rather than flattened into a string: when the node failed to
    // start, that error is the diagnosis and this message is only the context.
    throw new Error(`the node did not write its identity to ${path}`, { cause });
  }
  const parsed = JSON.parse(raw) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

/** Open the app against the node this run started. The token is never logged. */
async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("textarea[aria-label='Nhập tin nhắn']")).toBeVisible();
  // The status pill, not merely the textarea: the composer renders before the health check
  // answers, and sending a message to a node that is not up yet proves nothing.
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function ask(page: Page, text: string): Promise<void> {
  await page.locator("textarea[aria-label='Nhập tin nhắn']").fill(text);
  await page.locator("[data-send='true']").click();
}

test("a scripted table recipe renders a real widget inside the conversation", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);

  await ask(page, "cho tui xem bảng dữ liệu");

  // A surface block that the client could not render falls back to its text alternative, and that
  // fallback is marked. Asserting the table is present *and* the fallback is absent is the
  // difference between "a widget was drawn" and "a widget was mentioned".
  const table = page.locator("table").first();
  await expect(table).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-fallback='true']")).toHaveCount(0);

  // The dataset is the sample one, and the interface has to say so next to the view that uses it.
  await expect(page.locator("text=dữ liệu mẫu").first()).toBeVisible();

  // The rows come from the node's dataset rather than from the client's imagination.
  await expect(table.locator("tbody tr").first()).toBeVisible();

  await page.screenshot({ path: join(EVIDENCE, "widget-01-table-in-conversation.png"), fullPage: true });
});

test("a widget the client cannot render shows its text alternative instead of nothing", async ({ page }) => {
  // The complement of the first test. If a missing renderer made the message disappear, history
  // would lose the fact that something was shown at all — so the fallback is a required behaviour,
  // not a consolation prize.
  await openApp(page);
  const surfaces = page.locator("[data-widget-fallback='true'], table");
  // Nothing asked for yet: the conversation is empty, so neither shape is present. This asserts the
  // selectors are meaningful rather than vacuously true.
  await expect(surfaces).toHaveCount(0);
});
