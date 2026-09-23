import { expect, test } from "@playwright/test";

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
