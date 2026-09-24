import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG, type WidgetDefinition } from "@clarkcant/contracts";
import {
  EXECUTION_POLICY_PREFERENCE_KEY,
  activeGeneration,
  createInstance,
  initialiseState,
  registerCapability,
  writeRegisteredPreference,
} from "@clarkcant/core";
import { allRows } from "@clarkcant/storage";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { createManagePackageTool } from "../src/manage-package-tool.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Uninstall, restore and roll back, through the node's routes.
 *
 * Two versions of one package sit in a directory the node reads, the way a marketplace would list them. The routes
 * decide which generation runs; the live route is where the person sees the consequence — a widget whose package is
 * gone shows its text alternative and the state it kept, and one whose package came back runs again.
 */

const AT = "2026-09-24T06:00:00.000Z";
const PACKAGE = "com.example.board";
const WIDGET_ID = "com.example.board.main@1";

function definition(version: string): WidgetDefinition {
  return {
    id: WIDGET_ID,
    version,
    renderer: "isolated-app",
    propsSchema: { type: "object", additionalProperties: true },
    eventSchemas: {},
    stateSchema: { type: "object" },
    stateVersion: 1,
    sizing: { compact: true, expanded: true },
    textFallback: `A task list, version ${version}.`,
    effectCategories: [],
    datasetRefs: [],
    semanticDescription: "A task list",
    requestedCapabilities: [],
  };
}

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;

function writePackage(root: string, version: string, requestedCapabilities: readonly string[] = []): void {
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  writeFileSync(join(root, "widgets", "main", "index.html"), "<!doctype html><div id=root></div>\n");
  writeFileSync(join(root, "widgets", "main", "widget.json"), JSON.stringify(definition(version)));
  writeFileSync(
    join(root, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PACKAGE,
      version,
      displayName: "Board",
      description: "A task board.",
      hostApi: { min: 1, max: 1 },
      facets: [
        { kind: "widget", id: WIDGET_ID, entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" },
      ],
      requestedCapabilities,
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
}

function entry(version: string, root: string) {
  return {
    packageId: PACKAGE,
    version,
    displayName: "Board",
    description: "A task board.",
    source: { kind: "local", path: root },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 1024,
    digest: `sha256:board-${version}`,
  };
}

/** Record a generation as the install supervisor does, retiring whatever was active. */
let tick = 0;
function recordInstall(version: string, digest = `sha256:board-${version}`, grantedCapabilities: readonly string[] = []): void {
  const db = services.runtime.db;
  const nodeId = services.runtime.identity.nodeId;
  const at = new Date(Date.UTC(2026, 8, 24, 5, 0, tick++)).toISOString();
  db.prepare("UPDATE package_generations SET superseded_at = ? WHERE package_id = ? AND node_id = ? AND superseded_at IS NULL").run(
    at,
    PACKAGE,
    nodeId,
  );
  const generation = {
    generationId: `${PACKAGE}@${version}:code_${version}`,
    packageId: PACKAGE,
    version,
    digest,
    nodeId,
    codeGeneration: `code_${version}`,
    activatedAt: at,
    uiOnlyFacets: ["ui"],
    grantedCapabilities,
  };
  db.prepare(
    `INSERT INTO package_generations
       (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(generation.generationId, PACKAGE, version, digest, nodeId, generation.codeGeneration, at, JSON.stringify(generation));
}

async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

function makeInstance(): string {
  return createInstance(services.conductor, {
    definition: definition("2.0.0"),
    packageDigest: "sha256:board-2.0.0",
    ownerPrincipalId: services.runtime.identity.ownerPrincipalId as never,
    props: {},
  }).instanceId;
}

const live = (instanceId: string) => send("GET", `/conversations/conv_1/widgets/${instanceId}/live`);
const change = (action: string, packageId = PACKAGE) => send("POST", `/packages/${encodeURIComponent(packageId)}/${action}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-lifecycle-"));
  const v1 = join(dir, "board-1");
  const v2 = join(dir, "board-2");
  writePackage(v1, "1.0.0");
  writePackage(v2, "2.0.0");
  const indexPath = join(dir, "directory.json");
  // Newest listed first, as a directory would: the node must still serve the version it is running.
  writeFileSync(indexPath, JSON.stringify([entry("2.0.0", v2), entry("1.0.0", v1)]));
  services = bootNodeServices({ dataDir: dir, label: "package lifecycle route test node" });
  deps = { services, now: () => AT as never };
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run("conv_1", services.runtime.identity.nodeId, AT, AT);
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("uninstalling and restoring a package", () => {
  it("takes the widget offline with its text alternative and state, and brings it back on restore", async () => {
    recordInstall("2.0.0");
    const instanceId = makeInstance();
    initialiseState(services.conductor, { instanceId, body: { items: ["kept"] }, stateVersion: 1 });

    const uninstalled = await change("uninstall");
    expect(uninstalled.status).toBe(200);
    expect(uninstalled.body).toMatchObject({
      action: "uninstall",
      packageId: PACKAGE,
      previousVersion: "2.0.0",
      instancesOffline: 1,
      statesKept: 1,
      restartNeeded: false,
    });

    expect((await live(instanceId)).body).toMatchObject({
      kind: "isolated-frame",
      frame: null,
      readOnly: true,
      state: { items: ["kept"] },
      stateStatus: { kind: "offline" },
      textFallback: "A task list, version 2.0.0.",
      bindings: [],
    });
    const listed = await send("GET", "/packages");
    expect(listed.body).toMatchObject({
      packages: [],
      restorable: [{ packageId: PACKAGE, version: "2.0.0", digest: "sha256:board-2.0.0" }],
    });

    const restored = await change("restore");
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ action: "restore", activeVersion: "2.0.0", instancesRestored: 1 });
    const back = await live(instanceId);
    expect(back.body).toMatchObject({ readOnly: false, state: { items: ["kept"] }, stateStatus: { kind: "writable" } });
    expect((back.body as { frame: { url: string } }).frame.url).toContain("widgets/main/index.html");
  });

  it("answers 404 for a package that is not installed, and 409 for restoring one that is", async () => {
    expect((await change("uninstall")).status).toBe(404);
    recordInstall("2.0.0");
    const refused = await change("restore");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "ALREADY_INSTALLED" });
  });

  it("refuses to restore bytes the directory no longer lists with the same digest", async () => {
    recordInstall("2.0.0", "sha256:something-else");
    await change("uninstall");

    const refused = await change("restore");

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "VERSION_UNAVAILABLE" });
  });
});

describe("rolling back to the previous version", () => {
  it("serves the older version's code and reports which version a rollback would reach", async () => {
    recordInstall("1.0.0");
    recordInstall("2.0.0");
    const instanceId = makeInstance();
    expect((await send("GET", "/packages")).body).toMatchObject({ packages: [{ version: "2.0.0", previousVersion: "1.0.0" }] });

    const rolled = await change("rollback");

    expect(rolled.status).toBe(200);
    expect(rolled.body).toMatchObject({ action: "rollback", activeVersion: "1.0.0", previousVersion: "2.0.0" });
    const mounted = (await live(instanceId)).body as { frame: { url: string } };
    // The frame grant names the package and version it was minted for; the version is the one now running.
    const payload = mounted.frame.url.split("/")[2]?.split(".")[0] ?? "";
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toMatchObject({
      packageId: PACKAGE,
      version: "1.0.0",
    });
    expect((await send("GET", "/packages")).body).toMatchObject({ packages: [{ version: "1.0.0", previousVersion: "2.0.0" }] });
  });

  it("answers 409 when there is no other version to go back to", async () => {
    recordInstall("2.0.0");

    const refused = await change("rollback");

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "NO_PREVIOUS_VERSION" });
  });
});

describe("the same actions from the conversation", () => {
  function tool(channel: "voice" | "chat" = "voice") {
    return createManagePackageTool({
      packages: { runtime: services.runtime, conductor: services.conductor },
      conversationId: "conv_1",
      channel: () => channel,
    });
  }
  const isActive = () =>
    activeGeneration(services.conductor, PACKAGE, services.runtime.identity.nodeId) !== undefined;

  it("lists what is installed, uninstalls by voice through the same action, and records who asked", async () => {
    recordInstall("1.0.0");
    recordInstall("2.0.0");

    expect((await tool().execute({ action: "list" })).text).toContain(`${PACKAGE} 2.0.0 (có thể quay về 1.0.0)`);

    const said = (await tool().execute({ action: "uninstall", packageId: PACKAGE })).text;

    expect(said).toContain(`Đã gỡ ${PACKAGE} 2.0.0`);
    expect(isActive()).toBe(false);
    const audit = allRows<{ document: string }>(
      services.runtime.db,
      "SELECT document FROM events WHERE kind = 'effect.executed'",
    ).map((row) => JSON.parse(row.document) as { description: string });
    expect(audit.some((entry) => entry.description === `uninstall ${PACKAGE} (voice)`)).toBe(true);
    expect((await tool("chat").execute({ action: "list" })).text).toContain(`Đã gỡ, có thể khôi phục: ${PACKAGE} 2.0.0`);
  });

  it("does not act on a sentence when the policy asks every time, while the Settings button still works", async () => {
    recordInstall("2.0.0");
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT as never },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" },
        source: "user",
      },
    );
    if (!written.ok) throw new Error(written.message);

    const said = (await tool().execute({ action: "uninstall", packageId: PACKAGE })).text;

    expect(said).toContain("CONFIRMATION_REQUIRED");
    expect(said).toContain("Chưa thay đổi gì");
    expect(isActive()).toBe(true);
    expect((await change("uninstall")).status).toBe(200);
    expect(isActive()).toBe(false);
  });
});

describe("what a running frame is brokered", () => {
  it("holds back a granted capability that is not ready, names why, and brokers it once it is", async () => {
    // Version 3 asks for one capability and was granted it; nothing on this node provides it yet.
    const v3 = join(dir, "board-3");
    writePackage(v3, "3.0.0", ["calendar.read@1"]);
    writeFileSync(process.env["CC_DIRECTORY_INDEX"]!, JSON.stringify([entry("3.0.0", v3)]));
    recordInstall("3.0.0", "sha256:board-3.0.0", ["calendar.read@1"]);
    const instanceId = makeInstance();

    const before = (await live(instanceId)).body as {
      frame: { grantedCapabilities: string[]; unavailableCapabilities: { ref: string; code: string }[] };
    };
    expect(before.frame.grantedCapabilities).toEqual([]);
    expect(before.frame.unavailableCapabilities).toEqual([
      expect.objectContaining({ ref: "calendar.read@1", code: "CAPABILITY_MISSING" }),
    ]);

    registerCapability(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
      {
        ref: "calendar.read@1" as never,
        executionNodeId: services.runtime.identity.nodeId as never,
        summary: "đọc lịch",
        resourceKinds: ["calendar"],
        effectCategory: "read",
        supportsCancellation: false,
        requiresConnection: false,
        readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
        uiAffordances: [],
      },
    );

    const after = (await live(instanceId)).body as {
      frame: { grantedCapabilities: string[]; unavailableCapabilities: unknown[] };
    };
    expect(after.frame.grantedCapabilities).toEqual(["calendar.read@1"]);
    expect(after.frame.unavailableCapabilities).toEqual([]);
  });
});
