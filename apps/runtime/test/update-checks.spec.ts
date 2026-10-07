import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Instant, Platform } from "@clarkcant/contracts";
import type { InstalledPackageView } from "@clarkcant/core";

import { getNotification, listNotifications, recordNotification } from "@clarkcant/storage";

import {
  checkForUpdates,
  isNewerVersion,
  runUpdateCheckOnce,
  startUpdateCheckTimer,
  type UpdateCandidate,
} from "../src/update-checks.ts";
import { readInbox } from "../src/inbox.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The update-check producer (#169).
 *
 * `checkForUpdates` is the testable core the phase asks for: every IO it needs — installed packages, directory
 * entries, the clock — arrives as an argument, so these tests drive it without a real directory file. `runUpdateCheckOnce`/`startUpdateCheckTimer`
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
  it("records one notice per package with a newer directory version, naming source and risk lane", () => {
    const report = checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0", lane: "isolated-ui" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.2.0", sourceKind: "npm", lane: "isolated-ui" })],
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
    checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.native", version: "1.0.0", lane: "trusted-native" })],
      directory: [directoryCandidate({ packageId: "com.example.native", version: "2.0.0", sourceKind: "git", lane: "trusted-native" })],
      now: () => AT,
      platform: HOST,
    });
    checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.isolated", version: "1.0.0", lane: "isolated-ui" })],
      directory: [directoryCandidate({ packageId: "com.example.isolated", version: "2.0.0", sourceKind: "npm", lane: "isolated-ui" })],
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

  it("writes nothing when the directory version is not newer than what is installed", () => {
    const report = checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.2.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.2.0" })],
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("writes nothing when the directory only lists an older version than what is installed", () => {
    const report = checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "2.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.9.0" })],
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("picks the highest version when the directory lists several for the same package", () => {
    const report = checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [
        directoryCandidate({ packageId: "com.example.widget", version: "1.1.0" }),
        directoryCandidate({ packageId: "com.example.widget", version: "1.3.0" }),
        directoryCandidate({ packageId: "com.example.widget", version: "1.2.0" }),
      ],
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(1);
    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    const notice = notices.find((n) => n.sourceKind === "package");
    expect(notice?.body).toContain("1.3.0");
  });

  it("skips a directory entry that does not fit this host's platform", () => {
    const report = checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [
        directoryCandidate({ packageId: "com.example.widget", version: "2.0.0", platforms: ["win32-x64"] }),
      ],
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  it("skips a directory entry that publishes no digest — the installer would refuse it too", () => {
    const report = checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "2.0.0", digest: "" })],
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
      now: () => AT,
      platform: HOST,
    };
    checkForUpdates(input);
    checkForUpdates(input);

    const notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    expect(notices.filter((notice) => notice.sourceKind === "package")).toHaveLength(1);
  });

  it("writes a new notice once a version newer still is published, and retires the older one for the same package", async () => {
    const check = (version: string, sourceKind: UpdateCandidate["sourceKind"] = "npm") =>
      checkForUpdates({
        services,
        installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
        directory: [directoryCandidate({ packageId: "com.example.widget", version, sourceKind })],
        now: () => AT,
        platform: HOST,
      });
    check("1.1.0");
    const [older] = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    expect(older?.body).toContain("1.1.0");

    check("1.2.0");
    let notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    expect(notices.filter((notice) => notice.sourceKind === "package")).toHaveLength(1);
    expect(notices[0]?.body).toContain("1.0.0 → 1.2.0");
    // Retired the way a person's dismissal is: the row stays, dismissed, so 1.1.0 checked again does not come back.
    expect(getNotification(services.runtime.db, services.runtime.identity.ownerPrincipalId, older?.noticeId ?? "")?.dismissed).toBe(true);
    check("1.1.0");
    notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    expect(notices.map((notice) => notice.body)).toEqual([expect.stringContaining("1.0.0 → 1.2.0")]);

    // The same package announced from another source is still the same update to offer.
    check("1.3.0", "git");
    notices = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId);
    expect(notices.map((notice) => notice.body)).toEqual([expect.stringContaining("1.0.0 → 1.3.0 · nguồn git")]);
  });

  it("retires a legacy update notice with no stored subject, and never a package whose id only starts the same", async () => {
    const principalId = services.runtime.identity.ownerPrincipalId;
    const legacy = recordNotification(services.runtime.db, {
      notificationId: "ntf_legacy_update",
      principalId,
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: "Có bản cập nhật: com.example.widget",
      dedupKey: "update:npm:com.example.widget@1.0.5",
      at: AT,
    });
    const neighbour = recordNotification(services.runtime.db, {
      notificationId: "ntf_neighbour_update",
      principalId,
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: "Có bản cập nhật: com.example.widget@beta",
      subject: { kind: "package", packageId: "com.example.widget@beta", version: "2.0.0", source: "npm" },
      dedupKey: "update:npm:com.example.widget@beta@2.0.0",
      at: AT,
    });

    checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.1.0" })],
      now: () => AT,
      platform: HOST,
    });

    expect(getNotification(services.runtime.db, principalId, legacy.notificationId)?.dismissed).toBe(true);
    expect(getNotification(services.runtime.db, principalId, neighbour.notificationId)?.dismissed).toBe(false);
    const titles = listNotifications(services.runtime.db, principalId).map((notice) => notice.title);
    expect(titles.sort()).toEqual(["Có bản cập nhật: com.example.widget", "Có bản cập nhật: com.example.widget@beta"]);
  });
});

describe("checkForUpdates — the source an update comes from", () => {
  const MINE = { id: "custom-aaaa", kind: "custom-marketplace", label: "catalog.acme.example/feed" } as const;
  const THEIRS = { id: "official", kind: "official-marketplace", label: "ClarkCant Marketplace" } as const;
  const INDEX = { id: "local", kind: "local-file", label: "/home/me/index.json" } as const;

  function packageNotices() {
    return listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId).filter(
      (notice) => notice.sourceKind === "package",
    );
  }

  it("never offers another source's listing of the same package id as an update", () => {
    const report = checkForUpdates({
      services,
      installedPackages: [installedPackage({ version: "1.0.0", directorySource: MINE })],
      directory: [directoryCandidate({ version: "9.0.0", digest: "sha256:evil", origin: THEIRS })],
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
    expect(packageNotices()).toEqual([]);
  });

  it("offers the installed source's own newer version, and the notice names that source", () => {
    const report = checkForUpdates({
      services,
      installedPackages: [installedPackage({ version: "1.0.0", directorySource: MINE })],
      directory: [
        directoryCandidate({ version: "9.0.0", digest: "sha256:evil", origin: THEIRS }),
        directoryCandidate({ version: "1.1.0", origin: MINE, precededByUnreadSource: true }),
      ],
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(1);
    const [notice] = packageNotices();
    expect(notice?.body).toContain("1.1.0");
    expect(notice?.body).toContain(MINE.label);
    expect(notice?.body).not.toContain("9.0.0");
  });

  it("takes a package installed before sources were recorded from the index file when the index lists it", () => {
    const report = checkForUpdates({
      services,
      installedPackages: [installedPackage({ version: "1.0.0" })],
      directory: [
        directoryCandidate({ version: "1.0.0", origin: INDEX }),
        directoryCandidate({ version: "9.0.0", digest: "sha256:evil", origin: THEIRS }),
      ],
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
  });

  it("offers a package installed before sources were recorded nothing from behind a source that could not be read", () => {
    const behind = checkForUpdates({
      services,
      installedPackages: [installedPackage({ version: "1.0.0" })],
      directory: [directoryCandidate({ version: "1.1.0", origin: THEIRS, precededByUnreadSource: true })],
      now: () => AT,
      platform: HOST,
    });
    expect(behind.packageUpdates).toBe(0);

    const answered = checkForUpdates({
      services,
      installedPackages: [installedPackage({ version: "1.0.0" })],
      directory: [directoryCandidate({ version: "1.1.0", origin: THEIRS, precededByUnreadSource: false })],
      now: () => AT,
      platform: HOST,
    });
    expect(answered.packageUpdates).toBe(1);
    expect(packageNotices()[0]?.body).toContain(THEIRS.label);
  });
});

describe("checkForUpdates — Pi SDK", () => {
  it("does not check the Pi SDK: no registry call and no notice, since it ships pinned with ClarkCant", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const report = checkForUpdates({ services, installedPackages: [], directory: [], now: () => AT, platform: HOST });
      expect(report).toEqual({ packageUpdates: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("retires the Pi SDK update notices left from before, legacy ones without a subject included, and keeps their rows", () => {
    const principalId = services.runtime.identity.ownerPrincipalId;
    const pi = (notificationId: string, version: string, withSubject: boolean) =>
      recordNotification(services.runtime.db, {
        notificationId,
        principalId,
        sourceKind: "pi",
        category: "update",
        severity: "info",
        title: "Có bản cập nhật cho Pi SDK",
        body: `0.85.1 → ${version}`,
        ...(withSubject
          ? { subject: { kind: "pi-update" as const, packageName: "@earendil-works/pi-coding-agent", version } }
          : {}),
        dedupKey: `update:pi:@earendil-works/pi-coding-agent@${version}`,
        at: AT,
      });
    const legacy = pi("ntf_legacy_pi", "0.87.1", false);
    const current = pi("ntf_current_pi", "1.0.2", true);

    checkForUpdates({
      services,
      installedPackages: [installedPackage({ packageId: "com.example.widget", version: "1.0.0" })],
      directory: [directoryCandidate({ packageId: "com.example.widget", version: "1.1.0" })],
      now: () => AT,
      platform: HOST,
    });

    // Only the package update is left to see; the Pi rows are dismissed, not deleted.
    expect(listNotifications(services.runtime.db, principalId).map((notice) => notice.sourceKind)).toEqual(["package"]);
    expect(getNotification(services.runtime.db, principalId, legacy.notificationId)?.dismissed).toBe(true);
    expect(getNotification(services.runtime.db, principalId, current.notificationId)?.dismissed).toBe(true);
  });
});

describe("runUpdateCheckOnce", () => {
  it("wires listInstalledPackages and the directory index together, and writes nothing with no directory configured", () => {
    const report = runUpdateCheckOnce({
      services,
      installDeps: {
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        now: () => AT,
        newId: services.conductor.newId,
      },
      env: {},
      now: () => AT,
      platform: HOST,
    });
    expect(report.packageUpdates).toBe(0);
    expect(listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toHaveLength(0);
  });

  /**
   * A real index file listing `packageId@2.0.0` (with `extra` fields), and that package installed at 1.0.0 the same way
   * other runtime tests seed `listInstalledPackages` (installed-widgets-route.spec.ts): a direct insert into
   * `package_generations`, since there is no public writer for a generation outside the full install lifecycle.
   */
  function listedUpdate(packageId: string, extra: Record<string, unknown> = {}): string {
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
          ...extra,
        },
      ]),
    );
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
    return indexPath;
  }

  const checkOnce = (indexPath: string) =>
    runUpdateCheckOnce({
      services,
      installDeps: {
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        now: () => AT,
        newId: services.conductor.newId,
      },
      env: { CC_DIRECTORY_INDEX: indexPath },
      now: () => AT,
      platform: HOST,
    });

  it("finds a package update through a real directory index file, mapping the entry's riskTier to the notice's lane", async () => {
    const packageId = "com.example.native-tool";
    const report = checkOnce(listedUpdate(packageId));

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

  it("finds an update in a listing with a field this node does not read, and the notice names it", async () => {
    const packageId = "com.example.native-tool";
    const indexPath = listedUpdate(packageId, { futureBinding: { gpu: "required" } });
    const report = checkOnce(indexPath);
    expect(report.packageUpdates).toBe(1);

    const previous = process.env["CC_DIRECTORY_INDEX"];
    process.env["CC_DIRECTORY_INDEX"] = indexPath;
    try {
      const notice = readInbox(services, AT).notices.find((n) => n.sourceKind === "package");
      expect(notice?.title).toContain(packageId);
      // Said on the notice, so the change it shows does not pass for all the listing says.
      expect(notice?.unreadFields).toEqual({ count: 1, names: ["futureBinding"] });
    } finally {
      if (previous === undefined) delete process.env["CC_DIRECTORY_INDEX"];
      else process.env["CC_DIRECTORY_INDEX"] = previous;
    }
  });
});
describe("startUpdateCheckTimer", () => {
  /** A pass reads the clock exactly once to retire the old Pi notices, so counting the clock counts passes. */
  const startCounted = () => {
    const now = vi.fn(() => AT);
    const handle = startUpdateCheckTimer({
      services,
      installDeps: {
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        now: () => AT,
        newId: services.conductor.newId,
      },
      env: {},
      now,
      intervalMs: 60_000,
      platform: HOST,
    });
    return { now, handle };
  };

  it("runs once shortly after start, then once every interval", async () => {
    vi.useFakeTimers();
    try {
      const { now, handle } = startCounted();
      await vi.advanceTimersByTimeAsync(0);
      expect(now).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(now).toHaveBeenCalledTimes(3);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() clears the start and interval timers so no further pass starts", async () => {
    vi.useFakeTimers();
    try {
      const { now, handle } = startCounted();
      await vi.advanceTimersByTimeAsync(0);
      expect(now).toHaveBeenCalledTimes(1);

      handle.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      // Stopped before the interval fired again: no second pass.
      expect(now).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
