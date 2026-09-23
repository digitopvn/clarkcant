import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG } from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, writeRegisteredPreference } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * M1: a capability the execution policy would ask about, or refuse, is reported back rather than silently
 * dropped.
 *
 * The package here has `riskTier: "service"`, which `effectCategoryForLane` (install-consent.ts) decides in the
 * `destructive` effect category — separate from the install itself, which is always decided in `local-write`. That
 * separation is what lets this test hold the install's own decision at "execute" (autonomous mode, no rule for
 * `local-write`, so it proceeds) while a policy rule targets only the *capability* decision, proving the two are
 * independently derived rather than one flag covering both.
 */

const AT = "2026-09-23T06:00:00.000Z";
const PACKAGE_ID = "com.example.capability-approval";
const VERSION = "1.0.0";
const DIGEST = "sha256:capability-approval-digest";
const REQUESTED_CAPABILITY = "project.code.write@1";

let dir: string;
let packageRoot: string;
let indexPath: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;

function directoryEntry(): Record<string, unknown> {
  return {
    packageId: PACKAGE_ID,
    version: VERSION,
    displayName: "Capability approval fixture",
    description: "A package that requests one capability at the service risk lane.",
    source: { kind: "local", path: packageRoot },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["tools"],
    isolations: [{ facetKind: "tools", isolation: "service" }],
    platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "service",
    sizeBytes: 512,
    digest: DIGEST,
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
  dir = mkdtempSync(join(tmpdir(), "clarkcant-install-capability-approval-"));
  packageRoot = join(dir, "package");
  mkdirSync(packageRoot, { recursive: true });
  // A manifest the reader actually parses (unlike the other local-install fixtures' deliberately-incomplete
  // `clarkcant.json`), so `readPackage(...).manifest.requestedCapabilities` really carries the capability this
  // test is about. The one declared facet's own definition file is never written — `readPackage` still returns
  // the manifest when a facet's definition cannot be read, only the facet itself is dropped (with a problem this
  // test does not care about), so nothing here needs a working widget frame.
  writeFileSync(
    join(packageRoot, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PACKAGE_ID,
      version: VERSION,
      displayName: "Capability approval fixture",
      description: "A package that requests one capability at the service risk lane.",
      hostApi: { min: 1, max: 1 },
      facets: [{ kind: "widget", id: `${PACKAGE_ID}.tool`, entry: "tool.js", definition: "tool.json", isolation: "isolated-ui" }],
      requestedCapabilities: [REQUESTED_CAPABILITY],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
  indexPath = join(dir, "directory.json");
  services = bootNodeServices({ dataDir: dir, label: "install capability approval test node" });
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

/** Sets a rule targeting the `destructive` category only — the category a `service`-lane capability is decided
 * in, never the `local-write` category the install itself is decided in — so the install still runs to
 * completion and only the capability grant is affected. */
function setDestructiveRule(decision: "ask" | "deny"): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now: () => AT as never },
    {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      value: {
        ...DEFAULT_EXECUTION_POLICY_CONFIG,
        rules: [{ effectCategory: "destructive", decision }],
      },
      source: "user",
    },
  );
  if (!written.ok) throw new Error(written.message);
}

describe("M1: a capability the policy would ask about or deny is reported, not silently dropped", () => {
  it("creates a real approval for a capability the policy asks about, and lists it as pending", async () => {
    writeIndex([directoryEntry()]);
    setDestructiveRule("ask");

    const response = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });

    // The install itself still ran to completion: only the capability's own category was ruled to ask.
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body["state"]).toBe("active");

    const pending = body["pendingCapabilities"] as readonly { ref: string; approvalId: string }[];
    expect(pending).toHaveLength(1);
    const [first] = pending;
    if (first === undefined) throw new Error("expected one pending capability");
    expect(first.ref).toBe(REQUESTED_CAPABILITY);
    expect(typeof first.approvalId).toBe("string");
    expect(body["deniedCapabilities"]).toEqual([]);

    // The pending entry is a real record through the existing approval path (`requestApproval`), not a value
    // this route made up for the response — proven by reading it back from the same table `/packages/install`'s
    // own "asks first" case is asserted against.
    const approvalRow = services.runtime.db
      .prepare("SELECT operation_digest, effect_category FROM approvals WHERE approval_id = ?")
      .get(first.approvalId) as { operation_digest: string; effect_category: string } | undefined;
    expect(approvalRow).toBeDefined();
    expect(approvalRow?.effect_category).toBe("destructive");
    expect(approvalRow?.operation_digest).toBe(`${DIGEST}:${REQUESTED_CAPABILITY}`);

    // Not granted: the generation this install activated does not carry a capability still pending approval.
    const generationId = String(body["generationId"]);
    const generationRow = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generationId) as { document: string };
    const generationDoc = JSON.parse(generationRow.document) as { grantedCapabilities: readonly string[] };
    expect(generationDoc.grantedCapabilities).toEqual([]);
  });

  it("reuses the same pending approval on a second install of the same digest, instead of a duplicate", async () => {
    writeIndex([directoryEntry()]);
    setDestructiveRule("ask");

    const first = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });
    const second = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });

    const firstPending = (first.body as Record<string, unknown>)["pendingCapabilities"] as readonly { approvalId: string }[];
    const secondPending = (second.body as Record<string, unknown>)["pendingCapabilities"] as readonly { approvalId: string }[];
    expect(secondPending[0]?.approvalId).toBe(firstPending[0]?.approvalId);

    const rows = services.runtime.db
      .prepare("SELECT approval_id FROM approvals WHERE operation_digest = ?")
      .all(`${DIGEST}:${REQUESTED_CAPABILITY}`) as { approval_id: string }[];
    expect(rows).toHaveLength(1);
  });

  it("reports a capability the policy denies as denied, and grants it nothing", async () => {
    writeIndex([directoryEntry()]);
    setDestructiveRule("deny");

    const response = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body["state"]).toBe("active");
    expect(body["pendingCapabilities"]).toEqual([]);
    expect(body["deniedCapabilities"]).toEqual([REQUESTED_CAPABILITY]);
  });

  it("[fails on the old behaviour] would otherwise silently drop the pending capability from the response", async () => {
    /*
     * This test documents the regression by construction rather than by literally reverting the source: the old
     * `PackageInstallOutcome` shape (before M1) carried no `pendingCapabilities`/`deniedCapabilities` fields at
     * all, so this same assertion — that a capability the policy asks about is visible somewhere in the response
     * — could not have passed against it. Kept as its own case so a future regression that drops the fields
     * again fails here specifically, with a name that says what broke.
     */
    writeIndex([directoryEntry()]);
    setDestructiveRule("ask");

    const response = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });
    const body = response.body as Record<string, unknown>;
    expect(Object.hasOwn(body, "pendingCapabilities")).toBe(true);
    expect(Object.hasOwn(body, "deniedCapabilities")).toBe(true);
  });
});
