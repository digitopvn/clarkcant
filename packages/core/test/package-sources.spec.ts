import { platformForHost, type DirectoryEntry, type Platform } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { artifactMatchesPlan, resolvePackageSource, riskLaneFor } from "../src/package-sources.ts";

/**
 * Where a package comes from.
 *
 * Almost everything here asserts a refusal, and that is deliberate: every one of them is a way a marketplace
 * quietly stops being an install path and becomes a way to run something nobody reviewed. A branch name, a version
 * range, a directory entry with no digest, a package built for another host API — each of them, if accepted,
 * produces a plan the user approved and an artifact that is not the same thing.
 */

const ENTRY: DirectoryEntry = {
  packageId: "com.example.calendar",
  version: "1.2.0",
  displayName: "Calendar Plus",
  description: "A compact agenda and week view.",
  source: { kind: "local", path: "/tmp/pkg" },
  publisher: { id: "example", sourceUrl: "https://github.com/example/calendar-plus", license: "MIT" },
  preview: {},
  facets: ["ui"],
  isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
  platforms: ["darwin-arm64", "linux-x64"],
  hostApi: { min: 1, max: 2 },
  permissionsSummary: ["network: api.example.test"],
  riskTier: "isolated-ui",
  sizeBytes: 40_960,
  digest: "sha256:published-digest",
};

const HOST: { hostApi: number; platform: Platform } = { hostApi: 1, platform: "linux-x64" };

/** A host that can run a Windows package, and one that cannot. The pair is the interesting case. */
const HOST_WINDOWS: { hostApi: number; platform: Platform } = { hostApi: 1, platform: "win32-x64" };

/*
 * The fixture above originally said `win32-x64` and every case here failed with "the directory entry does not match
 * the schema" — a real gap rather than a typo, since this repository's own desktop app is Electron on Windows and a
 * package could not declare the platform it runs on. It was left as a finding, because widening the platform
 * vocabulary is a decision about the marketplace's contract rather than something a test fixture should settle.
 *
 * That decision has been taken, so what was a comment is now a test: the same package is offered to a host that can
 * run it and refused by one that cannot.
 */

describe("what the resolver refuses", () => {
  it("refuses a git branch, because it names whatever it points at today", () => {
    const result = resolvePackageSource({
      source: { kind: "git", url: "https://github.com/example/calendar-plus", ref: "main" },
      directory: [ENTRY],
      ...HOST,
    });

    /*
     * The plan the user approved and the artifact that arrives would be two different things sharing a name. The
     * refusal names the ref, so an author knows what to pin instead of only that it failed.
     */
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("GIT_REF_NOT_EXACT");
      expect(result.message).toContain("main");
    }
  });

  it("accepts a commit id and a version tag", () => {
    for (const ref of ["9f2c4a1b7e5d3c8f1a2b3c4d5e6f7a8b9c0d1e2f", "v1.2.0"]) {
      const result = resolvePackageSource({
        source: { kind: "git", url: "com.example.calendar", ref },
        directory: [ENTRY],
        ...HOST,
      });
      expect(result.ok, `${ref} should resolve`).toBe(true);
    }
  });

  it("refuses an npm range, because a range is not one artifact", () => {
    const result = resolvePackageSource({
      source: { kind: "npm", name: "com.example.calendar", version: "^1.2.0" },
      directory: [ENTRY],
      ...HOST,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NPM_VERSION_NOT_EXACT");
  });

  it("refuses an exact npm version the directory does not have", () => {
    const result = resolvePackageSource({
      source: { kind: "npm", name: "com.example.calendar", version: "9.9.9" },
      directory: [ENTRY],
      ...HOST,
    });

    // Named with both versions, because "not found" for an exact version is usually a stale listing.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("1.2.0");
  });

  it("refuses a package that needs another host API", () => {
    const result = resolvePackageSource({
      source: { kind: "npm", name: "com.example.calendar", version: "1.2.0" },
      directory: [{ ...ENTRY, hostApi: { min: 5, max: 6 } }],
      ...HOST,
    });

    // Refused before download, so a listing that cannot run here is never offered as one that can.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HOST_API_MISMATCH");
  });

  it("refuses a package that does not list this platform", () => {
    const result = resolvePackageSource({
      source: { kind: "npm", name: "com.example.calendar", version: "1.2.0" },
      directory: [{ ...ENTRY, platforms: ["darwin-arm64"] }],
      ...HOST,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PLATFORM_MISMATCH");
  });

  it("refuses a directory entry that publishes no digest", () => {
    const result = resolvePackageSource({
      source: { kind: "npm", name: "com.example.calendar", version: "1.2.0" },
      directory: [{ ...ENTRY, digest: "   " }],
      ...HOST,
    });

    /*
     * "No digest" must never behave like "digest matched". A listing without one has nothing to check the artifact
     * against, and the consent step would be approving bytes nobody described.
     */
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DIGEST_MISMATCH");
  });

  it("refuses a local package that has not been hashed", () => {
    const result = resolvePackageSource({ source: { kind: "local", path: "/tmp/widget" }, ...HOST });

    // The plan has to name the bytes it approved, and for a local path the digest is the identity.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("LOCAL_DIGEST_REQUIRED");
  });

  it("refuses a source the directory does not know", () => {
    const result = resolvePackageSource({
      source: { kind: "npm", name: "com.example.unknown", version: "1.0.0" },
      directory: [ENTRY],
      ...HOST,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_IN_DIRECTORY");
  });
});

describe("what a resolved source carries", () => {
  it("carries the published digest and the rationale, so consent names what it approved", () => {
    const result = resolvePackageSource({
      source: { kind: "npm", name: "com.example.calendar", version: "1.2.0" },
      directory: [ENTRY],
      ...HOST,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.digest).toBe("sha256:published-digest");
      expect(result.resolved.version).toBe("1.2.0");
      expect(result.resolved.rationale).toContain("npm com.example.calendar@1.2.0");
      expect(result.resolved.artifactUrl).toBe("npm:com.example.calendar@1.2.0");
    }
  });

  it("carries the lane the directory declared", () => {
    const result = resolvePackageSource({
      source: { kind: "npm", name: "com.example.calendar", version: "1.2.0" },
      directory: [{ ...ENTRY, riskTier: "trusted-native" }],
      ...HOST,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.lane).toBe("trusted-native");
  });
});

describe("the risk lane", () => {
  it("takes the strongest facet rather than the first", () => {
    /*
     * A package is as trusted as its least isolated part. A declarative widget that ships a native tool alongside
     * it is a native package, and labelling it "declarative" would make the tier meaningless.
     */
    expect(riskLaneFor(["declarative", "trusted-native"])).toBe("trusted-native");
    expect(riskLaneFor(["isolated-ui", "service"])).toBe("service");
    expect(riskLaneFor(["declarative", "isolated-ui"])).toBe("isolated-ui");
    expect(riskLaneFor(["declarative"])).toBe("declarative");
  });
});

describe("matching an artifact to its plan", () => {
  it("accepts only the exact digest", () => {
    expect(artifactMatchesPlan("sha256:a", "sha256:a")).toBe(true);
    expect(artifactMatchesPlan("sha256:b", "sha256:a")).toBe(false);
  });

  it("does not treat an empty planned digest as a match", () => {
    // The case that would otherwise install anything: no digest on the plan and no digest on the artifact.
    expect(artifactMatchesPlan("", "")).toBe(false);
    expect(artifactMatchesPlan("sha256:a", "  ")).toBe(false);
  });
});

describe("the platform vocabulary", () => {
  it("names the host it is running on instead of leaving it unnamed", () => {
    /*
     * Node says `win32` and `x64`; a package says `win32-x64`. Without the mapping the two strings never meet, and
     * the failure looks like "no package fits this host" rather than like a missing translation — which is exactly
     * how the absent Windows value stayed quiet for so long.
     */
    expect(platformForHost("win32", "x64")).toBe("win32-x64");
    expect(platformForHost("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformForHost("linux", "arm64")).toBe("linux-arm64");
  });

  it("says nothing for a host it cannot describe, rather than guessing", () => {
    // Guessing `web` would offer a native package to something that cannot run it.
    expect(platformForHost("freebsd", "x64")).toBeUndefined();
    expect(platformForHost("win32", "ia32")).toBeUndefined();
  });

  it("offers a Windows package to a Windows host, and refuses it on Linux", () => {
    const windowsPackage = { ...ENTRY, platforms: ["win32-x64" as const] };
    const source = { kind: "npm" as const, name: "com.example.calendar", version: "1.2.0" };

    expect(resolvePackageSource({ source, directory: [windowsPackage], ...HOST_WINDOWS }).ok).toBe(true);

    const refused = resolvePackageSource({ source, directory: [windowsPackage], ...HOST });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("PLATFORM_MISMATCH");
      // The reason names the platform, so "nothing found" and "built for another machine" are distinguishable.
      expect(refused.message).toContain("win32-x64");
    }
  });
});
