import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WidgetDefinition } from "@clarkcant/contracts";
import { createInstance, disablePackage, initialiseState } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A frame's durable state, through the node's routes.
 *
 * The live route is where a frame learns the state it starts from, migrated first when the package is newer than what
 * is stored; the state route is the only way it writes. Both read the definition from the package on disk, so these
 * tests build a real package and let the node find it the way it finds any other.
 */

const AT = "2026-09-24T06:00:00.000Z";
const WIDGET_ID = "com.example.board.main@1";

const DEFINITION: WidgetDefinition = {
  id: WIDGET_ID,
  version: "2.0.0",
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: {
    type: "object",
    properties: { items: { type: "array", items: { type: "string" } } },
    additionalProperties: false,
  },
  stateVersion: 2,
  ephemeralStateKeys: ["filter"],
  stateMigrations: [{ from: 1, to: 2, ops: [{ op: "rename", from: "todos", to: "items" }] }],
  sizing: { compact: true, expanded: true },
  textFallback: "A task list.",
  effectCategories: [],
  datasetRefs: [],
  semanticDescription: "A task list",
  requestedCapabilities: [],
};

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;

function writePackage(root: string): void {
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  writeFileSync(join(root, "widgets", "main", "index.html"), "<!doctype html><div id=root></div>\n");
  writeFileSync(join(root, "widgets", "main", "widget.json"), JSON.stringify(DEFINITION));
  writeFileSync(
    join(root, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "com.example.board",
      version: "2.0.0",
      displayName: "Board",
      description: "A task board.",
      hostApi: { min: 1, max: 1 },
      facets: [
        {
          kind: "widget",
          id: WIDGET_ID,
          entry: "widgets/main/index.html",
          definition: "widgets/main/widget.json",
          isolation: "isolated-ui",
        },
      ],
      requestedCapabilities: [],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
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
  const instance = createInstance(services.conductor, {
    definition: DEFINITION,
    packageDigest: "sha256:board",
    ownerPrincipalId: services.runtime.identity.ownerPrincipalId as never,
    props: {},
  });
  return instance.instanceId;
}

const live = (instanceId: string) => send("GET", `/conversations/conv_1/widgets/${instanceId}/live`);
const save = (instanceId: string, body: unknown) => send("POST", `/conversations/conv_1/widgets/${instanceId}/state`, body);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-state-"));
  const packageRoot = join(dir, "package");
  writePackage(packageRoot);
  const indexPath = join(dir, "directory.json");
  writeFileSync(
    indexPath,
    JSON.stringify([
      {
        packageId: "com.example.board",
        version: "2.0.0",
        displayName: "Board",
        description: "A task board.",
        source: { kind: "local", path: packageRoot },
        publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
        preview: {},
        facets: ["ui"],
        isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
        platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
        hostApi: { min: 1, max: 1 },
        permissionsSummary: [],
        riskTier: "isolated-ui",
        sizeBytes: 1024,
        digest: "sha256:board",
      },
    ]),
  );
  services = bootNodeServices({ dataDir: dir, label: "widget state route test node" });
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

describe("a frame's durable state", () => {
  it("mounts a new instance at state revision 0, writable, with the keys it may keep local", async () => {
    const response = await live(makeInstance());

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      kind: "isolated-frame",
      readOnly: false,
      stateRevision: 0,
      stateVersion: 2,
      state: {},
      stateStatus: { kind: "writable" },
      ephemeralStateKeys: ["filter"],
    });
  });

  it("commits a write and serves it back on the next mount, without the view state", async () => {
    const instanceId = makeInstance();

    const written = await save(instanceId, { expectedRevision: 0, patch: { items: ["a"], filter: "open" } });
    expect(written.status).toBe(200);
    expect(written.body).toEqual({ stateRevision: 1, state: { items: ["a"] } });

    expect((await live(instanceId)).body).toMatchObject({ stateRevision: 1, state: { items: ["a"] } });
  });

  it("answers a stale write with 409 and the committed state", async () => {
    const instanceId = makeInstance();
    await save(instanceId, { expectedRevision: 0, patch: { items: ["first"] } });

    const response = await save(instanceId, { expectedRevision: 0, patch: { items: ["second"] } });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "STATE_REVISION_STALE", stateRevision: 1, state: { items: ["first"] } });
  });

  it("answers state the schema refuses with 422 and stores nothing", async () => {
    const instanceId = makeInstance();

    const response = await save(instanceId, { expectedRevision: 0, patch: { items: [1, 2] } });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: "STATE_SCHEMA_INVALID" });
    expect((await live(instanceId)).body).toMatchObject({ stateRevision: 0, state: {} });
  });

  it("refuses a body without a revision or a patch", async () => {
    const instanceId = makeInstance();

    expect((await save(instanceId, { patch: {} })).status).toBe(400);
    expect((await save(instanceId, { expectedRevision: 0, patch: [] })).status).toBe(400);
  });

  it("migrates older stored state when the frame is mounted", async () => {
    const instanceId = makeInstance();
    initialiseState(services.conductor, { instanceId, body: { todos: ["kept"] }, stateVersion: 1 });

    expect((await live(instanceId)).body).toMatchObject({
      readOnly: false,
      stateVersion: 2,
      state: { items: ["kept"] },
      stateStatus: { kind: "writable" },
    });
  });

  it("mounts read-only, with the state intact, when the migration fails", async () => {
    const instanceId = makeInstance();
    initialiseState(services.conductor, { instanceId, body: { todos: ["a"], items: ["b"] }, stateVersion: 1 });

    const response = await live(instanceId);

    expect(response.body).toMatchObject({
      readOnly: true,
      stateVersion: 1,
      state: { todos: ["a"], items: ["b"] },
      stateStatus: { kind: "migration-failed", fromVersion: 1, toVersion: 2 },
    });
    const refused = await save(instanceId, { expectedRevision: 1, patch: { items: [] } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "STATE_READ_ONLY" });
  });

  it("answers 410 for an instance whose package was uninstalled, and keeps its state", async () => {
    const instanceId = makeInstance();
    await save(instanceId, { expectedRevision: 0, patch: { items: ["kept"] } });
    disablePackage(services.conductor, { packageDigest: "sha256:board", reason: "uninstalled" });

    const response = await save(instanceId, { expectedRevision: 1, patch: { items: [] } });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: "INSTANCE_OFFLINE" });
    expect((await live(instanceId)).body).toMatchObject({ readOnly: true, state: { items: ["kept"] } });
  });
});
