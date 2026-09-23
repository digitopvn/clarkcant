import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityRef } from "@clarkcant/contracts";
import { invocationPreflight } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A local package install driven entirely over the HTTP API the browser uses, end to end: the route
 * parses the request, `installPackage` decides with the execution policy that gates every other
 * effect, `freezeInstallClosure` resolves and locks the dependency closure before anything installs,
 * `installFromEntry`/`installFromSource` plan, consent and activate the generation, and the response
 * names what was actually verified.
 *
 * What this test does **not** claim: that the installed package's capability becomes usable by a
 * dispatched task. `installPackage` fails closed on `grantedCapabilities` (see the comment there and
 * in `routes/packages.ts` — issue #93, P1): a public install request has no consent/policy state from
 * which this node can honestly derive a grant today, so nothing is registered in the capability
 * registry by installing alone. That is a real, named gap rather than an oversight papered over here;
 * the second test below proves the boundary rather than faking past it.
 *
 * A second, equally real gap: this node never fetches an artifact. `git`/`npm` sources are pinned by
 * digest and refused when they do not resolve to one, but nothing here downloads the bytes and installs
 * from them — the transport that would turn a remote entry into files on disk does not exist yet. Only
 * a `local` source (bytes already on this machine) can actually activate; that is `INSTALL_VERIFICATION`
 * = `"digest-only"` made concrete, and it is why this test uses a local source rather than pretending a
 * remote one installs.
 */

const AT = "2026-09-23T05:00:00.000Z";
const PACKAGE_ID = "com.example.local-chain";
const VERSION = "1.0.0";
const DIGEST = "sha256:local-chain-digest";

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
    displayName: "Local chain fixture",
    description: "A local package installed end to end over the HTTP API.",
    source: { kind: "local", path: packageRoot },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 512,
    digest: DIGEST,
    ...overrides,
  };
}

function writeIndex(entries: readonly Record<string, unknown>[]): void {
  writeFileSync(indexPath, JSON.stringify(entries));
}

async function request(input: { method: string; path: string; body?: Record<string, unknown> }): Promise<GatewayResponse> {
  const gatewayRequest: GatewayRequest = {
    method: input.method,
    path: input.path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: input.body === undefined ? "" : JSON.stringify(input.body),
  };
  return handleRequest(deps, gatewayRequest);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-install-chain-"));
  packageRoot = join(dir, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "clarkcant.json"), JSON.stringify({ schemaVersion: 1, id: PACKAGE_ID }));
  indexPath = join(dir, "directory.json");
  services = bootNodeServices({ dataDir: dir, label: "install chain test node" });
  deps = { services, now: () => AT as never };
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a local package install, end to end over the HTTP API", () => {
  it("installs, activates, is listed, and freezes a build input a locked build can read back", async () => {
    writeIndex([directoryEntry()]);

    const response = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });

    // Policy: Guarded (this node's default) does not ask before a local-write that stays on this
    // machine and no rule flags, so the install runs to completion in one call — the same decision
    // `execution-policy.spec.ts` proves for `local-write` in general.
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body["state"]).toBe("active");
    expect(body["verified"]).toBe("digest-only");
    const generationId = String(body["generationId"]);
    expect(generationId).toContain(`${PACKAGE_ID}@${VERSION}`);

    // Frozen closure: this entry publishes a digest, so `freezeInstallClosure` resolved and locked it
    // before the plan was consented, and the route reports what a build would read back.
    const lock = body["lock"] as Record<string, unknown> | null;
    expect(lock).not.toBeNull();
    expect(lock?.["coverage"]).toBe("artifact-only");
    expect(lock?.["digest"]).toBeTypeOf("string");

    // Activation: the generation is now what `/packages` lists as installed on this node.
    const listed = await request({ method: "GET", path: "/packages" });
    expect(listed.status).toBe(200);
    const packages = (listed.body as { packages: { packageId: string; version: string }[] }).packages;
    expect(packages).toContainEqual(expect.objectContaining({ packageId: PACKAGE_ID, version: VERSION }));
  });

  it("names the honest boundary: an installed package grants no capability a dispatched task can use", async () => {
    writeIndex([directoryEntry()]);

    await request({
      method: "POST",
      path: "/packages/install",
      // A forged grant in the request body, exactly like the regression in package-install-route.spec.ts —
      // proving here that even a capability an attacker tried to grant through this exact install is not
      // reachable by `invocationPreflight`, which is what a dispatched task consults before it runs.
      body: {
        packageId: PACKAGE_ID,
        version: VERSION,
        localDigest: DIGEST,
        grantedCapabilities: ["forged.capability@1"],
      },
    });

    const preflight = invocationPreflight(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
      "forged.capability@1" as CapabilityRef,
    );

    expect(preflight.ready).toBe(false);
    if (!preflight.ready) expect(preflight.code).toBe("CAPABILITY_MISSING");
  });
});
