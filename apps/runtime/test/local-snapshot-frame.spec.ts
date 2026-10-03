import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WidgetDefinition } from "@clarkcant/contracts";
import { createInstance, mintFrameGrant, snapshotLocalPackage } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A package listed by a path on this machine, as its frame is served after it was installed from a snapshot.
 *
 * The frame route and the conversation's frame lookup serve the copy the generation recorded, never the path: edits to
 * the path do not reach a running widget, and a listing re-packed under the same version with another digest, or a
 * listing of another version, is refused as not installed rather than served from the path, the way the files route
 * refuses it.
 */

const PACKAGE = "com.example.board";
const WIDGET_ID = "com.example.board.main@1";
const VERSION = "1.0.0";
const LISTED_DIGEST = `sha256:board-${VERSION}`;
const ORIGINAL = "<!doctype html><div id=root>installed</div>\n";
const EDITED = "<!doctype html><div id=root>edited after the install</div>\n";

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
let root: string;
let indexPath: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;
let instanceId: string;

function writePackage(at: string, html: string): void {
  mkdirSync(join(at, "widgets", "main"), { recursive: true });
  writeFileSync(join(at, "widgets", "main", "index.html"), html);
  writeFileSync(join(at, "widgets", "main", "widget.json"), JSON.stringify(DEFINITION));
  writeFileSync(
    join(at, "clarkcant.json"),
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

/** Writes the directory listing: the local package at `root`, under `version` with `digest`. */
function list(version: string, digest: string): void {
  writeFileSync(
    indexPath,
    JSON.stringify([
      {
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
        digest,
      },
    ]),
  );
}

/** Record the active generation the way the install does for a local package: with the snapshot it runs from. */
function recordInstall(snapshotDigest: string): void {
  const nodeId = services.runtime.identity.nodeId;
  const at = new Date().toISOString();
  const generation = {
    generationId: `${PACKAGE}@${VERSION}:code_1`,
    packageId: PACKAGE,
    version: VERSION,
    digest: LISTED_DIGEST,
    nodeId,
    codeGeneration: "code_1",
    activatedAt: at,
    uiOnlyFacets: ["ui"],
    grantedCapabilities: [],
    widgetIds: [WIDGET_ID],
    snapshotDigest,
  };
  services.runtime.db
    .prepare(
      `INSERT INTO package_generations
         (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(generation.generationId, PACKAGE, VERSION, LISTED_DIGEST, nodeId, "code_1", at, JSON.stringify(generation));
}

async function send(method: "GET" | "POST", path: string, withToken = true): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: withToken ? { authorization: `Bearer ${services.runtime.identity.localToken}` } : {},
    body: "",
  });
}

const live = (): Promise<GatewayResponse> => send("GET", `/conversations/conv_1/widgets/${instanceId}/live`);
const frameUrlOf = (answer: GatewayResponse): string => (answer.body as { frame: { url: string } }).frame.url;
/** A frame URL fetched the way a browser navigation fetches it: with no bearer token, only the grant in its path. */
const load = (url: string): Promise<GatewayResponse> => send("GET", url, false);
const text = (response: GatewayResponse): string =>
  response.binary === undefined ? JSON.stringify(response.body) : Buffer.from(response.binary.bytes).toString("utf8");

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-local-snapshot-frame-"));
  root = join(dir, "board");
  writePackage(root, ORIGINAL);
  indexPath = join(dir, "directory.json");
  list(VERSION, LISTED_DIGEST);
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
  services = bootNodeServices({ dataDir: dir, label: "local snapshot frame test node" });
  deps = { services, now: () => new Date().toISOString() as never };
  const at = new Date().toISOString();
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run("conv_1", services.runtime.identity.nodeId, at, at);

  // The install's own copy, in the cache the routes read, recorded on the generation as the install records it.
  const snapshot = await snapshotLocalPackage({
    path: root,
    cacheRoot: join(dir, "package-cache"),
    limits: { maxFiles: 100, maxBytes: 1_000_000 },
  });
  if (!snapshot.ok) throw new Error(snapshot.message);
  recordInstall(snapshot.artifact.digest);
  instanceId = createInstance(services.conductor, {
    definition: DEFINITION,
    packageDigest: LISTED_DIGEST,
    ownerPrincipalId: services.runtime.identity.ownerPrincipalId as never,
    props: {},
  }).instanceId;
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("the frame of a package installed from a path on this machine", () => {
  it("serves the copy it installed, not the files edited on the path since", async () => {
    writeFileSync(join(root, "widgets", "main", "index.html"), EDITED);

    const answer = await live();
    expect(answer.status).toBe(200);
    const frame = await load(frameUrlOf(answer));
    expect(frame.status).toBe(200);
    expect(text(frame)).toContain("installed");
    expect(text(frame)).not.toContain("edited after the install");
  });

  it("refuses a listing re-packed under the same version with another digest, and never serves the edited path", async () => {
    const before = frameUrlOf(await live());
    writeFileSync(join(root, "widgets", "main", "index.html"), EDITED);
    list(VERSION, "sha256:board-repacked");

    const answers = [
      await live(),
      // A frame URL minted before the re-pack.
      await load(before),
      // The files route already refused it, and still does.
      await send("GET", `/packages/${PACKAGE}/${VERSION}/files/widgets/main/index.html`),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ code: "NOT_INSTALLED" });
      expect(text(answer)).not.toContain("edited after the install");
    }
    // The answer says what was kept and what to do, not only that it failed.
    expect((answers[0]?.body as { message: string }).message).toMatch(/kept.*Install the package again/s);
  });

  it("refuses a listing of another version, whose files are the path's, while this one is installed", async () => {
    writeFileSync(join(root, "widgets", "main", "index.html"), EDITED);
    list("2.0.0", "sha256:board-2.0.0");
    const url = `/frame/${mintFrameGrant({
      instanceId,
      packageId: PACKAGE,
      version: "2.0.0",
      secret: services.runtime.identity.localToken,
      expiresAtMs: Date.now() + 60_000,
    })}/widgets/main/index.html`;

    const frame = await load(url);
    expect(frame.status).toBe(409);
    expect(frame.body).toMatchObject({ code: "NOT_INSTALLED" });
    expect(text(frame)).not.toContain("edited after the install");

    const answer = await live();
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "NOT_INSTALLED" });
  });
});
