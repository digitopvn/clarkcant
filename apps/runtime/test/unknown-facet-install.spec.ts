import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG, type Instant, platformForHost } from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, digestOfDirectory, writeRegisteredPreference } from "@clarkcant/core";

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

  async function install(later: Record<string, unknown> | undefined, listedIsolation = later?.["isolation"]): Promise<GatewayResponse> {
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
});
