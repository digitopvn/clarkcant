import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type FrameLocator, type Locator, type Page } from "@playwright/test";

/**
 * A package that asks for a larger resource profile and reaches a provider without ever holding its key.
 *
 * The lookup package's service runs in a container with no network. Its one capability asks the node, over the MCP
 * channel, to fetch a URL on the origin the package declared; the node adds the key the person stored for this package
 * and removes it from whatever comes back. The provider here is a local fake on that origin: it checks the header and
 * echoes it, so the answer shows the node's redaction rather than a provider's good manners.
 *
 * The widget beside it may hold a short-lived browser token from a provider that can scope one. The token reaches its
 * frame and stays there: not in the page, the widget's state, the transcript or the node's files, and it is revoked when
 * the frame goes. The providers are the node's in-process fixture (`CC_BROWSER_TOKEN_FIXTURE=1`), minting random values.
 *
 * Needs a container engine that runs Linux containers, like the notes-service journeys.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.example.lookup";
const SECRET = "LOOKUP_API_KEY";
/** The origin the fixture package declares. Fixed, because a declared origin is part of what the person consented to. */
const PROVIDER_PORT = 8879;
const FRAME = "[data-pin-live] [data-widget-frame]";
const LIVE_READ = /\/conversations\/([^/]+)\/widgets\/([^/]+)\/live$/;

// Generated for this run, so nothing in the repository could be mistaken for a provider's key.
const KEY = `fake-lookup-key-${randomBytes(16).toString("hex")}`;

function identity(): { token: string; nodeId: string } {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown; nodeId?: unknown };
  if (typeof parsed.localToken !== "string" || typeof parsed.nodeId !== "string") throw new Error("no identity");
  return { token: parsed.localToken, nodeId: parsed.nodeId };
}
const auth = (): Record<string, string> => ({ authorization: `Bearer ${identity().token}` });

/** What the fake provider saw: the authorization header of each request, which only the node could have added. */
const seen: { path: string; authorization: string | undefined }[] = [];
let provider: Server | undefined;

function startProvider(): Promise<Server> {
  const server = createServer((request, response) => {
    seen.push({ path: request.url ?? "", authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${KEY}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not signed in" }));
      return;
    }
    const word = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("word") ?? "";
    response.writeHead(200, { "content-type": "application/json" });
    // Echoes the header back on purpose: a provider that leaks the key in its answer is what redaction is for.
    response.end(JSON.stringify({ word, definition: `a fixture definition of ${word}`, youSent: request.headers.authorization }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PROVIDER_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function installedPackages(request: APIRequestContext): Promise<string[]> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: auth() })).json()) as { packages: { packageId: string }[] };
  return listed.packages.map((entry) => entry.packageId);
}

/** Starts without the package, so the person sees what it reaches before it is installed. */
async function uninstall(request: APIRequestContext): Promise<void> {
  if (!(await installedPackages(request)).includes(PACKAGE)) return;
  const removed = await request.post(`${GATEWAY}/packages/${encodeURIComponent(PACKAGE)}/uninstall`, { headers: auth() });
  expect(removed.ok(), `uninstall answered ${String(removed.status())}: ${await removed.text()}`).toBe(true);
}

const POLICY_KEY = "execution.policy";

async function storedPolicy(request: APIRequestContext): Promise<Record<string, unknown>> {
  const listed = (await (await request.get(`${GATEWAY}/preferences`, { headers: auth() })).json()) as {
    preferences: { key: string; value: unknown }[];
  };
  const policy = listed.preferences.find((entry) => entry.key === POLICY_KEY)?.value;
  if (typeof policy !== "object" || policy === null) throw new Error("the node reports no execution policy");
  return policy as Record<string, unknown>;
}

async function writePolicy(request: APIRequestContext, value: Record<string, unknown>): Promise<void> {
  const written = await request.put(`${GATEWAY}/preferences/${POLICY_KEY}`, { headers: auth(), data: { value } });
  expect(written.ok(), await written.text()).toBe(true);
}

/** The origin, the key by name with its purpose, and each browser-token provider with its scopes, as the listing shows them. */
async function expectReach(where: Locator): Promise<void> {
  const reach = where.locator("[data-package-reach='true']");
  await expect(reach).toBeVisible();
  await expect(reach.locator(`[data-reach-origin='http://127.0.0.1:${String(PROVIDER_PORT)}']`)).toContainText(SECRET);
  await expect(reach.locator(`[data-reach-secret='${SECRET}']`)).toContainText("Signs the lookups in with the provider.");
  await expect(reach.locator("[data-reach-token='fixture.maps']")).toContainText("tiles:read");
  await expect(reach.locator("[data-reach-token='fixture.unscoped']")).toContainText("everything");
}

/**
 * Records every bridge message each document receives. Run in every frame, so the top page holds what the widget sent
 * the host and the widget's frame holds what the host sent the widget.
 */
async function recordBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __ccBridge: string[] }).__ccBridge = store;
    window.addEventListener(
      "message",
      (event) => {
        try {
          store.push(JSON.stringify(event.data));
        } catch {
          store.push("<unserialisable>");
        }
      },
      true,
    );
  });
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${identity().token}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** Compose the lookup widget, open it live, and return the frame with the conversation and instance it was read for. */
async function openLookup(page: Page): Promise<{ widget: FrameLocator; liveUrl: string }> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("widget tra từ");
  await composer.press("Enter");
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  const liveRead = page.waitForResponse((response) => LIVE_READ.test(new URL(response.url()).pathname) && response.ok());
  await open.click();
  const liveUrl = (await liveRead).url();
  // The newest frame: a reload may also bring back the one opened before it.
  const frame = page.locator(FRAME).last();
  await expect(frame).toHaveAttribute("data-frame-status", "ready", { timeout: 30_000 });
  const widget = frame.locator("iframe").contentFrame();
  await expect(widget.locator("#root[data-lookup-announced='true']")).toBeVisible({ timeout: 30_000 });
  return { widget, liveUrl };
}

/** Everything the page can hold: its DOM, the widget's DOM, both bridge logs, and the page's storage. */
async function pageHoldings(page: Page, widget: FrameLocator): Promise<Record<string, string>> {
  const host = await page.evaluate(() => ({
    dom: document.documentElement.outerHTML,
    bridge: JSON.stringify((window as unknown as { __ccBridge?: string[] }).__ccBridge ?? []),
    storage: JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } }),
  }));
  const frame = await widget.locator("html").evaluate((root) => {
    let storage = "unavailable to an opaque origin";
    try {
      storage = JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } });
    } catch {
      // A sandboxed frame without allow-same-origin has no storage, which is the expected answer.
    }
    return {
      dom: root.outerHTML,
      bridge: JSON.stringify((window as unknown as { __ccBridge?: string[] }).__ccBridge ?? []),
      storage,
    };
  });
  return {
    "page DOM": host.dom,
    "messages the widget sent the host": host.bridge,
    "page storage": host.storage,
    "frame DOM": frame.dom,
    "messages the host sent the widget": frame.bridge,
    "frame storage": frame.storage,
  };
}

/** The containers this node started for its services, found by the label the node gives them. */
function serviceContainers(): string[] {
  const listed = execFileSync("docker", ["ps", "--quiet", "--filter", `label=clarkcant.node=${identity().nodeId}`], { encoding: "utf8" });
  return listed.split(/\s+/).filter((id) => id !== "");
}

/** Every file under the node's data directory, as text, for a value the node must never have written. */
function dataDirHolds(value: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) walk(path);
      else if (stats.size < 256 * 1024 * 1024 && readFileSync(path).includes(value)) found.push(path);
    }
  };
  walk(DATA_DIR);
  return found;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  provider = await startProvider();
  await uninstall(request);
});

test.afterAll(async ({ request }) => {
  // Left as the suite found it: the next specs count the node's credentials and packages.
  await request.delete(`${GATEWAY}/credentials/${SECRET}`, { headers: auth() });
  await request.post(`${GATEWAY}/packages/${encodeURIComponent(PACKAGE)}/uninstall`, { headers: auth() });
  await new Promise<void>((resolve) => (provider === undefined ? resolve() : provider.close(() => resolve())));
});

test("what the package reaches is listed before it is installed, in the install question, and in package details", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const previousPolicy = await storedPolicy(request);
  // Asks before anything is written locally, so the install waits as a question the person answers in the inbox.
  await writePolicy(request, { ...previousPolicy, rules: [{ effectCategory: "local-write", decision: "ask" }] });
  try {
    await openApp(page);
    const composer = page.locator("[data-composer='true']");
    await composer.waitFor();
    await composer.fill("tìm gói tra từ");
    await composer.press("Enter");

    // On the listing, above the Install button, before anything is granted.
    const listed = page.locator(`[data-marketplace-package='${PACKAGE}']`).last();
    await expect(listed).toBeVisible({ timeout: 20_000 });
    await expectReach(listed);
    expect(await installedPackages(request)).not.toContain(PACKAGE);
    // Names and purposes only: the key's value is not something the listing has.
    await expect(listed).not.toContainText(KEY);

    await listed.locator("[data-install-package]").click();
    const chip = listed.locator("[data-install-open-inbox]");
    await expect(chip).toBeVisible({ timeout: 20_000 });
    const approvalId = await chip.getAttribute("data-install-open-inbox");
    if (approvalId === null || approvalId === "") throw new Error("the waiting install names no approval");
    await chip.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator('[data-inbox-panel="ready"]')).toBeVisible({ timeout: 20_000 });
    const item = dialog.locator(`[data-inbox-waiting-key="install-approval:${approvalId}"]`);
    await expect(item).toBeVisible();
    // The question the person answers names the same reach, and nothing is installed until they do.
    await expectReach(item);
    expect(await installedPackages(request)).not.toContain(PACKAGE);

    /*
     * Declining leaves the node as it was. Approving is covered by the install-approval journey; this listing is a
     * local-path fixture, which installs only with a digest its caller computed, so it is installed over the API next.
     */
    await dialog.locator(`[data-inbox-deny="${approvalId}"]`).click();
    await expect(dialog.locator('[data-inbox-status="done"]')).toBeVisible({ timeout: 20_000 });
    expect(await installedPackages(request)).not.toContain(PACKAGE);
  } finally {
    await writePolicy(request, previousPolicy);
  }

  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers: auth(),
    data: { packageId: PACKAGE, version: "1.0.0", localDigest: "sha256:lookup-service-digest" },
  });
  expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);

  // Package details keep showing it, read from the installed manifest.
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-extensions").click();
  const row = page.locator(`[data-installed-package="${PACKAGE}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expectReach(row.locator("[data-installed-reach]"));
});

test("the granted profile is shown and applied, the provider is reached with a key the frame never sees", async ({ page, request }) => {
  test.setTimeout(300_000);
  await recordBridge(page);

  // Package details show what this node granted, in the person's units.
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-extensions").click();
  const row = page.locator(`[data-installed-package="${PACKAGE}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const resources = row.locator("[data-installed-resources]");
  await expect(resources).toHaveAttribute("data-installed-resources", "granted");
  await expect(resources).toHaveAttribute("data-resource-profile", "interactive-heavy");
  await expect(resources).toContainText("1 GiB");

  // Before the person gives the package its key, the button is off with the node's reason, and nothing was sent.
  await openApp(page);
  let { widget } = await openLookup(page);
  // The first start fetches the image and starts Node in a container; until then the reason is that it is starting.
  await expect(widget.locator("[data-lookup-unavailable]")).toContainText(SECRET, { timeout: 180_000 });
  await expect(widget.locator("#root[data-lookup-service='unavailable']")).toBeVisible();
  expect(seen).toEqual([]);

  const stored = await request.post(`${GATEWAY}/credentials`, {
    headers: auth(),
    data: { fields: [{ name: SECRET, value: KEY, kind: "token", consumer: `package:${PACKAGE}` }] },
  });
  expect(stored.status()).toBe(201);
  expect(await stored.text()).not.toContain(KEY);

  // The frame learns the service is signed in on its next read, without the service restarting.
  await expect(widget.locator("#root[data-lookup-service='available']")).toBeVisible({ timeout: 60_000 });
  await widget.locator("[data-lookup-word]").fill("orb");
  await widget.locator("[data-lookup-define]").click();
  const output = widget.locator("[data-lookup-output]");
  await expect(output).toHaveAttribute("data-lookup-state", "done", { timeout: 60_000 });
  await expect(output).toContainText("a fixture definition of orb");
  // The provider echoed the header; what reached the widget had the key removed by the node.
  await expect(output).toContainText("[redacted]");

  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual({ path: "/define?word=orb", authorization: `Bearer ${KEY}` });

  const holdings = await pageHoldings(page, widget);
  for (const [where, text] of Object.entries(holdings)) expect(text, `the key is in the ${where}`).not.toContain(KEY);

  // The service's container runs in the granted profile, and holds no key: not in its configuration, not in its process.
  const containers = serviceContainers();
  expect(containers.length, "the node should be running the lookup service in a container").toBeGreaterThan(0);
  const inspected = JSON.parse(execFileSync("docker", ["inspect", ...containers], { encoding: "utf8" })) as {
    Config: { Env: string[] | null };
    HostConfig: { Memory: number; NanoCpus: number; NetworkMode: string };
  }[];
  expect(inspected.some((entry) => entry.HostConfig.Memory === 1024 * 1024 * 1024 && entry.HostConfig.NanoCpus === 2_000_000_000)).toBe(true);
  for (const entry of inspected) {
    expect(entry.HostConfig.NetworkMode).toBe("none");
    expect(JSON.stringify(entry.Config.Env ?? [])).not.toContain(KEY);
  }
  for (const id of containers) {
    expect(execFileSync("docker", ["exec", id, "env"], { encoding: "utf8" })).not.toContain(KEY);
  }

  // A reload starts a fresh frame; the key is still nowhere it can reach.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  ({ widget } = await openLookup(page));
  for (const [where, text] of Object.entries(await pageHoldings(page, widget))) expect(text, `the key is in the ${where}`).not.toContain(KEY);
});

test("a scoped browser token reaches its frame and stays there, and is revoked when the frame goes", async ({ page, request }) => {
  test.setTimeout(180_000);
  await recordBridge(page);
  await openApp(page);
  const { widget, liveUrl } = await openLookup(page);
  const instanceId = LIVE_READ.exec(new URL(liveUrl).pathname)?.[2] ?? "";
  const conversationId = LIVE_READ.exec(new URL(liveUrl).pathname)?.[1] ?? "";
  expect(instanceId).not.toBe("");

  // A provider that cannot narrow a token is refused before it is asked.
  await widget.locator("[data-lookup-unscoped]").click();
  await expect(widget.locator("[data-lookup-token]")).toHaveAttribute("data-lookup-token", "refused", { timeout: 15_000 });
  await expect(widget.locator("[data-lookup-token]")).toContainText("TOKEN_PROVIDER_UNSCOPED");

  await widget.locator("[data-lookup-map]").click();
  await expect(widget.locator("[data-lookup-token]")).toHaveAttribute("data-lookup-token", "held", { timeout: 15_000 });
  // The widget tried to save it in its state; the runtime refused before anything left the frame.
  await expect(widget.locator("[data-lookup-token-leak]")).toHaveAttribute("data-lookup-token-leak", "refused");
  await expect(widget.locator("[data-lookup-token-leak]")).toContainText("TOKEN_NOT_ALLOWED");

  const issued = ((await (await request.get(`${GATEWAY}/browser-token-fixture/issued`, { headers: auth() })).json()) as {
    issued: { provider: string; token: string; scopes: string[]; instanceId: string; revoked: boolean }[];
  }).issued.filter((entry) => entry.instanceId === instanceId);
  expect(issued).toHaveLength(1);
  const minted = issued[0];
  if (minted === undefined) throw new Error("no token was minted for this frame");
  expect(minted).toMatchObject({ provider: "fixture.maps", scopes: ["tiles:read"], revoked: false });

  // By design the value travels once, from the host to this frame. Nowhere else.
  const holdings = await pageHoldings(page, widget);
  expect(holdings["messages the host sent the widget"]).toContain(minted.token);
  for (const [where, text] of Object.entries(holdings)) {
    if (where === "messages the host sent the widget") continue;
    expect(text, `the token is in the ${where}`).not.toContain(minted.token);
  }
  const live = await (await request.get(`${GATEWAY}/conversations/${conversationId}/widgets/${instanceId}/live`, { headers: auth() })).text();
  expect(live).not.toContain(minted.token);
  const timeline = await (await request.get(`${GATEWAY}/conversations/${conversationId}/timeline`, { headers: auth() })).text();
  expect(timeline).not.toContain(minted.token);
  expect(dataDirHolds(minted.token)).toEqual([]);

  // Closing the frame ends its session; the node revokes what that session was given.
  await page.locator("[data-close-live]").first().click();
  await expect
    .poll(
      async () =>
        ((await (await request.get(`${GATEWAY}/browser-token-fixture/issued`, { headers: auth() })).json()) as {
          issued: { tokenId: string; instanceId: string; revoked: boolean }[];
        }).issued.find((entry) => entry.instanceId === instanceId)?.revoked,
      { timeout: 15_000 },
    )
    .toBe(true);
});
