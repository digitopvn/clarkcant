import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WidgetDefinition } from "@clarkcant/contracts";
import { FRAME_GRANT_LIFETIME_MS, createInstance } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createFrameGrantFixture } from "../src/test-support/fixture-frame-grant.ts";

/**
 * How long a widget frame's URL works, through the node's routes.
 *
 * The live answer says how long its URL lasts, so a client can re-read before loading a document with a URL the node
 * would refuse. The lifetime itself stays five minutes: a copied URL is refused once it has lapsed, and the only way to
 * shorten it is the frame-grant fixture, which a node without the gate does not have and which cannot lengthen it.
 */

const AT = "2026-09-30T06:00:00.000Z";
const PACKAGE = "com.example.board";
const WIDGET_ID = "com.example.board.main@1";
const VERSION = "1.0.0";

const DEFINITION: WidgetDefinition = {
  id: WIDGET_ID,
  version: VERSION,
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  sizing: { compact: true, expanded: true },
  textFallback: "A task board.",
  effectCategories: [],
  datasetRefs: [],
  semanticDescription: "A task board",
  requestedCapabilities: [],
};

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;
let instanceId: string;

function writePackage(root: string): void {
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  writeFileSync(join(root, "widgets", "main", "index.html"), "<!doctype html><div id=root></div>\n");
  writeFileSync(join(root, "widgets", "main", "widget.json"), JSON.stringify(DEFINITION));
  writeFileSync(
    join(root, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PACKAGE,
      version: VERSION,
      displayName: "Board",
      description: "A task board.",
      hostApi: { min: 1, max: 1 },
      facets: [
        { kind: "widget", id: WIDGET_ID, entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" },
      ],
      requestedCapabilities: [],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
}

function directoryEntry(root: string) {
  return {
    packageId: PACKAGE,
    version: VERSION,
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
    digest: `sha256:board-${VERSION}`,
  };
}

/** Record the active generation the way the install supervisor does. */
function recordInstall(): void {
  const nodeId = services.runtime.identity.nodeId;
  const generation = {
    generationId: `${PACKAGE}@${VERSION}:code_1`,
    packageId: PACKAGE,
    version: VERSION,
    digest: `sha256:board-${VERSION}`,
    nodeId,
    codeGeneration: "code_1",
    activatedAt: AT,
    uiOnlyFacets: ["ui"],
    grantedCapabilities: [],
  };
  services.runtime.db
    .prepare(
      `INSERT INTO package_generations
         (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(generation.generationId, PACKAGE, VERSION, generation.digest, nodeId, "code_1", AT, JSON.stringify(generation));
}

async function send(method: "GET" | "POST", path: string, body?: unknown, withToken = true): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: withToken ? { authorization: `Bearer ${services.runtime.identity.localToken}` } : {},
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

interface LiveFrame {
  frame: { url: string; urlExpiresInMs: number };
}

const live = async (): Promise<LiveFrame> => (await send("GET", `/conversations/conv_1/widgets/${instanceId}/live`)).body as LiveFrame;
/** The frame URL fetched the way a browser navigation fetches it: with no bearer token, only the grant in its path. */
const load = (url: string): Promise<GatewayResponse> => send("GET", url, undefined, false);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(AT));
  dir = mkdtempSync(join(tmpdir(), "clarkcant-frame-grant-"));
  const root = join(dir, "board");
  writePackage(root);
  const indexPath = join(dir, "directory.json");
  writeFileSync(indexPath, JSON.stringify([directoryEntry(root)]));
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
  services = bootNodeServices({ dataDir: dir, label: "frame grant lifetime test node" });
  deps = { services, now: () => new Date().toISOString() as never };
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run("conv_1", services.runtime.identity.nodeId, AT, AT);
  recordInstall();
  instanceId = createInstance(services.conductor, {
    definition: DEFINITION,
    packageDigest: `sha256:board-${VERSION}`,
    ownerPrincipalId: services.runtime.identity.ownerPrincipalId as never,
    props: {},
  }).instanceId;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a frame URL's lifetime", () => {
  it("is said beside the URL, and is five minutes on a node without the fixture", async () => {
    const answer = await live();
    expect(answer.frame.urlExpiresInMs).toBe(FRAME_GRANT_LIFETIME_MS);
    expect(FRAME_GRANT_LIFETIME_MS).toBe(5 * 60 * 1000);
  });

  it("serves the document until the grant lapses, and refuses a copied URL after that", async () => {
    const { frame } = await live();
    expect((await load(frame.url)).status).toBe(200);

    vi.setSystemTime(Date.parse(AT) + FRAME_GRANT_LIFETIME_MS - 1);
    expect((await load(frame.url)).status).toBe(200);

    vi.setSystemTime(Date.parse(AT) + FRAME_GRANT_LIFETIME_MS);
    const refused = await load(frame.url);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "GRANT_EXPIRED" });
  });

  it("is minted afresh on every read, so a re-read after the lapse is a URL that works", async () => {
    const first = await live();
    vi.setSystemTime(Date.parse(AT) + FRAME_GRANT_LIFETIME_MS + 1);
    expect((await load(first.frame.url)).status).toBe(403);

    const fresh = await live();
    expect(fresh.frame.url).not.toBe(first.frame.url);
    expect((await load(fresh.frame.url)).status).toBe(200);
  });
});

describe("the frame-grant fixture", () => {
  it("has no route on a node started without it", async () => {
    const answer = await send("POST", "/frame-grant-fixture/lifetime", { lifetimeMs: 1_000 });
    expect(answer.status).toBe(404);
    expect((await live()).frame.urlExpiresInMs).toBe(FRAME_GRANT_LIFETIME_MS);
  });

  it("shortens the lifetime of the grants minted next, and puts the production one back on null", async () => {
    services.frameGrantFixture = createFrameGrantFixture();

    expect((await send("POST", "/frame-grant-fixture/lifetime", { lifetimeMs: 2_000 })).status).toBe(200);
    const short = await live();
    expect(short.frame.urlExpiresInMs).toBe(2_000);
    vi.setSystemTime(Date.parse(AT) + 2_000);
    expect((await load(short.frame.url)).body).toMatchObject({ code: "GRANT_EXPIRED" });

    expect((await send("POST", "/frame-grant-fixture/lifetime", { lifetimeMs: null })).status).toBe(200);
    expect((await live()).frame.urlExpiresInMs).toBe(FRAME_GRANT_LIFETIME_MS);
  });

  it("cannot lengthen the lifetime, through its route or otherwise", async () => {
    services.frameGrantFixture = createFrameGrantFixture();
    for (const lifetimeMs of [FRAME_GRANT_LIFETIME_MS + 1, 0, -1, 1.5, "1000"]) {
      const refused = await send("POST", "/frame-grant-fixture/lifetime", { lifetimeMs });
      expect(refused.status).toBe(400);
    }
    // Even a value put on the seam directly is capped by the mint.
    services.frameGrantFixture.setLifetimeMs(FRAME_GRANT_LIFETIME_MS * 10);
    expect((await live()).frame.urlExpiresInMs).toBe(FRAME_GRANT_LIFETIME_MS);
  });

  it("is behind the bearer token like every other command", async () => {
    services.frameGrantFixture = createFrameGrantFixture();
    const refused = await send("POST", "/frame-grant-fixture/lifetime", { lifetimeMs: 1_000 }, false);
    expect(refused.status).toBe(401);
  });
});
