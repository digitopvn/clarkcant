import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The route that tells the library which widgets an installed package declares.
 *
 * The claims worth a test are all about honesty. A package the node cannot read must not be reported as a package
 * with no widgets, a directory that is not configured must not be reported as an answer, and none of it may be
 * reachable without the token that authorizes every other local decision.
 */

const AT = "2026-09-22T04:00:00.000Z";
const PACKAGE_ID = "com.example.panel";
const VERSION = "1.0.0";
const DIGEST = "sha256:widget-digest";

let dir: string;
let packageRoot: string;
let indexPath: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;

function directoryEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageId: PACKAGE_ID,
    version: VERSION,
    displayName: "Example panel",
    description: "A widget a package declares.",
    source: { kind: "local", path: packageRoot },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: ["linux-x64"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 1024,
    digest: DIGEST,
    ...overrides,
  };
}

/** A package directory the node can read, with one widget facet and two fixtures. */
function writePackage(): void {
  mkdirSync(join(packageRoot, "widgets", "main"), { recursive: true });
  mkdirSync(join(packageRoot, "fixtures"), { recursive: true });
  writeFileSync(
    join(packageRoot, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PACKAGE_ID,
      version: VERSION,
      displayName: "Example panel",
      description: "A widget a package declares.",
      hostApi: { min: 1, max: 1 },
      facets: [
        {
          kind: "widget",
          id: "canvas.note@1",
          entry: "widgets/main/index.html",
          definition: "widgets/main/widget.json",
          isolation: "isolated-ui",
        },
      ],
      requestedCapabilities: [],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["linux-x64"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
  writeFileSync(
    join(packageRoot, "widgets", "main", "widget.json"),
    JSON.stringify({
      id: "canvas.note@1",
      version: "1.0.0",
      renderer: "catalog",
      propsSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      eventSchemas: {},
      semanticDescription: "A panel a package declares",
      requestedCapabilities: [],
      sizing: { compact: true, expanded: true },
      textFallback: "Example panel. Shown as text when it cannot be mounted.",
      effectCategories: ["read"],
      datasetRefs: [],
    }),
  );
  writeFileSync(join(packageRoot, "fixtures", "default.json"), JSON.stringify({ title: "Xin chào" }));
}

async function get(path: string, options: { authed?: boolean } = {}): Promise<GatewayResponse> {
  const request: GatewayRequest = {
    method: "GET",
    path,
    query: {},
    headers: options.authed === false ? {} : { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: "",
  };
  return handleRequest(deps, request);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-installed-widgets-"));
  packageRoot = join(dir, "package");
  indexPath = join(dir, "directory.json");
  writePackage();
  writeFileSync(indexPath, JSON.stringify([directoryEntry()]));

  services = bootNodeServices({ dataDir: dir, label: "installed widgets route test node" });
  deps = { services, now: () => AT as never };

  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;

  // The route reads what is installed from the active generation, so a package has to be installed here. The
  // generation carries no path; the directory entry is what locates the files, which is the whole point.
  services.runtime.db
    .prepare(
      `INSERT INTO package_generations
         (generation_id, package_id, version, digest, node_id, code_generation, activated_at, superseded_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      "gen_test_1",
      PACKAGE_ID,
      VERSION,
      DIGEST,
      services.runtime.identity.nodeId,
      "code-1",
      AT,
      JSON.stringify({
        generationId: "gen_test_1",
        packageId: PACKAGE_ID,
        version: VERSION,
        digest: DIGEST,
        nodeId: services.runtime.identity.nodeId,
        codeGeneration: "code-1",
        activatedAt: AT,
        uiOnlyFacets: [],
        grantedCapabilities: [],
      }),
    );
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the installed packages' widget definitions", () => {
  it("returns a local package's widgets and the fixtures it wrote", async () => {
    const response = await get("/packages/widgets");

    expect(response.status).toBe(200);
    const packages = (response.body as { packages: Record<string, unknown>[] }).packages;
    expect(packages).toHaveLength(1);
    expect(packages[0]?.["ok"]).toBe(true);

    const widgets = packages[0]?.["widgets"] as Record<string, unknown>[];
    expect(widgets).toHaveLength(1);
    expect((widgets[0]?.["definition"] as { id: string }).id).toBe("canvas.note@1");
    expect((widgets[0]?.["fixtures"] as { id: string }[]).map((fixture) => fixture.id)).toEqual(["default"]);
  });

  it("does not leak the package's filesystem path into the response", async () => {
    const response = await get("/packages/widgets");
    expect(JSON.stringify(response.body)).not.toContain(packageRoot);
  });

  it("names a package it cannot locate rather than reporting it as having no widgets", async () => {
    writeFileSync(indexPath, JSON.stringify([]));

    const response = await get("/packages/widgets");
    const packages = (response.body as { packages: Record<string, unknown>[] }).packages;

    expect(packages[0]?.["ok"]).toBe(false);
    expect(packages[0]?.["code"]).toBe("NOT_IN_DIRECTORY");
    expect(String(packages[0]?.["message"])).toContain("cannot locate");
  });

  it("reports a package whose bytes this node does not hold as unreadable here, not as empty", async () => {
    writeFileSync(
      indexPath,
      JSON.stringify([directoryEntry({ source: { kind: "git", url: "https://example.com/p.git", ref: "v1.0.0" } })]),
    );

    const response = await get("/packages/widgets");
    const packages = (response.body as { packages: Record<string, unknown>[] }).packages;

    expect(packages[0]?.["ok"]).toBe(false);
    expect(packages[0]?.["code"]).toBe("NOT_LOCAL");
  });

  it("says the directory is not configured rather than inventing an answer", async () => {
    delete process.env["CC_DIRECTORY_INDEX"];

    const response = await get("/packages/widgets");
    const packages = (response.body as { packages: Record<string, unknown>[] }).packages;

    expect(packages[0]?.["ok"]).toBe(false);
    expect(packages[0]?.["code"]).toBe("NO_DIRECTORY");
  });

  it("finds a package installed from disk again, whose recorded id is the path itself", async () => {
    /*
     * A local install records the path as its package id and "0.0.0-local" as its version, so a lookup by id and
     * version alone would report "not in the directory" for every package installed from disk.
     */
    services.runtime.db
      .prepare("UPDATE package_generations SET package_id = ?, version = ? WHERE generation_id = ?")
      .run(packageRoot, "0.0.0-local", "gen_test_1");

    const response = await get("/packages/widgets");
    const packages = (response.body as { packages: Record<string, unknown>[] }).packages;

    expect(packages[0]?.["ok"]).toBe(true);
    // The declared identity, not the path the resolver records for a local source: a path is where the bytes are,
    // not what the package is called, and reporting it would put a filesystem path where a name belongs.
    expect(packages[0]?.["packageId"]).toBe(PACKAGE_ID);
    expect(packages[0]?.["version"]).toBe(VERSION);
    const widgets = packages[0]?.["widgets"] as Record<string, unknown>[];
    expect((widgets[0]?.["definition"] as { id: string }).id).toBe("canvas.note@1");
  });

  it("requires the token that every other local decision requires", async () => {
    const response = await get("/packages/widgets", { authed: false });
    expect(response.status).toBe(401);
  });
});
