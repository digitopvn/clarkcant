import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

import { DEFAULT_EXECUTION_POLICY_CONFIG } from "@clarkcant/contracts";

import { startFakeConnector } from "../../../examples/reference-apps/connected-app/dev/fake-connector.mjs";

/**
 * The reference connected app, end to end: a package whose widget and service work on an account the node connects.
 *
 * The provider is the app's fake connector — a test fixture with real PKCE, state, scope grants, refresh and revocation
 * on loopback, and no real account. The person connects it from Settings; the provider page opens in its own browser
 * tab, never in the widget, and sends that tab back to the node. The service runs in a container with no network and
 * reaches the provider only through the node, which adds the token. The widget's buttons, Clark's `invoke_capability`
 * and a spoken command call the same capabilities; revoking makes them not ready with the reason, reconnecting brings
 * them back, a partial grant names the missing scope, and a rename whose answer never comes back is recorded as unknown
 * and not sent again. No code, token or refresh token appears in the frame, in anything the node keeps outside its own
 * token table, or in the container's environment.
 *
 * Needs a container engine that runs Linux containers, as the notes service journey does.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.clarkcant.reference.connected-app";
const LIST_REF = `${PACKAGE}.list-tasks@1`;
const CAPABILITIES = [LIST_REF, `${PACKAGE}.update-task@1`];
const FRAME = "[data-pin-live] [data-widget-frame]";
/** The ports the reference manifest names for the fake connector. */
const CONNECTOR_PORT = 8880;
const CONNECTOR_ADMIN_PORT = 8881;

type Connector = Awaited<ReturnType<typeof startFakeConnector>>;
let connector: Connector;

function identity(): { token: string; nodeId: string } {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown; nodeId?: unknown };
  if (typeof parsed.localToken !== "string" || typeof parsed.nodeId !== "string") throw new Error("no identity");
  return { token: parsed.localToken, nodeId: parsed.nodeId };
}

function headers(): Record<string, string> {
  return { authorization: `Bearer ${identity().token}` };
}

/** Whether this node has the package installed. */
async function isInstalled(request: APIRequestContext): Promise<boolean> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: headers() })).json()) as { packages: { packageId: string }[] };
  return listed.packages.some((entry) => entry.packageId === PACKAGE);
}

/** Uninstall the package, which forgets its account too. */
async function uninstall(request: APIRequestContext): Promise<void> {
  const answer = await request.post(`${GATEWAY}/packages/${encodeURIComponent(PACKAGE)}/uninstall`, { headers: headers() });
  expect(answer.ok(), `uninstall answered ${String(answer.status())}: ${await answer.text()}`).toBe(true);
}

/**
 * The package installed with no account connected, through the marketplace's install. One an earlier attempt left
 * installed — perhaps connected — is uninstalled first, which forgets its account; installing again after that is a
 * fresh install like the first.
 */
async function freshInstall(request: APIRequestContext): Promise<void> {
  if (await isInstalled(request)) await uninstall(request);
  const answer = await request.post(`${GATEWAY}/packages/install`, {
    headers: headers(),
    data: { packageId: PACKAGE, version: "1.0.0", localDigest: "sha256:connected-app-reference-digest" },
  });
  expect(answer.ok(), `install answered ${String(answer.status())}: ${await answer.text()}`).toBe(true);
}

async function setPolicy(request: APIRequestContext, mode: "guarded" | "autonomous"): Promise<void> {
  const result = await request.put(`${GATEWAY}/preferences/execution.policy`, {
    headers: headers(),
    data: { value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode } },
  });
  expect(result.ok()).toBe(true);
}

async function connectionState(request: APIRequestContext): Promise<{ state: string; reason?: string; missingScopes: string[] }> {
  const answer = await request.get(`${GATEWAY}/packages/${encodeURIComponent(PACKAGE)}/connection`, { headers: headers() });
  expect(answer.ok()).toBe(true);
  return ((await answer.json()) as { connection: { state: string; reason?: string; missingScopes: string[] } }).connection;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${identity().token}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

/**
 * Place the connected app's widget and open it live, once the host has said what its buttons can do.
 *
 * Placed the way a model places it, through `place_widget` with both buttons bound to the package's own capabilities.
 * The fixture's hand-made placement remains for the one journey that needs a rename deadline shorter than a button's
 * default, which `place_widget` does not let a model set.
 */
async function openTasks(page: Page, placement: "place_widget" | "fixture" = "place_widget"): Promise<FrameLocator> {
  if (placement === "fixture") {
    await say(page, "widget công việc");
  } else {
    // A model places a widget's capability buttons once `list` shows them: the node registers a service's capabilities
    // as it starts it, ready or not, and a fresh install may not have reached that yet.
    await expect
      .poll(
        async () => {
          const listed = (await (await page.request.get(`${GATEWAY}/capabilities`, { headers: headers() })).json()) as { capabilities: { ref: string }[] };
          return CAPABILITIES.every((ref) => listed.capabilities.some((entry) => entry.ref === ref));
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(true);
    await say(page, "place widget com.clarkcant.reference.connected-app.main@1");
    await expect(page.getByText(/Fixture: tui gọi place_widget .*Placed /u).last()).toBeVisible({ timeout: 20_000 });
  }
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  // A conversation that opened one before keeps it pinned, so the newest frame is the one just opened.
  await expect(page.locator(FRAME).last()).toHaveAttribute("data-frame-status", "ready", { timeout: 30_000 });
  const widget = page.locator(`${FRAME} iframe`).last().contentFrame();
  await expect(widget.locator("#root[data-tasks-announced='true']")).toBeVisible({ timeout: 30_000 });
  return widget;
}

/** Wait until the widget's list button can run: the container is up and the connection grants what it needs. */
async function listReady(widget: FrameLocator): Promise<void> {
  // The first start fetches the image and starts Node in a container; the frame re-reads availability every few seconds.
  await expect(widget.locator("#root[data-tasks-list-ready='true']")).toBeVisible({ timeout: 180_000 });
}

/** Connect (or reconnect) from Settings: the provider opens in its own tab, which the node finishes on its own. */
async function connectFromSettings(page: Page, expected: "connected" | "partial"): Promise<void> {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-extensions")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-extensions").click();
  const row = page.locator(`[data-package-connection="${PACKAGE}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const popup = page.context().waitForEvent("page");
  await row.locator(`[data-connection-connect="${PACKAGE}"]`).click();
  const provider = await popup;
  // The tab the provider sent back lands on the node's own page, which never repeats the code.
  await expect(provider.locator("[data-connection-result]")).toHaveAttribute("data-connection-result", "connected", { timeout: 20_000 });
  const landed = await provider.content();
  for (const secret of connector.secrets()) expect(landed).not.toContain(secret);
  await provider.close();
  await expect(row).toHaveAttribute("data-connection-state", expected, { timeout: 15_000 });
}

/** Everything the node keeps, outside the one table that holds the tokens, as text. */
function nodeRecordsText(): string {
  const db = new DatabaseSync(join(DATA_DIR, "node.sqlite"), { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    return tables
      .filter((table) => table.name !== "package_connection_tokens")
      .map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table.name}"`).all()))
      .join("\n");
  } finally {
    db.close();
  }
}

/** Every file under the node's data directory except its database, read as text: logs, caches, the package cache. */
function dataDirFilesText(dir = DATA_DIR): string {
  let text = "";
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) text += dataDirFilesText(path);
    else if (!name.startsWith("node.sqlite")) text += readFileSync(path, "latin1");
  }
  return text;
}

/** The connected app's service container, found among this node's by the package folder it mounts. */
function serviceContainer(): { networkMode: string; env: string[] } | undefined {
  const ids = execFileSync("docker", ["ps", "--quiet", "--filter", `label=clarkcant.node=${identity().nodeId}`], { encoding: "utf8" })
    .split(/\s+/)
    .filter((id) => id !== "");
  for (const id of ids) {
    const [inspected] = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8" })) as {
      HostConfig: { NetworkMode: string };
      Config: { Env: string[] | null };
      Mounts: { Source: string }[];
    }[];
    if (inspected?.Mounts.some((mount) => mount.Source.replaceAll("\\", "/").includes("connected-app")) === true) {
      return { networkMode: inspected.HostConfig.NetworkMode, env: inspected.Config.Env ?? [] };
    }
  }
  return undefined;
}

test.describe.configure({ mode: "serial" });

/*
 * The journeys run in order on one node, and a retry runs this hook again in a new worker after an earlier journey has
 * already connected the account. Starting from a fresh install, which keeps no account, is what lets the first journey
 * find the account not connected on a retry too.
 */
test.beforeAll(async ({ request }) => {
  connector = await startFakeConnector({ port: CONNECTOR_PORT, adminPort: CONNECTOR_ADMIN_PORT });
  await freshInstall(request);
});

/*
 * Left as the suite found it: no package, no account and no service container of this journey's running while the
 * specs after it do, and the default policy back in place.
 */
test.afterAll(async ({ request }) => {
  await setPolicy(request, "autonomous");
  if (await isInstalled(request)) await uninstall(request);
  await connector.close();
});

test("before connecting, the widget says the account is not connected", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const widget = await openTasks(page);
  await expect(widget.locator("[data-tasks-unavailable]")).toContainText("is not connected", { timeout: 180_000 });
  await expect(widget.locator("[data-tasks-load]")).toBeDisabled();
});

test("connecting from Settings makes the widget's list and rename work through the policy", async ({ page, request }) => {
  test.setTimeout(300_000);
  await connectFromSettings(page, "connected");
  expect((await connectionState(request)).state).toBe("connected");

  await openApp(page);
  const widget = await openTasks(page);
  await listReady(widget);
  await widget.locator("[data-tasks-load]").click();
  const output = widget.locator("[data-tasks-output]");
  await expect(output).toHaveAttribute("data-tasks-state", "done", { timeout: 30_000 });
  await expect(widget.locator("li[data-task-id]")).toHaveCount(3);

  // A rename is an external write: under a guarded policy the host asks in the conversation, and nothing is sent first.
  await setPolicy(request, "guarded");
  try {
    const before = connector.stats().writes;
    await widget.locator('[data-task-title="task-1"]').fill("Viết báo cáo tháng");
    await widget.locator('[data-task-save="task-1"]').click();
    // The press does not finish in the frame: the host says it is waiting for the person, in the person's language.
    await expect(output).toHaveAttribute("data-tasks-state", "not-done", { timeout: 30_000 });
    await expect(output).toContainText(/duyệt|approv/i);
    expect(connector.stats().writes).toBe(before);
    const card = page.locator('[data-host-card="approval"][data-decision="pending"]').last();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.locator("[data-approve]").click();
    await expect.poll(() => connector.stats().writes, { timeout: 30_000 }).toBe(before + 1);
    expect(connector.stats().tasks.find((task: { id: string }) => task.id === "task-1")?.title).toBe("Viết báo cáo tháng");
  } finally {
    await setPolicy(request, "autonomous");
  }

  // Under the default policy the same press runs, and the frame shows what the provider answered.
  await widget.locator('[data-task-title="task-2"]').fill("Gọi lại nhà cung cấp lúc 3 giờ");
  await widget.locator('[data-task-save="task-2"]').click();
  await expect(output).toHaveAttribute("data-tasks-state", "done", { timeout: 30_000 });
  await expect(output).toContainText("Gọi lại nhà cung cấp lúc 3 giờ");
});

test("the agent and a spoken command call the same capability, through the same broker", async ({ page, request }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const readsBefore = connector.stats().reads;

  await say(page, "đọc công việc");
  await expect(page.getByText(`Đã gọi ${LIST_REF}`).last()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => connector.stats().reads, { timeout: 10_000 }).toBe(readsBefore + 1);

  const widget = await openTasks(page);
  await listReady(widget);
  const scripted = await request.post(`${GATEWAY}/voice-fixture/words`, { headers: headers(), data: { words: "tải công việc" } });
  expect(scripted.status()).toBe(200);
  await page.locator('[data-voice-open="true"]').click();
  // What voice reads back is the service's answer, which names the task the widget renamed.
  await expect(page.getByText(/Đã Tải công việc\..*Viết báo cáo tháng/).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => connector.stats().reads, { timeout: 10_000 }).toBe(readsBefore + 2);
  // The very first sentence was the widget's action: the node knew which widget was open before it heard anything, so
  // no sentence fell through to the agent, which has no such capability of its own to offer.
  await expect(page.locator('[data-host-card="system"][data-subject="capability"][data-status="blocked"]')).toHaveCount(0);

  // One trail: every request any of them made went through the node's egress broker with the connection.
  const db = new DatabaseSync(join(DATA_DIR, "node.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT summary FROM audit_log WHERE kind = 'egress' AND ref = ? AND summary LIKE '%with the fake.tasks connection%'")
      .all(PACKAGE) as { summary: string }[];
    expect(rows.some((row) => row.summary.includes(`GET http://127.0.0.1:${String(CONNECTOR_PORT)}`))).toBe(true);
    expect(rows.some((row) => row.summary.includes(`PATCH http://127.0.0.1:${String(CONNECTOR_PORT)}`))).toBe(true);
  } finally {
    db.close();
  }
});

test("revoking makes the capabilities not ready with the reason, and reconnecting restores them", async ({ page, request }) => {
  test.setTimeout(300_000);
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-extensions").click();
  const row = page.locator(`[data-package-connection="${PACKAGE}"]`);
  await row.locator(`[data-connection-revoke="${PACKAGE}"]`).click();
  await expect(row).toHaveAttribute("data-connection-state", "revoked", { timeout: 15_000 });
  await expect(row.locator("[data-connection-reason]")).toContainText("revoked");

  await openApp(page);
  const widget = await openTasks(page);
  await expect(widget.locator("[data-tasks-unavailable]")).toContainText("was revoked", { timeout: 30_000 });
  await expect(widget.locator("[data-tasks-load]")).toBeDisabled();

  // The agent is told the same, and nothing reaches the provider.
  const readsBefore = connector.stats().reads;
  await say(page, "đọc công việc");
  const refusal = page.locator("p", { hasText: "CAPABILITY_NOT_AUTHENTICATED" }).last();
  await expect(refusal).toBeVisible({ timeout: 60_000 });
  await expect(refusal).toContainText("connection was revoked; reconnect it in Settings");
  expect(connector.stats().reads).toBe(readsBefore);

  await connectFromSettings(page, "connected");
  await openApp(page);
  const restored = await openTasks(page);
  await listReady(restored);
  await restored.locator("[data-tasks-load]").click();
  await expect(restored.locator("[data-tasks-output]")).toHaveAttribute("data-tasks-state", "done", { timeout: 30_000 });

  // A provider that revokes on its side is noticed on the next call, and the capabilities say so at once.
  connector.revokeAll();
  await restored.locator("[data-tasks-load]").click();
  await expect(restored.locator("[data-tasks-output]")).toHaveAttribute("data-tasks-state", "not-done", { timeout: 30_000 });
  await expect.poll(async () => (await connectionState(request)).state, { timeout: 15_000 }).toBe("revoked");
  await expect(restored.locator("[data-tasks-unavailable]")).toContainText("was revoked", { timeout: 30_000 });
});

test("a partial grant names the missing scope, and only what needs it stops", async ({ page, request }) => {
  test.setTimeout(300_000);
  connector.setMode({ grantScopes: ["tasks.read"] });
  try {
    await connectFromSettings(page, "partial");
    const status = await connectionState(request);
    expect(status.missingScopes).toEqual(["tasks.write"]);
    expect(status.reason).toContain("tasks.write");

    await openApp(page);
    const widget = await openTasks(page);
    await listReady(widget);
    await expect(widget.locator("#root[data-tasks-update-ready='false']")).toBeVisible({ timeout: 30_000 });
    await expect(widget.locator("[data-tasks-unavailable]")).toContainText("did not grant tasks.write");
    await widget.locator("[data-tasks-load]").click();
    await expect(widget.locator("[data-tasks-output]")).toHaveAttribute("data-tasks-state", "done", { timeout: 30_000 });
  } finally {
    connector.setMode({ grantScopes: null });
  }
  await connectFromSettings(page, "connected");
});

test("a rename whose answer never comes back is recorded as unknown and not sent again", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const widget = await openTasks(page, "fixture");
  await listReady(widget);
  await widget.locator("[data-tasks-load]").click();
  const output = widget.locator("[data-tasks-output]");
  await expect(output).toHaveAttribute("data-tasks-state", "done", { timeout: 30_000 });

  // The provider applies the write and then holds its answer past the button's deadline.
  connector.setMode({ writeDelayMs: 15_000 });
  try {
    const before = connector.stats().writes;
    await widget.locator('[data-task-title="task-3"]').fill("Dọn hộp thư lần nữa");
    await widget.locator('[data-task-save="task-3"]').click();
    await expect(output).toHaveAttribute("data-tasks-state", "not-done", { timeout: 30_000 });
    await expect(output).toContainText("unknown");
    await expect(output).toContainText("not retried");
    expect(connector.stats().writes).toBe(before + 1);
    // Long enough for any retry to have reached the provider; none does.
    await page.waitForTimeout(17_000);
    expect(connector.stats().writes).toBe(before + 1);

    // The ledger holds it as unknown until the person says what they saw. The fake did apply it, so answer that, as the
    // inbox's own button would; the journeys after this one share the node and expect no question left over.
    const db = new DatabaseSync(join(DATA_DIR, "node.sqlite"), { readOnly: true });
    let unknown: string[];
    try {
      unknown = (
        db
          .prepare("SELECT effect_id FROM effects WHERE capability_ref = ? AND state = 'unknown'")
          .all("com.clarkcant.reference.connected-app.update-task@1") as Array<{ effect_id: string }>
      ).map((row) => row.effect_id);
    } finally {
      db.close();
    }
    expect(unknown).toHaveLength(1);
    for (const effectId of unknown) {
      const answered = await page.request.post(`${GATEWAY}/effects/${effectId}/reconcile`, { headers: headers(), data: { outcome: "confirmed" } });
      expect(answered.status()).toBe(200);
    }
  } finally {
    connector.setMode({ writeDelayMs: 0 });
  }
});

test("no code or token reaches the frame, the node's records, its files or the service's container", async ({ page }) => {
  test.setTimeout(240_000);
  const secrets = connector.secrets();
  expect(secrets.length).toBeGreaterThan(0);

  await openApp(page);
  const widget = await openTasks(page);
  await listReady(widget);
  await widget.locator("[data-tasks-load]").click();
  await expect(widget.locator("[data-tasks-output]")).toHaveAttribute("data-tasks-state", "done", { timeout: 30_000 });

  const frameText = await widget.locator("html").evaluate((element) => element.outerHTML);
  const pageText = await page.content();
  const records = nodeRecordsText();
  const files = dataDirFilesText();
  for (const secret of secrets) {
    expect(frameText, "the frame").not.toContain(secret);
    expect(pageText, "the host page").not.toContain(secret);
    expect(records, "the node's records outside its token table").not.toContain(secret);
    expect(files, "the node's files").not.toContain(secret);
  }

  const container = serviceContainer();
  expect(container, "the node should be running the connected app's service in a container").toBeDefined();
  expect(container?.networkMode).toBe("none");
  const env = (container?.env ?? []).join("\n");
  for (const secret of secrets) expect(env, "the container's environment").not.toContain(secret);
});
