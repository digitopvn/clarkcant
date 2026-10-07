import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { compileAppearance } from "@clarkcant/design-tokens";

/**
 * The detached widget window, as a page.
 *
 * The window is served by this same app at `?detached=1`, and its bridge is injected by the desktop preload — so the
 * journey can be driven in a browser by standing in for that bridge. That is a fixture proving wiring rather than a
 * provider, which is the honest scope: what is asserted here is that the page shows the instance the host handed
 * over, that it asks the host to act rather than acting itself, and that it never reaches for the conversation.
 *
 * The host side of the relay — the digest it resolves, the lease it moves — is covered by
 * `apps/desktop/test/detached-window.spec.ts` and the desktop smoke test, which are the only places that can see it.
 */

/**
 * The shortest composition the surface builder accepts.
 *
 * The fields are the ones the builder actually reads — `period`, `timezone` and `state` as well as the spec — because
 * a payload missing one of them throws inside the builder rather than rendering an empty surface, and a window that
 * crashed on a payload the host would never send is not a useful fixture. The window's own job is to draw what it is
 * given; whether the host sends a valid composition is the host's test.
 */
const LIVE = {
  compositionId: "comp_detached",
  readOnly: false,
  revision: 3,
  period: "week",
  timezone: "Asia/Saigon",
  state: {},
  stateRevision: 1,
  spec: { instanceId: "widget_detached_1", catalogDigest: "sha256:deadbeef", sections: [], actions: [] },
  bindings: [],
  sections: [],
  availability: {},
};

const BOOTSTRAP = {
  instanceRef: "widget_detached_1",
  title: "Bảng điều khiển",
  widgetKind: "widget",
  live: LIVE,
};

type Recorded = string | { intent: Record<string, unknown> };

async function stubBridge(page: import("@playwright/test").Page, answer: unknown): Promise<void> {
  await page.addInitScript((bootstrapAnswer) => {
    const calls: Recorded[] = [];
    (window as unknown as { __detachedCalls: Recorded[] }).__detachedCalls = calls;
    (window as unknown as { clarkcantDetached: unknown }).clarkcantDetached = {
      onAppearance: (listener: (snapshot: unknown) => void) => {
        (window as unknown as { __emitAppearance: (snapshot: unknown) => void }).__emitAppearance = listener;
        return () => { calls.push("unsubscribe"); };
      },
      bootstrap: async () => {
        calls.push("bootstrap");
        return bootstrapAnswer;
      },
      intent: async (input: Record<string, unknown>) => {
        calls.push({ intent: input });
        return { ok: false, refused: "Hành động này không còn được gắn với widget." };
      },
      release: async () => {
        calls.push("release");
        return { ok: true };
      },
    };
  }, answer);
}

/**
 * The conversation half: which open widgets offer Detach at all.
 *
 * The desktop preload is stood in for with a `detachWidget` that only records, in the top window only, so the control's
 * gating is what is checked. Each widget is opened expanded and waited on until this surface holds its lease, because
 * the button is never offered before that, and an absent button before then would prove nothing.
 */
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
const GATEWAY = `http://127.0.0.1:${NODE_PORT ?? ""}`;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(process.cwd(), ".data", "e2e", "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

async function openConversationWithDetachBridge(page: import("@playwright/test").Page): Promise<void> {
  if (NODE_PORT === undefined || NODE_PORT === "") {
    throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
  }
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const requests: unknown[] = [];
    (window as unknown as { __detachRequests: unknown[] }).__detachRequests = requests;
    (window as unknown as { clarkcant: unknown }).clarkcant = {
      detachWidget: async (input: unknown) => {
        requests.push(input);
        return { ok: false, refused: "recorded only" };
      },
    };
  });
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

async function say(page: import("@playwright/test").Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

test("a composed widget open in the conversation offers Detach", async ({ page }) => {
  await openConversationWithDetachBridge(page);
  await say(page, "cho tui xem tổng quan công việc tuần này");
  await expect(page.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("[data-open-live]").first().click();
  const live = page.locator("[data-pin-live]").first();
  await expect(live.locator("[data-ownership='owner']")).toBeVisible({ timeout: 30_000 });
  await expect(live.locator("[data-detach-widget='true']")).toBeVisible();
});

test("a widget in its own frame open in the conversation does not offer Detach", async ({ page }) => {
  await openConversationWithDetachBridge(page);
  await say(page, "mở trình soạn thảo văn bản");
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  const live = page.locator("[data-pin-live]").last();
  await expect(live.locator("[data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
  await expect(live.locator("[data-ownership='owner']")).toBeVisible({ timeout: 20_000 });
  // The head is drawn (its Close is there), so a missing Detach is the gate, not a missing head.
  await expect(live.locator("[data-close-live]")).toBeVisible();
  await expect(live.locator("[data-detach-widget]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __detachRequests: unknown[] }).__detachRequests)).toEqual([]);
});

test("the detached composition draws the host revision and follows a checked appearance relay in place", async ({ page }) => {
  const initial = compileAppearance({ scheme: "dark" });
  const next = compileAppearance({ scheme: "light", reducedMotion: true });
  await stubBridge(page, { ok: true, bootstrap: { ...BOOTSTRAP, appearance: initial } });
  let nodeRequests = 0;
  page.on("request", (request) => {
    if (/\/(conversations|themes|preferences|widgets)\b/.test(new URL(request.url()).pathname)) nodeRequests += 1;
  });
  await page.goto("/?detached=1");
  const surface = page.locator("[data-detached-surface='true']");
  await expect(surface).toHaveAttribute("data-detached-instance", BOOTSTRAP.instanceRef);
  await expect(page.locator("html")).toHaveAttribute("data-cc-appearance", initial.revision);
  await surface.evaluate((element) => element.setAttribute("data-test-identity", "kept"));
  const before = await surface.innerText();
  const emit = (snapshot: unknown) => page.evaluate((value) => {
    (window as unknown as { __emitAppearance: (snapshot: unknown) => void }).__emitAppearance(value);
  }, snapshot);
  await emit(next);
  await expect(page.locator("html")).toHaveAttribute("data-cc-appearance", next.revision);
  await expect(page.locator("html")).toHaveAttribute("data-cc-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim().toUpperCase())).toBe(next.tokens.color.accent.toUpperCase());
  await expect(surface).toHaveAttribute("data-test-identity", "kept");
  expect(await surface.innerText()).toBe(before);
  await emit({ ...initial, localToken: "forbidden" });
  await emit({ ...initial, tokens: { ...initial.tokens, color: { ...initial.tokens.color, accent: "url(https://invalid.example)" } } });
  await expect(page.locator("html")).toHaveAttribute("data-cc-appearance", next.revision);
  expect(nodeRequests).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem("cc_token"))).toBeNull();
});

test("the detached window draws the instance the host handed over, and asks it to hand back", async ({ page }) => {
  await stubBridge(page, { ok: true, bootstrap: BOOTSTRAP });
  await page.goto("/?detached=1");

  const surface = page.locator("[data-detached-surface='true']");
  await expect(surface).toBeVisible();
  // The same instance the host named, drawn from the composition that came with it — not a copy of one.
  await expect(surface).toHaveAttribute("data-detached-instance", "widget_detached_1");
  await expect(surface).toContainText("Bảng điều khiển");

  // The one control this window owns, and it is a request to the host rather than a local state change.
  await page.locator("[data-detached-release='true']").click();
  const calls = await page.evaluate(() => (window as unknown as { __detachedCalls: Recorded[] }).__detachedCalls);
  expect(calls).toContain("release");
});

test("a widget in its own frame is refused by name rather than crashing the window", async ({ page }) => {
  /*
   * The conversation does not offer Detach for an isolated widget and the host refuses one, so this window is reached
   * only past both. It holds no credential to save that frame's state, so it mounts no frame and says why.
   */
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await stubBridge(page, {
    ok: true,
    bootstrap: {
      ...BOOTSTRAP,
      live: { kind: "isolated-frame", instanceId: "widget_detached_1", frame: { url: "/widgets/frame" }, bindings: [] },
    },
  });
  await page.goto("/?detached=1");

  const surface = page.locator("[data-detached-surface='true']");
  await expect(surface).toHaveAttribute("data-detached-unsupported", "isolated-frame");
  await expect(surface.locator("iframe")).toHaveCount(0);
  await page.locator("[data-detached-release='true']").click();
  const calls = await page.evaluate(() => (window as unknown as { __detachedCalls: Recorded[] }).__detachedCalls);
  expect(calls).toContain("release");
  expect(errors).toEqual([]);
});

test("a window that was handed nothing says so instead of showing an empty frame", async ({ page }) => {
  // "The host refused" and "the widget is blank" look identical on screen and mean opposite things.
  await stubBridge(page, { ok: false, refused: "this window is not showing a detached instance" });
  await page.goto("/?detached=1");

  const surface = page.locator("[data-detached-surface='true']");
  await expect(surface).toBeVisible();
  await expect(surface).toHaveAttribute("data-detached-error", "true");
  await expect(surface).toContainText("this window is not showing a detached instance");
  // And it does not claim to be showing an instance it never received.
  await expect(surface).not.toHaveAttribute("data-detached-instance", /.+/);
});

test("a token in the address bar buys the detached window no conversation", async ({ page }) => {
  /*
   * The claim this test exists for is the negative one. A detached window is served by the same app as the
   * conversation, so the only thing stopping it from reading the conversation is that its branch is taken before
   * anything reads a token. Handing it a real-looking token and asserting that no conversation appears is how that
   * ordering is checked rather than assumed.
   */
  await stubBridge(page, { ok: true, bootstrap: BOOTSTRAP });
  await page.goto("/?detached=1&token=not-a-real-token&gateway=http%3A%2F%2F127.0.0.1%3A1");

  await expect(page.locator("[data-detached-surface='true']")).toBeVisible();
  // No conversation, and none of its controls: not the composer, not the send button, not the token screen.
  await expect(page.locator("[data-composer='true']")).toHaveCount(0);
  await expect(page.locator("[data-needs-token='true']")).toHaveCount(0);
  // The token was never even stored for this tab, which is what "the branch is taken first" means in practice.
  expect(await page.evaluate(() => window.sessionStorage.getItem("cc_token"))).toBeNull();
});
