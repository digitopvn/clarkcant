import { describe, expect, it } from "vitest";

import {
  ARTIFACT_LIMITS,
  RESOURCE_PROFILES,
  RESOURCE_PROFILE_NAMES,
  decideResourceProfile,
  describeResourceProfile,
  packageManifestSchema,
  resourceRequestSchema,
} from "../src/index.ts";

const GIB = 1024 * 1024 * 1024;
const roomy = { memoryBytes: 64 * GIB, cpus: 16, enforcesLimits: true };

const manifest = (extra: Record<string, unknown>) => ({
  schemaVersion: 2,
  id: "com.example.render",
  version: "1.0.0",
  displayName: "Render",
  description: "Renders things",
  hostApi: { min: 1, max: 1 },
  facets: [{ kind: "ui", id: "com.example.render.view@1", entry: "w/index.html", definition: "w/widget.json", isolation: "isolated-ui" }],
  requestedCapabilities: [],
  permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
  platforms: ["web"],
  ...extra,
});

describe("resource profiles", () => {
  it("keeps interactive-light exactly at the envelope every service ran in before profiles", () => {
    expect(RESOURCE_PROFILES["interactive-light"]).toEqual({
      name: "interactive-light",
      container: { memoryMib: 256, cpus: 1, pids: 128, tmpfsMib: 16 },
      callDeadlineMs: 60_000,
      jobDeadlineMs: 30 * 60_000,
      maxActiveJobs: 4,
      artifactMaxBytes: ARTIFACT_LIMITS.maxBytes,
      input: { maxBytes: 8 * 1024 * 1024, maxMediaSeconds: 120 },
      background: "continue",
      offscreen: "suspend",
      network: "none",
    });
  });

  it("gives every profile no network, and an artifact ceiling and an input cap no larger than an attachable file", () => {
    for (const name of RESOURCE_PROFILE_NAMES) {
      const profile = RESOURCE_PROFILES[name];
      expect(profile.name).toBe(name);
      expect(profile.network).toBe("none");
      expect(profile.artifactMaxBytes).toBeLessThanOrEqual(ARTIFACT_LIMITS.maxBytes);
      expect(profile.input.maxBytes).toBeLessThanOrEqual(ARTIFACT_LIMITS.maxBytes);
      expect(profile.input.maxMediaSeconds).toBeGreaterThan(0);
      expect(Number.isInteger(profile.container.memoryMib)).toBe(true);
      expect(Number.isInteger(profile.container.tmpfsMib)).toBe(true);
    }
  });

  it("grants interactive-light to a package that asks for nothing, whatever the engine reports", () => {
    const grant = decideResourceProfile({ request: undefined, needsContainer: true, capacity: { memoryBytes: 1, cpus: 0.5 } });
    expect(grant).toMatchObject({ status: "granted", requested: "interactive-light" });
  });

  it("grants a larger profile the engine can hold", () => {
    const grant = decideResourceProfile({ request: { version: 1, profile: "media-workstation" }, needsContainer: true, capacity: roomy });
    expect(grant.status).toBe("granted");
    if (grant.status === "granted") expect(grant.profile).toBe(RESOURCE_PROFILES["media-workstation"]);
  });

  it("degrades with a reason, never a smaller profile, when the engine has too few CPUs or too little memory", () => {
    const cpus = decideResourceProfile({
      request: { version: 1, profile: "media-workstation" },
      needsContainer: true,
      capacity: { memoryBytes: 64 * GIB, cpus: 2 },
    });
    expect(cpus).toEqual({
      status: "degraded",
      requested: "media-workstation",
      reason: "media-workstation needs 4 CPUs, and the container engine here has 2",
    });
    const memory = decideResourceProfile({
      request: { version: 1, profile: "background-compute" },
      needsContainer: true,
      capacity: { memoryBytes: 3 * GIB, cpus: 8 },
    });
    expect(memory.status).toBe("degraded");
    if (memory.status === "degraded") expect(memory.reason).toContain("more than half of the 3.0 GiB");
  });

  it("refuses a GPU, which the node never passes through, even for the light profile", () => {
    const grant = decideResourceProfile({ request: { version: 1, profile: "interactive-light", gpu: true }, needsContainer: true, capacity: roomy });
    expect(grant).toMatchObject({ status: "degraded", reason: expect.stringContaining("does not pass a GPU through") });
  });

  it("lets the execution policy refuse a larger profile, and never the light one", () => {
    const refused = decideResourceProfile({
      request: { version: 1, profile: "interactive-heavy" },
      needsContainer: true,
      capacity: roomy,
      policyRefusal: "a rule refuses local-write effects on this machine",
    });
    expect(refused).toEqual({
      status: "degraded",
      requested: "interactive-heavy",
      reason: "interactive-heavy is not granted: a rule refuses local-write effects on this machine",
    });
    const light = decideResourceProfile({
      request: { version: 1, profile: "interactive-light" },
      needsContainer: true,
      capacity: roomy,
      policyRefusal: "a rule refuses local-write effects on this machine",
    });
    expect(light.status).toBe("granted");
  });

  it("checks no engine capacity for a package that runs nothing in a container", () => {
    const grant = decideResourceProfile({ request: { version: 1, profile: "media-workstation" }, needsContainer: false, capacity: undefined });
    expect(grant.status).toBe("granted");
  });

  it("says when the engine accepts limits it does not enforce, or did not report its capacity", () => {
    const unenforced = decideResourceProfile({ request: undefined, needsContainer: true, capacity: { ...roomy, enforcesLimits: false } });
    expect(unenforced.status === "granted" && unenforced.notes).toEqual([
      "the container engine does not enforce memory and CPU limits here, so the service runs without them",
    ]);
    const unknown = decideResourceProfile({ request: { version: 1, profile: "interactive-heavy" }, needsContainer: true, capacity: {} });
    expect(unknown.status === "granted" && unknown.notes[0]).toContain("did not report");
  });

  it("does not let a manifest grant itself a larger profile: it can name a profile, never a number", () => {
    expect(resourceRequestSchema.safeParse({ version: 1, profile: "interactive-heavy", memory: "64g" }).success).toBe(false);
    expect(resourceRequestSchema.safeParse({ version: 1, profile: "unlimited" }).success).toBe(false);
    expect(resourceRequestSchema.safeParse({ version: 2, profile: "interactive-heavy" }).success).toBe(false);
    expect(packageManifestSchema.safeParse(manifest({ resources: { version: 1, profile: "media-workstation", cpus: 64 } })).success).toBe(false);
    const parsed = packageManifestSchema.parse(manifest({ resources: { version: 1, profile: "media-workstation" } }));
    // What the manifest says is only the request: the decision is the host's, on the host's capacity.
    const grant = decideResourceProfile({ request: parsed.resources, needsContainer: true, capacity: { memoryBytes: 4 * GIB, cpus: 4 } });
    expect(grant.status).toBe("degraded");
  });

  it("describes a profile in units a person reads", () => {
    expect(describeResourceProfile(RESOURCE_PROFILES["interactive-light"])).toBe(
      "256 MiB memory, 1 CPU, 128 processes, 16 MiB scratch, 60 s per call, 30 min per job, 4 jobs at once, 8 MiB input, 2 min of media, no network",
    );
    expect(describeResourceProfile(RESOURCE_PROFILES["media-workstation"])).toContain("4 GiB memory, 4 CPUs");
  });
});
