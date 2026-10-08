import { readFileSync, writeFileSync } from "node:fs";
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

test("closing the conversation's view of a detached widget closes its window", async ({ page }) => {
  /*
   * The surface that detached a widget is the one listening to take it back. When it goes away while the window is
   * still open - here, by closing the pin - nothing else would, so it asks the host to close the window, which gives
   * the lease back.
   */
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const calls: string[] = [];
    (window as unknown as { __shellCalls: string[] }).__shellCalls = calls;
    (window as unknown as { clarkcant: unknown }).clarkcant = {
      detachWidget: async () => {
        calls.push("detach");
        return { ok: true };
      },
      attachWidget: async () => {
        calls.push("attach");
        return { ok: true, attached: true };
      },
    };
  });
  if (NODE_PORT === undefined || NODE_PORT === "") throw new Error("CC_E2E_NODE_PORT is not set; run this suite through playwright.config.ts");
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  await say(page, "cho tui xem tổng quan công việc tuần này");
  await expect(page.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("[data-open-live]").first().click();
  const live = page.locator("[data-pin-live]").first();
  await expect(live.locator("[data-ownership='owner']")).toBeVisible({ timeout: 30_000 });

  await live.locator("[data-detach-widget='true']").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shellCalls: string[] }).__shellCalls)).toEqual(["detach"]);

  await live.locator("[data-close-live]").click();
  await expect(page.locator("[data-pin-live]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shellCalls: string[] }).__shellCalls)).toEqual(["detach", "attach"]);
});

test("a widget in its own frame open in the conversation offers Detach", async ({ page }) => {
  await openConversationWithDetachBridge(page);
  await say(page, "mở trình soạn thảo văn bản");
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  const live = page.locator("[data-pin-live]").last();
  await expect(live.locator("[data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
  await expect(live.locator("[data-ownership='owner']")).toBeVisible({ timeout: 20_000 });
  // The desktop host relays the frame's reads, writes and presses, so the detached window can run it.
  await expect(live.locator("[data-detach-widget='true']")).toBeVisible();
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

/** A frame read as the desktop host answers it: absolute on the node's origin, with a fresh grant each read. */
const FRAME_DOCUMENT = "http://127.0.0.1:47011/frame-fixture/document.html";

function frameLive(frame: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "isolated-frame",
    instanceId: "widget_detached_1",
    revision: 3,
    readOnly: false,
    frame,
    bindings: [{ actionBindingId: "refresh", label: "Refresh", effectCategory: "read", bindingDigest: "sha256:binding" }],
    props: {},
    stateRevision: 1,
    stateVersion: 1,
    state: { count: 1 },
    stateStatus: { kind: "writable" },
    ephemeralStateKeys: [],
    ...extra,
  };
}

/**
 * The detached preload with the frame relays, as `detached-preload.cjs` exposes them. Every call is recorded; none of
 * them names an instance or a conversation, because the host performs each against the instance it opened.
 */
async function stubFrameBridge(page: import("@playwright/test").Page, read: Record<string, unknown>): Promise<void> {
  await page.addInitScript((frameRead) => {
    const calls: unknown[] = [];
    (window as unknown as { __detachedCalls: unknown[] }).__detachedCalls = calls;
    let grant = 0;
    (window as unknown as { clarkcantDetached: unknown }).clarkcantDetached = {
      bootstrap: async () => {
        calls.push("bootstrap");
        // The conversation's own read, whose grant was minted for it: the window mounts only what it reads itself.
        return { ok: true, bootstrap: { instanceRef: "widget_detached_1", title: "Trình soạn thảo", widgetKind: "widget", live: frameRead } };
      },
      frameRead: async (...args: unknown[]) => {
        calls.push({ frameRead: args });
        grant += 1;
        const frame = (frameRead as { frame: { url: string } | null }).frame;
        return { ok: true, live: { ...frameRead, frame: frame === null ? null : { ...frame, url: `${frame.url}?grant=${grant}` } } };
      },
      saveState: async (write: unknown) => {
        calls.push({ saveState: write });
        return { ok: false, code: "RELAY_REFUSED", refused: "recorded only" };
      },
      publishSemantic: async (input: unknown) => {
        calls.push({ publishSemantic: input });
        return { ok: true };
      },
      devSession: async () => {
        calls.push("devSession");
        return { ok: false, code: "NO_DEV_SESSION", refused: "no session" };
      },
      intent: async (input: unknown) => {
        calls.push({ intent: input });
        return { ok: false, refused: "recorded only" };
      },
      release: async () => {
        calls.push("release");
        return { ok: true };
      },
      // The file, job and token relays, recorded and refused: this fixture draws the frame and never uses them.
      artifacts: Object.fromEntries(
        ["pick", "describe", "create", "read", "write", "finalize", "export", "attach", "discard"].map((verb) => [
          verb,
          async (input: unknown) => {
            calls.push({ [`artifacts.${verb}`]: input });
            return { ok: false, code: "RELAY_REFUSED", refused: "recorded only" };
          },
        ]),
      ),
      jobs: Object.fromEntries(
        ["get", "list", "cancel"].map((verb) => [verb, async () => ({ ok: false, code: "RELAY_REFUSED", refused: "recorded only" })]),
      ),
      tokens: Object.fromEntries(
        ["request", "end"].map((verb) => [verb, async () => ({ ok: false, code: "RELAY_REFUSED", refused: "recorded only" })]),
      ),
    };
  }, read);
}

test("a widget in its own frame mounts in the detached window through the host's relays, holding no credential", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let conversationRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("/conversations")) conversationRequests += 1;
  });
  // The frame's document, served where the host's read said it is.
  await page.route(`${FRAME_DOCUMENT}*`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><p>frame</p>" }));
  await stubFrameBridge(
    page,
    frameLive({ url: FRAME_DOCUMENT, document: "build-1", isolation: "opaque-origin", grantedCapabilities: [], allowedOrigins: [] }),
  );
  await page.goto("/?detached=1");

  const surface = page.locator("[data-detached-surface='true']");
  await expect(surface).toHaveAttribute("data-detached-frame", "true");
  await expect(surface).toHaveAttribute("data-detached-instance", "widget_detached_1");
  const iframe = surface.locator("[data-widget-frame='widget_detached_1'] iframe");
  // The URL from the window's own read, with its own grant, in the same sandbox the conversation uses.
  await expect(iframe).toHaveAttribute("src", `${FRAME_DOCUMENT}?grant=1`);
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");

  const calls = await page.evaluate(() => (window as unknown as { __detachedCalls: unknown[] }).__detachedCalls);
  // The frame was read through the relay, which takes no arguments: the host names the instance.
  expect(calls).toContainEqual({ frameRead: [] });
  expect(conversationRequests).toBe(0);
  expect(await page.evaluate(() => [window.sessionStorage.getItem("cc_token"), window.localStorage.getItem("cc_token")])).toEqual([null, null]);
  expect(await page.evaluate(() => Object.keys(window.localStorage).filter((key) => /token/i.test(key)))).toEqual([]);
  expect(errors).toEqual([]);
});

test("a widget whose package is gone shows its text alternative in the detached window, not an empty frame", async ({ page }) => {
  await stubFrameBridge(page, frameLive(null, { textFallback: "Bản nháp: 3 đoạn văn" }));
  await page.goto("/?detached=1");

  const surface = page.locator("[data-detached-surface='true']");
  await expect(surface.locator("[data-widget-text-fallback='true']")).toHaveText("Bản nháp: 3 đoạn văn");
  await expect(surface.locator("iframe")).toHaveCount(0);
  await page.locator("[data-detached-release='true']").click();
  const calls = await page.evaluate(() => (window as unknown as { __detachedCalls: unknown[] }).__detachedCalls);
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

/*
 * The conversation's half of the hand-off, driven through the real surface (`PinnedLiveSurface`) against the real node.
 *
 * The node's lease calls are held or failed with `page.route`, and the page's clock is installed, so the 30 s re-claim
 * can be stepped rather than waited for. The bridge stands in for the desktop preload, recording what it is asked.
 */
const LIVE_OWNER = /\/widgets\/[^/]+\/live-owner$/;
const LIVE_READ = /\/widgets\/[^/]+\/live$/;
const REFRESH_MS = 30_000;

async function openOwnedLiveWidget(
  page: import("@playwright/test").Page,
  bridge: "records" | "throws",
  beforeOpen?: () => Promise<void>,
): Promise<import("@playwright/test").Locator> {
  if (NODE_PORT === undefined || NODE_PORT === "") throw new Error("CC_E2E_NODE_PORT is not set; run this suite through playwright.config.ts");
  await page.addInitScript((mode) => {
    if (window.top !== window) return;
    const calls: string[] = [];
    (window as unknown as { __shellCalls: string[] }).__shellCalls = calls;
    (window as unknown as { clarkcant: unknown }).clarkcant = {
      detachWidget: async () => {
        calls.push("detach");
        if (mode === "throws") throw new Error("the widget window closed while it was loading");
        return { ok: true };
      },
      attachWidget: async () => {
        calls.push("attach");
        return { ok: true, attached: true };
      },
    };
  }, bridge);
  await page.clock.install();
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  await say(page, "cho tui xem tổng quan công việc tuần này");
  await expect(page.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
  await beforeOpen?.();
  await page.locator("[data-open-live]").first().click();
  return page.locator("[data-pin-live]").first();
}

function shellCalls(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __shellCalls: string[] }).__shellCalls);
}

test("a detach the desktop shell throws on tells the person, takes the widget back and leaves no uncaught error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const live = await openOwnedLiveWidget(page, "throws");
  await expect(live.locator("[data-ownership='owner']")).toBeVisible({ timeout: 30_000 });

  await live.locator("[data-detach-widget='true']").click();
  await expect.poll(() => shellCalls(page)).toEqual(["detach"]);
  await expect(live.locator("[data-live-notice='true']")).toContainText("the widget window closed while it was loading");
  await expect(live.locator("[data-ownership='owner']")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a re-claim the node never answers does not stop the next one, and Detach waits for the one on its way", async ({ page }) => {
  const live = await openOwnedLiveWidget(page, "records");
  await expect(live.locator("[data-ownership='owner']")).toBeVisible({ timeout: 30_000 });

  const held: Array<import("@playwright/test").Route> = [];
  const releases: string[] = [];
  await page.route(LIVE_OWNER, async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      held.push(route);
      return;
    }
    if (method === "DELETE") releases.push("release");
    await route.continue();
  });

  // The first re-claim is never answered. It times out well inside the interval, so the next tick still re-claims.
  await page.clock.fastForward(REFRESH_MS);
  await expect.poll(() => held.length).toBe(1);
  // Stepped in two jumps, as real time would pass: the deadline (10 s) fires and settles before the next tick is due.
  await page.clock.fastForward(10_000);
  await page.clock.fastForward(REFRESH_MS - 10_000);
  await expect.poll(() => held.length).toBe(2);
  await expect(live.locator("[data-ownership='owner']")).toBeVisible();

  // Detach waits for the re-claim on its way: nothing is released while it is still out.
  await live.locator("[data-detach-widget='true']").click();
  await page.waitForTimeout(300);
  expect(releases).toEqual([]);
  expect(await shellCalls(page)).toEqual([]);

  await held[1]?.continue();
  await expect.poll(() => releases).toEqual(["release"]);
  await expect.poll(() => shellCalls(page)).toEqual(["detach"]);
});

test("a re-claim that never lands does not stall Detach past its bound", async ({ page }) => {
  const live = await openOwnedLiveWidget(page, "records");
  await expect(live.locator("[data-ownership='owner']")).toBeVisible({ timeout: 30_000 });

  let reclaims = 0;
  const releases: string[] = [];
  await page.route(LIVE_OWNER, async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      // Held for good: a node that accepted the call and never answers.
      reclaims += 1;
      return;
    }
    if (method === "DELETE") releases.push("release");
    await route.continue();
  });
  await page.clock.fastForward(REFRESH_MS);
  await expect.poll(() => reclaims).toBe(1);

  await live.locator("[data-detach-widget='true']").click();
  await page.waitForTimeout(300);
  expect(releases).toEqual([]);
  await page.clock.fastForward(5_000);
  await expect.poll(() => releases).toEqual(["release"]);
  await expect.poll(() => shellCalls(page)).toEqual(["detach"]);
});

test("a surface that could not read its widget recovers once a re-claim succeeds and the read does", async ({ page }) => {
  let failReads = false;
  const live = await openOwnedLiveWidget(page, "records", async () => {
    // The first read of the opened surface fails; every read after it is answered by the node.
    failReads = true;
    await page.route(LIVE_READ, async (route) => {
      if (route.request().method() === "GET" && failReads) {
        failReads = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "the widget could not be read" } }) });
        return;
      }
      await route.continue();
    });
  });
  await expect(live.locator("[data-ownership='error']")).toBeVisible({ timeout: 30_000 });

  await page.clock.fastForward(REFRESH_MS);
  await expect(live.locator("[data-ownership='owner']")).toBeVisible({ timeout: 10_000 });
  await expect(live.locator("[data-detach-widget='true']")).toBeVisible();
});

/*
 * A widget's files from a detached window, end to end against the real node.
 *
 * The test process stands in for the desktop host, as `main.mjs` performs each relay: it holds the node's token, calls
 * the bound instance's routes, picks and saves "in the OS dialog" itself, and tells the conversation window when a file
 * was attached. The detached page holds no token and names no instance; the conversation page hears only the push.
 */
const PICKED_TEXT = "ghi chu tu cua so rieng\n".repeat(40);
const COPY_TEXT = PICKED_TEXT.slice(0, 2_000).toUpperCase();

function nodeAnswer(status: number, body: Record<string, unknown>): Record<string, unknown> {
  if (status >= 200 && status < 300) return { ok: true, ...body };
  return { ok: false, code: String(body["code"] ?? "UNKNOWN"), refused: String(body["message"] ?? `status ${String(status)}`) };
}

test("a widget in a detached window exports through the host and attaches into the conversation's composer", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  if (NODE_PORT === undefined || NODE_PORT === "") throw new Error("CC_E2E_NODE_PORT is not set; run this suite through playwright.config.ts");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const shell = await context.newPage();
  // The conversation window, with the one desktop push this journey needs.
  await shell.addInitScript(() => {
    if (window.top !== window) return;
    (window as unknown as { clarkcant: unknown }).clarkcant = {
      onArtifactAttached: (listener: (payload: unknown) => void) => {
        (window as unknown as { __pushAttached: (payload: unknown) => void }).__pushAttached = listener;
        return () => undefined;
      },
    };
  });
  await shell.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(shell.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  await say(shell, "widget tệp");
  const open = shell.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  const instanceId = await open.getAttribute("data-open-live");
  const conversationId = await shell.evaluate(() => window.sessionStorage.getItem("cc_conversation"));
  if (instanceId === null || conversationId === null) throw new Error("the conversation did not place the file widget");

  const widget = `/conversations/${encodeURIComponent(conversationId)}/widgets/${encodeURIComponent(instanceId)}`;
  const node = async (path: string, init: { method: string; body?: unknown }) => {
    const response = await fetch(`${GATEWAY}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return response;
  };
  const json = async (path: string, init: { method: string; body?: unknown }) => {
    const response = await node(path, init);
    return nodeAnswer(response.status, (await response.json().catch(() => ({}))) as Record<string, unknown>);
  };
  const frameRead = async () => {
    const read = await json(`${widget}/live`, { method: "GET" });
    if (read.ok !== true) return read;
    const { ok: _ok, ...live } = read as { ok: true; frame?: { url: string } | null };
    return { ok: true, live: { ...live, frame: live.frame ? { ...live.frame, url: new URL(live.frame.url, GATEWAY).toString() } : null } };
  };
  const asked: Array<{ verb: string; payload: unknown }> = [];
  let pickedName: string | undefined;

  const detached = await context.newPage();
  await detached.exposeFunction("__hostRelay", async (verb: string, payload: Record<string, unknown> | null) => {
    asked.push({ verb, payload });
    const p = payload ?? {};
    const artifact = (rest = "") => `${widget}/artifacts/${encodeURIComponent(String(p["artifactId"]))}${rest}`;
    switch (verb) {
      case "bootstrap": {
        const read = await frameRead();
        return read.ok === true ? { ok: true, bootstrap: { instanceRef: instanceId, title: "widget tệp", widgetKind: "widget", live: read["live"] } } : read;
      }
      case "frame.read":
        return frameRead();
      case "state.save": {
        const saved = await json(`${widget}/state`, { method: "POST", body: p });
        return saved.ok === true ? { ok: true, saved } : saved;
      }
      case "semantic.publish":
        return json(`${widget}/semantic`, { method: "POST", body: { proposal: p["proposal"] } });
      case "dev.session":
        return { ok: false, code: "NO_DEV_SESSION", refused: "no dev session" };
      case "release":
        return { ok: true };
      case "artifacts.pick": {
        // The person's choice in the OS dialog: the bytes go from the host to the node, and only the bare name comes back.
        pickedName = "ghi-chu.txt";
        const picked = await json(`${widget}/artifacts/pick`, {
          method: "POST",
          body: { accept: p["accept"] ?? [], name: pickedName, mimeType: "text/plain", contentBase64: Buffer.from(PICKED_TEXT).toString("base64") },
        });
        return picked.ok === true ? { ok: true, canceled: false, artifactRef: picked["artifactRef"], original: { name: pickedName } } : picked;
      }
      case "artifacts.describe":
        return json(artifact(), { method: "GET" });
      case "artifacts.create":
        return json(`${widget}/artifacts`, { method: "POST", body: p });
      case "artifacts.read":
        return json(artifact(`/content?offset=${String(p["offset"])}&length=${String(p["length"])}`), { method: "GET" });
      case "artifacts.write":
        return json(artifact("/chunks"), { method: "POST", body: { offset: p["offset"], contentBase64: p["chunkBase64"] } });
      case "artifacts.finalize":
        return json(artifact("/finalize"), { method: "POST", body: {} });
      case "artifacts.export": {
        const described = await json(artifact(), { method: "GET" });
        if (described.ok !== true) return described;
        const exported = await node(`/artifacts/${encodeURIComponent(String(p["artifactId"]))}/export`, {
          method: "POST",
          body: { suggestedName: p["suggestedName"] },
        });
        if (!exported.ok) return nodeAnswer(exported.status, (await exported.json()) as Record<string, unknown>);
        // Save As, answered: the host writes the bytes where the person chose, and tells the window only that it did.
        const name = String(p["suggestedName"]);
        writeFileSync(testInfo.outputPath(name), Buffer.from(await exported.arrayBuffer()));
        return { ok: true, saved: true, name };
      }
      case "artifacts.attach": {
        const attached = await json(artifact("/attach"), { method: "POST", body: p["name"] === undefined ? {} : { name: p["name"] } });
        if (attached.ok === true) {
          const push = { conversationId, attachmentRef: attached["attachmentRef"] };
          await shell.evaluate((payload) => (window as unknown as { __pushAttached: (value: unknown) => void }).__pushAttached(payload), push);
        }
        return attached;
      }
      case "artifacts.discard":
        return json(artifact(), { method: "DELETE" });
      default:
        return { ok: false, code: "RELAY_REFUSED", refused: `the stand-in host does not relay ${verb}` };
    }
  });
  await detached.addInitScript(() => {
    if (window.top !== window) return;
    const relay = (verb: string, payload?: unknown) =>
      (window as unknown as { __hostRelay: (verb: string, payload: unknown) => Promise<unknown> }).__hostRelay(verb, payload ?? null);
    const verbs = (family: string, names: string[]) => Object.fromEntries(names.map((name) => [name, (input?: unknown) => relay(`${family}.${name}`, input)]));
    (window as unknown as { clarkcantDetached: unknown }).clarkcantDetached = {
      bootstrap: () => relay("bootstrap"),
      frameRead: () => relay("frame.read"),
      saveState: (write: unknown) => relay("state.save", write),
      publishSemantic: (input: unknown) => relay("semantic.publish", input),
      devSession: () => relay("dev.session"),
      intent: (input: unknown) => relay("intent", input),
      release: () => relay("release"),
      artifacts: verbs("artifacts", ["pick", "describe", "create", "read", "write", "finalize", "export", "attach", "discard"]),
      jobs: verbs("jobs", ["get", "list", "cancel"]),
      tokens: verbs("tokens", ["request", "end"]),
    };
  });
  await detached.goto("/?detached=1");

  const surface = detached.locator("[data-detached-surface='true']");
  await expect(surface.locator("[data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
  const frame = detached.frameLocator("[data-widget-frame] iframe");
  await expect(frame.locator("[data-widget-ready]")).toHaveCount(1, { timeout: 20_000 });
  await expect(frame.locator("[data-artifact-available='true']")).toHaveCount(1);

  // The pick is the host's: the window's own question, then the "OS dialog" the host opens over it.
  await frame.locator("[data-artifact-pick]").click();
  await detached.locator("[data-artifact-prompt='pick'] [data-artifact-choose]").click();
  await expect(frame.locator("[data-artifact-status='picked']")).toHaveCount(1, { timeout: 20_000 });
  await frame.locator("[data-artifact-read]").click();
  await expect(frame.locator("[data-artifact-status='read']")).toHaveCount(1, { timeout: 20_000 });
  await frame.locator("[data-artifact-create]").click();
  await expect(frame.locator("[data-artifact-status='finalized']")).toHaveCount(1, { timeout: 20_000 });

  // Save As in the window's own chrome; replacing the file picked in this window is offered, by name.
  await frame.locator("[data-artifact-export]").click();
  const savePrompt = detached.locator("[data-artifact-prompt='export']");
  await expect(savePrompt).toBeVisible();
  await expect(savePrompt.locator("[data-artifact-replace]")).toContainText("ghi-chu.txt");
  await expect(savePrompt.locator("[data-artifact-web-original]")).toHaveCount(0);
  await savePrompt.locator("[data-artifact-save]").click();
  await expect(frame.locator("[data-artifact-status='saved']")).toHaveCount(1, { timeout: 20_000 });
  await expect(detached.locator("[data-artifact-notice='info']")).toContainText("ban-viet-hoa.txt");
  expect(readFileSync(testInfo.outputPath("ban-viet-hoa.txt"), "utf8")).toBe(COPY_TEXT);
  await detached.screenshot({ path: testInfo.outputPath("detached-artifact-saved.png"), fullPage: true });

  // Attaching puts the copy in the conversation's composer, not the detached window's.
  await frame.locator("[data-artifact-attach]").click();
  await expect(frame.locator("[data-artifact-status='attached']")).toHaveCount(1, { timeout: 20_000 });
  const chip = shell.locator("[data-attachment-chip]").last();
  await expect(chip).toHaveAttribute("data-attachment-state", "ready", { timeout: 20_000 });
  await expect(chip).toContainText("ban-viet-hoa.txt");
  await expect(detached.locator("[data-attachment-chip]")).toHaveCount(0);
  await shell.screenshot({ path: testInfo.outputPath("shell-attached-chip.png"), fullPage: true });

  // Every relay named only the frame's own request: never the instance, the conversation or a path.
  const verbsAsked = new Set(asked.map((entry) => entry.verb));
  for (const verb of ["artifacts.pick", "artifacts.read", "artifacts.create", "artifacts.write", "artifacts.finalize", "artifacts.export", "artifacts.attach"]) {
    expect(verbsAsked.has(verb), verb).toBe(true);
  }
  for (const entry of asked) {
    expect(JSON.stringify(entry.payload ?? {})).not.toMatch(/instanceId|conversationId|widget_|conv_/);
  }
  expect(await detached.evaluate(() => [window.sessionStorage.getItem("cc_token"), window.localStorage.getItem("cc_token")])).toEqual([null, null]);
  await context.close();
});