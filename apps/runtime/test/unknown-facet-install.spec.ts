import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG, type Instant, platformForHost } from "@clarkcant/contracts";
import {
  EXECUTION_POLICY_PREFERENCE_KEY,
  cachedLocalSnapshotPath,
  digestOfDirectory,
  installedThemes,
  writeRegisteredPreference,
} from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A package from a newer ClarkCant: it declares a facet kind this node does not know, and its listing names that kind.
 * The node installs the rest of it, leaves the facet out, and counts the facet's lane when it decides what to grant, so
 * a facet it never runs can only make a grant harder, never easier.
 */

const AT = "2026-10-08T03:00:00.000Z";
const HOST_PLATFORM = platformForHost(process.platform, process.arch) ?? "web";
const ID = "com.example.later";

describe("installing a package with a facet kind this node does not know", () => {
  let dir: string;
  let services: NodeServices;
  let deps: GatewayDeps;
  let indexPath: string;
  let previousIndex: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-unknown-facet-"));
    indexPath = join(dir, "directory.json");
    writeFileSync(indexPath, "[]");
    services = bootNodeServices({ dataDir: dir, label: "unknown facet test node" });
    deps = { services, now: () => AT as Instant };
    // A request made in a high-risk lane is refused, so which lane a grant was decided in shows in the answer.
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT as Instant },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, rules: [{ effectCategory: "destructive", decision: "deny" }] },
        source: "user",
      },
    );
    expect(written.ok).toBe(true);
    previousIndex = process.env["CC_DIRECTORY_INDEX"];
    process.env["CC_DIRECTORY_INDEX"] = indexPath;
  });

  afterEach(() => {
    if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
    else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
    services.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function install(
    later: Record<string, unknown> | undefined,
    listedIsolation = later?.["isolation"],
    extra: { manifest?: Record<string, unknown>; listing?: Record<string, unknown> } = {},
  ): Promise<GatewayResponse> {
    const folder = join(dir, "package");
    mkdirSync(join(folder, "themes"), { recursive: true });
    const theme = { kind: "themes", id: "dusk", entry: "themes/dusk.json", isolation: "declarative" };
    writeFileSync(
      join(folder, "clarkcant.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: ID,
        version: "1.0.0",
        displayName: "Later",
        description: "A package from a newer ClarkCant.",
        hostApi: { min: 1, max: 1 },
        facets: later === undefined ? [theme] : [theme, later],
        requestedCapabilities: ["widget.state.write@1"],
        permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
        platforms: [HOST_PLATFORM],
        ...extra.manifest,
      }),
    );
    writeFileSync(join(folder, "themes", "dusk.json"), JSON.stringify({ appearanceApi: { min: 1, max: 1 }, id: "dusk", displayName: "Dusk" }));
    const digest = digestOfDirectory(folder, { exclude: [] });
    if (!digest.ok) throw new Error(digest.message);
    const kinds = later === undefined ? ["themes"] : ["themes", String(later["kind"])];
    writeFileSync(
      indexPath,
      JSON.stringify([
        {
          packageId: ID,
          version: "1.0.0",
          displayName: "Later",
          description: "A package from a newer ClarkCant.",
          source: { kind: "local", path: folder },
          publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
          preview: {},
          facets: kinds,
          isolations: [
            { facetKind: "themes", isolation: "declarative" },
            ...(later === undefined ? [] : [{ facetKind: later["kind"], isolation: listedIsolation }]),
          ],
          platforms: [HOST_PLATFORM],
          hostApi: { min: 1, max: 1 },
          permissionsSummary: [],
          // What a newer publisher would compute from the facets it knows, and what this node must not lower.
          riskTier: "declarative",
          sizeBytes: 512,
          digest: digest.digest,
          ...extra.listing,
        },
      ]),
    );
    return handleRequest(deps, {
      method: "POST",
      path: "/packages/install",
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: JSON.stringify({ packageId: ID, version: "1.0.0", localDigest: digest.digest }),
    });
  }

  type Installed = { state: string; pendingCapabilities: unknown[]; deniedCapabilities: unknown[] };

  it("grants a declarative package's request outright when it carries no unknown facet", async () => {
    const plain = await install(undefined);
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    const body = plain.body as Installed;
    expect(body.state).toBe("active");
    expect([...body.pendingCapabilities, ...body.deniedCapabilities]).toEqual([]);
  });

  it("installs the parts it knows past a declarative facet of an unknown kind, granting as before", async () => {
    const later = await install({ kind: "agents", id: "com.example.later.agents", entry: "agents/index.json", isolation: "declarative" });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    const body = later.body as Installed;
    expect(body.state).toBe("active");
    expect([...body.pendingCapabilities, ...body.deniedCapabilities]).toEqual([]);
  });

  it("counts an unknown facet's stronger lane, or the strongest when it names none, so the request is no longer granted outright", async () => {
    // The listing says declarative either way; the manifest inside the bytes is what is counted.
    const later = await install({ kind: "agents", id: "com.example.later.agents", entry: "agents/index.json", isolation: "trusted-native" }, "declarative");
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    const body = later.body as Installed;
    expect(body.state).toBe("active");
    expect([...body.pendingCapabilities, ...body.deniedCapabilities]).toHaveLength(1);
  });

  it("counts an unknown facet that names no lane this node knows as the strongest", async () => {
    const later = await install({ kind: "agents", id: "com.example.later.agents", entry: "agents/index.json", isolation: "kernel" }, "declarative");
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    const body = later.body as Installed;
    expect([...body.pendingCapabilities, ...body.deniedCapabilities]).toHaveLength(1);
  });

  const AGENTS = { kind: "agents", id: "com.example.later.agents", entry: "agents/index.json", isolation: "trusted-native" };

  function get(path: string): Promise<GatewayResponse> {
    return handleRequest(deps, { method: "GET", path, query: {}, headers: { authorization: `Bearer ${services.runtime.identity.localToken}` }, body: "" });
  }

  it("records the skipped facet on the generation, and reports it with the lane grants were decided in", async () => {
    const later = await install(AGENTS, "declarative");
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    const rows = services.runtime.db.prepare("SELECT document FROM package_generations").all() as { document: string }[];
    expect(rows.map((row) => (JSON.parse(row.document) as { skippedFacets?: unknown }).skippedFacets)).toEqual([
      [{ kind: "agents", id: "com.example.later.agents", isolation: "trusted-native" }],
    ]);
    const listed = await get("/packages");
    expect(listed.status).toBe(200);
    const [pkg] = (listed.body as { packages: { lane: string; skippedFacets?: unknown }[] }).packages;
    // The theme alone is declarative; the lane shown is the one the grant was decided in.
    expect(pkg?.lane).toBe("trusted-native");
    expect(pkg?.skippedFacets).toEqual([{ kind: "agents", id: "com.example.later.agents", isolation: "trusted-native" }]);
  });

  it("holds back every facet of a package whose record of skipped facets cannot be read", async () => {
    expect((await install(AGENTS, "declarative")).status).toBe(200);
    services.runtime.db.prepare("UPDATE package_generations SET document = json_set(document, '$.skippedFacets', 'agents')").run();
    const [pkg] = ((await get("/packages")).body as { packages: { lane: string; skippedFacets?: unknown }[] }).packages;
    expect(pkg?.skippedFacets).toBe("unreadable");
    expect(pkg?.lane).toBe("trusted-native");
    // Its theme, which the install did not skip, is not drawn either: nobody can tell what the record held back.
    const themes = (await get("/themes")).body as { themes: unknown[]; unchecked: { packageId: string }[] };
    expect(JSON.stringify(themes.themes)).not.toContain("Dusk");
    expect(themes.unchecked.map((entry) => entry.packageId)).toEqual([ID]);
  });

  it("keeps a facet skipped at install inert on a host that later understands its kind, until the package is installed again", async () => {
    expect((await install(AGENTS, "declarative")).status).toBe(200);
    const [generation] = services.runtime.db.prepare("SELECT document FROM package_generations").all() as { document: string }[];
    const snapshotDigest = (JSON.parse(generation?.document ?? "{}") as { snapshotDigest?: string }).snapshotDigest;
    const snapshot = snapshotDigest === undefined ? undefined : cachedLocalSnapshotPath(join(dir, "package-cache"), snapshotDigest);
    if (snapshot === undefined) throw new Error("expected the install to record a snapshot");
    // What a newer host reads in the same bytes: the facet it skipped is now a kind it knows, a theme.
    const manifestPath = join(snapshot, "clarkcant.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { facets: Record<string, unknown>[] };
    manifest.facets[1] = { kind: "themes", id: "com.example.later.agents", entry: "themes/afterglow.json", isolation: "declarative" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(
      join(snapshot, "themes", "afterglow.json"),
      JSON.stringify({ appearanceApi: { min: 1, max: 1 }, id: "com.example.later.agents", displayName: "Afterglow" }),
    );
    // Read without the record, the theme would be offered: the record is what keeps it out.
    const unrecorded = installedThemes({ source: { kind: "local", path: snapshot } });
    expect(unrecorded.ok && unrecorded.themes.length).toBe(2);
    const themes = await get("/themes");
    expect(themes.status).toBe(200);
    expect(JSON.stringify(themes.body)).toContain("Dusk");
    expect(JSON.stringify(themes.body)).not.toContain("Afterglow");
  });

  it("says a listed reach may count a facet this node cannot read, rather than only that the reach differs", async () => {
    const reach = { origins: [{ origin: "https://api.example.com", purpose: "Reach the agents' provider" }], secrets: [], browserTokens: [] };
    const refused = await install(AGENTS, "declarative", { listing: { declaredReach: reach } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const body = refused.body as { code: string; message: string };
    expect(body.code).toBe("DECLARED_REACH_MISMATCH");
    expect(body.message).toContain("does not understand (agents)");
    expect(body.message).toContain("update ClarkCant");
  });

  it("refuses a manifest whose host API leaves this host out, though the listing says it fits", async () => {
    const refused = await install(AGENTS, "declarative", { manifest: { hostApi: { min: 2, max: 2 } } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    const body = refused.body as { code: string; message: string };
    expect(body.code).toBe("HOST_API_MISMATCH");
    expect(body.message).toContain("its manifest needs host API 2–2, this host is 1");
  });
});
