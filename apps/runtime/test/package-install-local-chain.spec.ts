import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  inboxResponseSchema,
  type CapabilityRef,
  type Instant,
  type ReachChange,
  type ReachChangeView,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, digestOfDirectory, invocationPreflight, writeRegisteredPreference } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { recordNodeNotice } from "../src/notices.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A local package install driven entirely over the HTTP API the browser uses, end to end: the route
 * parses the request, `installPackage` decides with the execution policy that gates every other
 * effect, `freezeInstallClosure` resolves and locks the dependency closure before anything installs,
 * `installFromEntry`/`installFromSource` plan, consent and activate the generation, and the response
 * names what was actually verified.
 *
 * What this test does **not** claim: that the installed package's capability becomes usable by a
 * dispatched task purely because it was requested. `installPackage` derives the granted set from what
 * was requested through `deriveGrantedCapabilities` (`install-consent.ts`), asking the same execution
 * policy every other effect on this node answers to — never from the request body itself (issue #93,
 * P1 stays fixed: a client cannot declare its own grant). This test requests no capabilities, so its
 * granted set is empty regardless; the second test below proves the boundary that a forged
 * `grantedCapabilities` in the body still cannot become authority, rather than faking past it.
 *
 * `git`/`npm` sources are fetched into a node-owned cache before this route's own install path ever
 * sees them (`fetchRemoteArtifact`, `package-fetch.ts`), so a remote entry now activates the same way a
 * `local` one does — `apps/runtime/test/package-install-route.spec.ts` exercises that path end to end
 * with a real git fixture, and `packages/core/test/package-fetch.spec.ts` covers the fetch transport
 * itself (a local bare git repo, and a local fake npm registry). This test still uses a local source,
 * because it is about the install lifecycle a fetched artifact is fed into, not about the fetch itself.
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

describe("what a package reaches outside its sandbox, as the listing showed it", () => {
  const MAPS = { provider: "example.maps", scopes: ["tiles:read", "geocode:read"], purpose: "Draws the map tiles." };

  /** A manifest whose UI facet asks for a browser token, which is what the listing has to show before install. */
  function declareBrowserTokens(scopes: readonly string[] = MAPS.scopes): void {
    writeFileSync(
      join(packageRoot, "clarkcant.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: PACKAGE_ID,
        version: VERSION,
        displayName: "Local chain fixture",
        description: "A local package installed end to end over the HTTP API.",
        hostApi: { min: 1, max: 1 },
        facets: [
          {
            kind: "ui",
            id: "com.example.local-chain.map@1",
            entry: "widgets/map/index.html",
            definition: "widgets/map/widget.json",
            isolation: "isolated-ui",
            browserTokens: { version: 1, providers: [{ ...MAPS, scopes }] },
          },
        ],
        requestedCapabilities: [],
        permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
        platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
      }),
    );
  }

  const install = () =>
    request({ method: "POST", path: "/packages/install", body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST } });
  const listed = async () => (await request({ method: "GET", path: "/packages" })).body as { packages: Record<string, unknown>[] };

  it("refuses an artifact that asks for a browser token its listing did not show, and installs nothing", async () => {
    declareBrowserTokens();
    writeIndex([directoryEntry()]);

    const refused = await install();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "DECLARED_REACH_MISMATCH" });
    expect((refused.body as { message: string }).message).toContain("the browser tokens it asks for");
    expect((await listed()).packages).toEqual([]);
  });

  it("refuses a listing that showed fewer scopes than the artifact asks for", async () => {
    declareBrowserTokens();
    writeIndex([
      directoryEntry({ declaredReach: { origins: [], secrets: [], browserTokens: [{ ...MAPS, scopes: ["tiles:read"] }] } }),
    ]);

    expect((await install()).body).toMatchObject({ code: "DECLARED_REACH_MISMATCH" });
    expect((await listed()).packages).toEqual([]);
  });

  it("installs when the listing showed what the artifact declares, in any order, and package details list it", async () => {
    declareBrowserTokens();
    writeIndex([
      directoryEntry({
        declaredReach: { origins: [], secrets: [], browserTokens: [{ ...MAPS, scopes: [...MAPS.scopes].reverse() }] },
      }),
    ]);

    const installed = await install();
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    const [entry] = (await listed()).packages;
    expect(entry?.packageId).toBe(PACKAGE_ID);
    // From the installed manifest, in one order, with the scopes it declares.
    expect(entry?.reach).toEqual({
      origins: [],
      secrets: [],
      browserTokens: [{ provider: "example.maps", scopes: ["geocode:read", "tiles:read"], purpose: "Draws the map tiles." }],
    });
  });

  it("says nothing about reach for a package that reaches nothing", async () => {
    writeIndex([directoryEntry()]);
    expect((await install()).status).toBe(200);
    expect((await listed()).packages[0]).not.toHaveProperty("reach");
  });
});

describe("the resource profile a listing shows", () => {
  function requestProfile(profile: string): void {
    writeFileSync(
      join(packageRoot, "clarkcant.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: PACKAGE_ID,
        version: VERSION,
        displayName: "Local chain fixture",
        description: "A local package installed end to end over the HTTP API.",
        hostApi: { min: 1, max: 1 },
        facets: [{ kind: "ui", id: "com.example.local-chain.panel@1", entry: "widgets/panel/index.html", definition: "widgets/panel/widget.json", isolation: "isolated-ui" }],
        requestedCapabilities: [],
        permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
        platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
        resources: { version: 1, profile },
      }),
    );
  }

  const install = () =>
    request({ method: "POST", path: "/packages/install", body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST } });

  it("refuses an artifact that requests another profile than its listing shows, an absent one meaning the default", async () => {
    requestProfile("media-workstation");
    writeIndex([directoryEntry()]);
    const refused = await install();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "DECLARED_REACH_MISMATCH" });
    expect((refused.body as { message: string }).message).toContain("the resource profile interactive-light");

    writeIndex([directoryEntry({ resources: { version: 1, profile: "background-compute" } })]);
    expect((await install()).body).toMatchObject({ code: "DECLARED_REACH_MISMATCH" });
    expect(((await request({ method: "GET", path: "/packages" })).body as { packages: unknown[] }).packages).toEqual([]);
  });

  it("installs when the listing shows the profile the artifact requests", async () => {
    requestProfile("media-workstation");
    writeIndex([directoryEntry({ resources: { version: 1, profile: "media-workstation" } })]);
    const installed = await install();
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
  });
});

describe("an update's install question and notice say what the new version reaches beyond the installed one", () => {
  const NEXT = "1.1.0";
  const TILES = { provider: "example.maps", scopes: ["tiles:read"], purpose: "Draws the map tiles." };
  const FORECAST = { origin: "https://forecast.example.com", purpose: "Reads the forecast for the map." };
  let nextRoot: string;
  let nextDigest: string;

  /** The installed version: a frame that may be given a map-tiles token, installed through the ordinary route. */
  async function installFirstVersion(): Promise<void> {
    writeFileSync(
      join(packageRoot, "clarkcant.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: PACKAGE_ID,
        version: VERSION,
        displayName: "Local chain fixture",
        description: "A local package installed end to end over the HTTP API.",
        hostApi: { min: 1, max: 1 },
        facets: [
          {
            kind: "ui",
            id: "com.example.local-chain.map@1",
            entry: "widgets/map/index.html",
            definition: "widgets/map/widget.json",
            isolation: "isolated-ui",
            browserTokens: { version: 1, providers: [TILES] },
          },
        ],
        requestedCapabilities: [],
        permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
        platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
      }),
    );
    writeIndex([directoryEntry({ declaredReach: { origins: [], secrets: [], browserTokens: [TILES] } })]);
    const installed = await request({ method: "POST", path: "/packages/install", body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST } });
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
  }

  /** The installed version's listing stays, and the next version is listed beside it with `reach`. */
  function listNextVersion(reach: Record<string, unknown>): void {
    writeIndex([
      directoryEntry({ declaredReach: { origins: [], secrets: [], browserTokens: [TILES] } }),
      directoryEntry({ version: NEXT, source: { kind: "local", path: nextRoot }, digest: nextDigest, declaredReach: reach }),
    ]);
  }

  function askBeforeInstalling(): void {
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT as Instant },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, rules: [{ effectCategory: "local-write", decision: "ask" }] },
        source: "user",
      },
    );
    if (!written.ok) throw new Error(written.message);
  }

  /** The change itself, failing the test when the node could not compare the two versions. */
  function compared(view: ReachChangeView | undefined): ReachChange {
    if (view === undefined || view.verdict === "unknown") throw new Error(`the update was not compared: ${JSON.stringify(view)}`);
    return view;
  }

  async function askToUpdate() {
    const asked = await request({ method: "POST", path: "/packages/install", body: { packageId: PACKAGE_ID, version: NEXT } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const inbox = inboxResponseSchema.parse((await request({ method: "GET", path: "/inbox" })).body);
    const [item] = inbox.waiting.filter((entry) => entry.kind === "install-approval");
    if (item?.kind !== "install-approval") throw new Error("the update raised no install question");
    return { item, inbox };
  }

  beforeEach(() => {
    nextRoot = join(dir, "package-next");
    mkdirSync(nextRoot, { recursive: true });
    writeFileSync(join(nextRoot, "clarkcant.json"), JSON.stringify({ schemaVersion: 2, id: PACKAGE_ID, version: NEXT }));
    const digest = digestOfDirectory(nextRoot);
    if (!digest.ok) throw new Error(digest.message);
    nextDigest = digest.digest;
  });

  it("lists what a wider update adds on its install question and on its notice, and the policy still asks as before", async () => {
    await installFirstVersion();
    listNextVersion({ origins: [FORECAST], secrets: [], browserTokens: [{ ...TILES, scopes: ["tiles:read", "geocode:read"] }] });
    askBeforeInstalling();
    recordNodeNotice(services, {
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: `Có bản cập nhật: ${PACKAGE_ID}`,
      subject: { kind: "package", packageId: PACKAGE_ID, version: NEXT, source: "local" },
      dedupKey: `update:local:${PACKAGE_ID}@${NEXT}`,
      at: AT as Instant,
    });

    const { item, inbox } = await askToUpdate();
    expect(item.version).toBe(NEXT);
    const change = compared(item.reachChange);
    expect(change.verdict).toBe("wider");
    expect(change.origins).toEqual({ added: [FORECAST], removed: [] });
    expect(change.browserTokens).toEqual({ added: [{ provider: "example.maps", scope: "geocode:read" }], removed: [] });
    expect(change.profile).toBeUndefined();
    // The notice the update came from says the same before anything is pressed.
    const notice = inbox.notices.find((entry) => entry.subject?.kind === "package" && entry.subject.version === NEXT);
    expect(notice?.reachChange).toEqual(item.reachChange);
    // Nothing was installed by asking.
    const listed = (await request({ method: "GET", path: "/packages" })).body as { packages: { version: string }[] };
    expect(listed.packages.map((entry) => entry.version)).toEqual([VERSION]);
  });

  it("lists nothing added for an update that reaches the same", async () => {
    await installFirstVersion();
    listNextVersion({ origins: [], secrets: [], browserTokens: [TILES] });
    askBeforeInstalling();

    const { item } = await askToUpdate();
    const change = compared(item.reachChange);
    expect(change.verdict).toBe("unchanged");
    for (const set of [change.origins, change.secrets, change.keyDestinations, change.browserTokens, change.connectionScopes, change.connectionEndpoints]) {
      expect(set).toEqual({ added: [], removed: [] });
    }
  });

  it("says it could not compare when the installed version's listing is gone, on the question and on the notice", async () => {
    await installFirstVersion();
    // Only the next version is listed: the files of the installed one can no longer be found through the directory.
    writeIndex([directoryEntry({ version: NEXT, source: { kind: "local", path: nextRoot }, digest: nextDigest, declaredReach: { origins: [FORECAST], secrets: [], browserTokens: [] } })]);
    askBeforeInstalling();
    recordNodeNotice(services, {
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: `Có bản cập nhật: ${PACKAGE_ID}`,
      subject: { kind: "package", packageId: PACKAGE_ID, version: NEXT, source: "local" },
      dedupKey: `update:local:${PACKAGE_ID}@${NEXT}`,
      at: AT as Instant,
    });

    const { item, inbox } = await askToUpdate();
    expect(item.reachChange).toEqual({ verdict: "unknown" });
    const notice = inbox.notices.find((entry) => entry.subject?.kind === "package" && entry.subject.version === NEXT);
    expect(notice?.reachChange).toEqual({ verdict: "unknown" });
  });

  it("says it could not compare on a notice whose version the directory no longer lists", async () => {
    await installFirstVersion();
    recordNodeNotice(services, {
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: `Có bản cập nhật: ${PACKAGE_ID}`,
      subject: { kind: "package", packageId: PACKAGE_ID, version: NEXT, source: "local" },
      dedupKey: `update:local:${PACKAGE_ID}@${NEXT}`,
      at: AT as Instant,
    });
    const inbox = inboxResponseSchema.parse((await request({ method: "GET", path: "/inbox" })).body);
    const notice = inbox.notices.find((entry) => entry.subject?.kind === "package" && entry.subject.version === NEXT);
    expect(notice?.reachChange).toEqual({ verdict: "unknown" });
  });

  it("says nothing about a change on the question for a package that is not installed", async () => {
    writeIndex([directoryEntry({ declaredReach: { origins: [], secrets: [], browserTokens: [TILES] } })]);
    askBeforeInstalling();
    const asked = await request({ method: "POST", path: "/packages/install", body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST } });
    expect(asked.status).toBe(202);
    const inbox = inboxResponseSchema.parse((await request({ method: "GET", path: "/inbox" })).body);
    expect(inbox.waiting.find((entry) => entry.kind === "install-approval")).not.toHaveProperty("reachChange");
  });
});
