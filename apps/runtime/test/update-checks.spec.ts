import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Instant, Platform } from "@clarkcant/contracts";
import type { InstalledPackageView } from "@clarkcant/core";

import { listNotifications } from "@clarkcant/storage";

import {
  checkForUpdates,
  isNewerVersion,
  runUpdateCheckOnce,
  startUpdateCheckTimer,
  type UpdateCandidate,
} from "../src/update-checks.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The update-check producer (#169).
 *
 * `checkForUpdates` is the testable core the phase asks for: every IO it needs — installed packages, directory
 * entries, the Pi SDK's own pinned version, `fetch`, the clock — arrives as an argument, so these tests drive it
 * without a real registry, a real directory file or a real Pi install. `runUpdateCheckOnce`/`startUpdateCheckTimer`
 * get lighter tests of their own wiring and timer behaviour.
 */

const AT = "2026-09-24T08:00:00.000Z" as Instant;
/** Pinned, so the fixtures' `linux-x64` entries fit whatever machine runs this suite. */
const HOST: Platform = "linux-x64";

let dir: string;
let services: NodeServices;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-update-checks-"));
  services = bootNodeServices({ dataDir: dir, label: "update check test node" });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function installedPackage(overrides: Partial<InstalledPackageView>): InstalledPackageView {
  return {
    packageId: "com.example.widget",
    version: "1.0.0",
    digest: "sha256:fixture",
    codeGeneration: "gen-1",
    activatedAt: AT,
    source: { sourceTier: "curated-registry", rationale: "npm com.example.widget@1.0.0", artifactUrl: "npm:com.example.widget@1.0.0" },
    lane: "isolated-ui",
    consentedDigest: "sha256:fixture",
    lock: undefined,
    previousVersion: undefined,
    ...overrides,
  };
}

function directoryCandidate(overrides: Partial<UpdateCandidate>): UpdateCandidate {
  return {
    packageId: "com.example.widget",
    version: "1.1.0",
    sourceKind: "npm",
    lane: "isolated-ui",
    digest: "sha256:directory-fixture",
    hostApi: { min: 1, max: 1 },
    platforms: ["linux-x64"],
    ...overrides,
  };
}

/** A `fetch` that always answers "the latest published version is `version`". */
function fetchReturning(version: string): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch;
}

/** A `fetch` that fails the way a machine with no network does: the call itself rejects. */
function fetchOffline(): typeof fetch {
  return vi.fn(async () => {
    throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
  }) as unknown as typeof fetch;
}

describe("isNewerVersion", () => {
  it("compares ordinary semver numerically, not lexically", () => {
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });

  it("treats a release as newer than a prerelease of the same triple", () => {
    expect(isNewerVersion("1.0.0", "1.0.0-beta")).toBe(true);
    expect(isNewerVersion("1.0.0-beta", "1.0.0")).toBe(false);
  });

  it("never offers a prerelease to a stable install, even one naming a higher core version", () => {
    expect(isNewerVersion("1.1.0-beta.1", "1.0.0")).toBe(false);
    // A stable release of a higher core version is still offered.
    expect(isNewerVersion("1.1.0", "1.0.0")).toBe(true);
    // A prerelease install may still be offered a prerelease of a higher core version.
    expect(isNewerVersion("1.1.0-beta.1", "1.0.0-beta.1")).toBe(true);
  });

  it("compares prerelease identifiers numerically, not lexically", () => {
    expect(isNewerVersion("1.0.0-beta.10", "1.0.0-beta.9")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.9", "1.0.0-beta.10")).toBe(false);
  });

  it("answers false when either side is not valid semver, never falling back to a string compare", () => {
    expect(isNewerVersion("not-a-version", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "not-a-version")).toBe(false);
  });
});

describe("checkForUpdates — packages and widgets", () => {
  it("records one notice per package with a newer directory version, naming source and risk lane", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0", lane: "isolated-ui" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.2.0", sourceKind: "npm", lane: "isolated-ui" })],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });

    expect(report.packageUpdates).toBe(1);
    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    const packageNotice = notices.find((notice) => notice.sourceKind === "package");
    expect(packageNotice).toBeDefined();
    expect(packageNotice?.category).toBe("update");
    expect(packageNotice?.title).toContain("com.example.widget");
    expect(packageNotice?.body).toContain("1.0.0");
    expect(packageNotice?.body).toContain("1.2.0");
    expect(packageNotice?.body).toContain("npm");
  });

  it("labels a trusted-native package differently from an isolated widget", async () => {
    await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.native", version: "1.0.0", lane: "trusted-native" })],
      directory: [directoryCandidate({ packageId: "com.example.native", version: "2.0.0", sourceKind: "git", lane: "trusted-native" })],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });
    await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.isolated", version: "1.0.0", lane: "isolated-ui" })],
      directory: [directoryCandidate({ packageId: "com.example.isolated", version: "2.0.0", sourceKind: "npm", lane: "isolated-ui" })],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });

    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    const nativeNotice = notices.find((notice) => notice.title.includes("com.example.native"));
    const isolatedNotice = notices.find((notice) => notice.title.includes("com.example.isolated"));
    expect(nativeNotice?.body).toContain("extension Pi gốc");
    expect(isolatedNotice?.body).toContain("widget cách ly");
    // AGENTS.md: the two lanes must never read with the same wording.
    expect(nativeNotice?.body).not.toEqual(isolatedNotice?.body);
  });

  it("writes nothing when the directory version is not newer than what is installed", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.2.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.2.0" })],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("writes nothing when the directory only lists an older version than what is installed", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "2.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.9.0" })],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("picks the highest version when the directory lists several for the same package", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [
        directoryCandidate({ packageId: "com.example.widget", version: "1.1.0" }),
        directoryCandidate({ packageId: "com.example.widget", version: "1.3.0" }),
        directoryCandidate({ packageId: "com.example.widget", version: "1.2.0" }),
      ],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(1);
    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    const notice = notices.find((n) => n.sourceKind === "package");
    expect(notice?.body).toContain("1.3.0");
  });

  it("skips a directory entry that does not fit this host's platform", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [
        directoryCandidate({ packageId: "com.example.widget", version: "2.0.0", platforms: ["win32-x64"] }),
      ],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("skips a directory entry that publishes no digest — the installer would refuse it too", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "2.0.0", digest: "" })],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("dedups: checking the same newer version twice writes only one row", async () => {
    const input = {
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.3.0" })],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    };
    await checkForUpdates(input);
    await checkForUpdates(input);

    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    expect(notices.filter((notice) => notice.sourceKind === "package")).toHaveLength(1);
  });

  it("writes a new notice once a version newer still is published, keyed by the exact version", async () => {
    await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.1.0" })],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });
    await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.2.0" })],
      piInstalledVersion: "1.0.0",
      fetchImpl: fetchReturning("1.0.0"),
      now: () => AT,
      platform: HOST,
    });

    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    expect(notices.filter((notice) => notice.sourceKind === "package")).toHaveLength(2);
  });
});

describe("checkForUpdates — Pi SDK", () => {
  it("records a notice, sourced as pi and lane-labelled trusted-native, when a newer SDK is published", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [],
      directory: [],
      piInstalledVersion: "0.85.1",
      fetchImpl: fetchReturning("0.86.0"),
      now: () => AT,
      platform: HOST,
    });

    expect(report.piUpdate).toBe(true);
    expect(report.piOffline).toBe(false);
    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.sourceKind).toBe("pi");
    expect(notices[0]?.category).toBe("update");
    expect(notices[0]?.body).toContain("0.85.1");
    expect(notices[0]?.body).toContain("0.86.0");
    expect(notices[0]?.body).toContain("extension Pi gốc");
  });

  it("writes nothing when the registry's latest is not newer than what is pinned", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [],
      directory: [],
      piInstalledVersion: "0.85.1",
      fetchImpl: fetchReturning("0.85.1"),
      now: () => AT,
      platform: HOST,
    });
    expect(report.piUpdate).toBe(false);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("stays quiet — no notice, no throw — when the registry cannot be reached", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [],
      directory: [],
      piInstalledVersion: "0.85.1",
      fetchImpl: fetchOffline(),
      now: () => AT,
      platform: HOST,
    });
    expect(report.piOffline).toBe(true);
    expect(report.piUpdate).toBe(false);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("stays quiet when the registry answers with a non-2xx status", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const report = await checkForUpdates({
      services,
      installedPackages: [],
      directory: [],
      piInstalledVersion: "0.85.1",
      fetchImpl,
      now: () => AT,
      platform: HOST,
    });
    expect(report.piOffline).toBe(true);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("stays quiet when the registry answers with a version that is not valid semver", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [],
      directory: [],
      piInstalledVersion: "0.85.1",
      fetchImpl: fetchReturning("not-a-version"),
      now: () => AT,
      platform: HOST,
    });
    expect(report.piOffline).toBe(true);
    expect(report.piUpdate).toBe(false);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("never offers a prerelease Pi SDK build to a stable install", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [],
      directory: [],
      piInstalledVersion: "0.85.1",
      fetchImpl: fetchReturning("0.86.0-beta.1"),
      now: () => AT,
      platform: HOST,
    });
    expect(report.piUpdate).toBe(false);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("offline for the Pi SDK does not block a package update in the same pass", async () => {
    const report = await checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.1.0" })],
      piInstalledVersion: "0.85.1",
      fetchImpl: fetchOffline(),
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(1);
    expect(report.piOffline).toBe(true);
  });
});

describe("runUpdateCheckOnce", () => {
  it("wires listInstalledPackages, the directory index and the injected SDK reader together", async () => {
    const report = await runUpdateCheckOnce({
      services,
      installDeps: {
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        now: () => AT,
        newId: services.conductor.newId,
      },
      env: {},
      fetchImpl: fetchReturning("9.9.9"),
      piInstalledVersion: async () => "1.0.0",
      now: () => AT,
      platform: HOST,
    });
    expect(report.piUpdate).toBe(true);
    expect(report.packageUpdates).toBe(0);
  });

  it("finds a package update through a real directory index file, mapping the entry's riskTier to the notice's lane", async () => {
    const packageId = "com.example.native-tool";
    const indexPath = join(dir, "directory-index.json");
    writeFileSync(
      indexPath,
      JSON.stringify([
        {
          packageId,
          version: "2.0.0",
          displayName: "Native tool",
          description: "A directory-listed package exercised through the real index file.",
          source: { kind: "npm", name: packageId, version: "2.0.0" },
          publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
          preview: {},
          facets: ["tools"],
          isolations: [{ facetKind: "tools", isolation: "trusted-native" }],
          platforms: ["linux-x64"],
          hostApi: { min: 1, max: 1 },
          permissionsSummary: [],
          riskTier: "trusted-native",
          sizeBytes: 2048,
          digest: "sha256:native-tool-directory-fixture",
        },
      ]),
    );

    // One installed package generation, the same way other runtime tests seed `listInstalledPackages`
    // (installed-widgets-route.spec.ts): a direct insert into `package_generations`, since there is no public
    // writer for a generation outside the full install lifecycle.
    services.runtime.db
      .prepare(
        `INSERT INTO package_generations
           (generation_id, package_id, version, digest, node_id, code_generation, activated_at, superseded_at, document)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        "gen_wiring_1",
        packageId,
        "1.0.0",
        "sha256:native-tool-installed-fixture",
        services.runtime.identity.nodeId,
        "code-1",
        AT,
        JSON.stringify({
          generationId: "gen_wiring_1",
          packageId,
          version: "1.0.0",
          digest: "sha256:native-tool-installed-fixture",
          nodeId: services.runtime.identity.nodeId,
          codeGeneration: "code-1",
          activatedAt: AT,
          uiOnlyFacets: [],
          grantedCapabilities: [],
        }),
      );

    const report = await runUpdateCheckOnce({
      services,
      installDeps: {
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        now: () => AT,
        newId: services.conductor.newId,
      },
      env: { CC_DIRECTORY_INDEX: indexPath },
      fetchImpl: fetchReturning("1.0.0"),
      piInstalledVersion: async () => "1.0.0",
      now: () => AT,
      platform: HOST,
    });

    expect(report.packageUpdates).toBe(1);
    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    const notice = notices.find((n) => n.sourceKind === "package");
    expect(notice?.title).toContain(packageId);
    expect(notice?.body).toContain("1.0.0");
    expect(notice?.body).toContain("2.0.0");
    // The directory entry's riskTier is "trusted-native"; the notice must carry that lane's wording, not the
    // isolated-widget one.
    expect(notice?.body).toContain("extension Pi gốc");
  });
});

describe("startUpdateCheckTimer", () => {
  it("runs once shortly after start, then never overlaps a second pass while the first is still pending", async () => {
    vi.useFakeTimers();
    try {
      // Never resolves, so the first pass is still "in flight" for the entire test — proving the interval's later
      // firings see `inFlight` still true and skip, rather than merely not having fired again yet.
      const piInstalledVersion = vi.fn(() => new Promise<string>(() => {}));
      const handle = startUpdateCheckTimer({
        services,
        installDeps: {
          db: services.runtime.db,
          nodeId: services.runtime.identity.nodeId,
          now: () => AT,
          newId: services.conductor.newId,
        },
        env: {},
        fetchImpl: fetchReturning("1.0.0"),
        piInstalledVersion,
        intervalMs: 60_000,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(piInstalledVersion).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(piInstalledVersion).toHaveBeenCalledTimes(1);

      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() clears the start and interval timers so no further pass starts", async () => {
    vi.useFakeTimers();
    try {
      const piInstalledVersion = vi.fn(async () => "1.0.0");
      const handle = startUpdateCheckTimer({
        services,
        installDeps: {
          db: services.runtime.db,
          nodeId: services.runtime.identity.nodeId,
          now: () => AT,
          newId: services.conductor.newId,
        },
        env: {},
        fetchImpl: fetchReturning("1.0.0"),
        piInstalledVersion,
        intervalMs: 60_000,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(piInstalledVersion).toHaveBeenCalledTimes(1);

      handle.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      // Stopped before the interval fired again: no second pass.
      expect(piInstalledVersion).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() aborts a pass's registry fetch, so a pass stopped mid-flight writes no notice", async () => {
    vi.useFakeTimers();
    try {
      // A `fetch` that never settles on its own, the way real `fetch` behaves once its `signal` fires: it settles
      // only when told to abort.
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ) as unknown as typeof fetch;
      const handle = startUpdateCheckTimer({
        services,
        installDeps: {
          db: services.runtime.db,
          nodeId: services.runtime.identity.nodeId,
          now: () => AT,
          newId: services.conductor.newId,
        },
        env: {},
        fetchImpl,
        piInstalledVersion: async () => "0.85.1",
        intervalMs: 60_000,
      });

      // Starts the pass: the pi-installed-version resolves immediately, the pass reaches the registry fetch and is
      // now waiting on it.
      await vi.advanceTimersByTimeAsync(0);
      handle.stop();
      // Let the abort's rejection propagate through `fetchLatestNpmVersion`'s catch and the pass settle.
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
