import { describe, expect, it } from "vitest";

import {
  PACKAGE_INSTRUCTIONS_PREFERENCE,
  PACKAGE_MANIFEST_SCHEMA_VERSION,
  PREFERENCE_REGISTRY,
  isPersonOnlyRoute,
  manifestProblems,
  packageInstructionsPreferenceSchema,
  packageManifestSchema,
  packageManifestSchemaVersionFor,
  withPackageInstructions,
} from "../src/index.ts";

/**
 * The `instructions` package facet and the preference that says where a package's instructions apply.
 *
 * The facet is declarative content and needs schema version 3, so a host that reads only version 2 refuses the package
 * as a whole rather than misreading it, while a package without the facet keeps version 2. The preference is the
 * person's: project and package pairs, written only on a person-only route.
 */

const manifest = (schemaVersion: number, facets: unknown[]): unknown => ({
  schemaVersion,
  id: "com.example.rules",
  version: "1.0.0",
  displayName: "Rules",
  description: "Rules a package declares.",
  hostApi: { min: 1, max: 1 },
  facets,
  requestedCapabilities: [],
  permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
  platforms: ["web"],
});

const facet = { kind: "instructions", id: "rules", entry: "rules/instructions.json", isolation: "declarative" };

describe("the instructions facet", () => {
  it("is declarative content, and anything else is refused", () => {
    expect(packageManifestSchema.safeParse(manifest(3, [facet])).success).toBe(true);
    expect(packageManifestSchema.safeParse(manifest(3, [{ ...facet, isolation: "isolated-ui" }])).success).toBe(false);
    expect(packageManifestSchema.safeParse(manifest(3, [{ ...facet, extra: true }])).success).toBe(false);
  });

  it("is declared at most once per package", () => {
    const two = packageManifestSchema.parse(manifest(3, [facet, { ...facet, id: "more", entry: "more/instructions.json" }]));
    expect(manifestProblems(two)).toEqual([expect.stringContaining("at most one instructions facet")]);
  });

  it("needs schemaVersion 3, while every other package keeps version 2", () => {
    expect(PACKAGE_MANIFEST_SCHEMA_VERSION).toBe(3);
    const old = packageManifestSchema.parse(manifest(2, [facet]));
    expect(manifestProblems(old)).toEqual([expect.stringContaining('an instructions facet needs "schemaVersion": 3')]);
    expect(manifestProblems(packageManifestSchema.parse(manifest(3, [facet])))).toEqual([]);
    expect(packageManifestSchema.safeParse(manifest(4, [facet])).success).toBe(false);
    expect(packageManifestSchemaVersionFor([{ kind: "ui" }, { kind: "themes" }])).toBe(2);
    expect(packageManifestSchemaVersionFor([{ kind: "ui" }, { kind: "instructions" }])).toBe(3);
  });
});

describe("where a package's instructions apply", () => {
  const project = process.platform === "win32" ? "C:\\work\\app" : "/work/app";

  it("is a node preference of absolute project and package pairs, each once", () => {
    const definition = PREFERENCE_REGISTRY[PACKAGE_INSTRUCTIONS_PREFERENCE];
    expect(definition).toMatchObject({ scope: "node", default: [] });
    expect(packageInstructionsPreferenceSchema.safeParse([{ project, packageId: "com.example.rules" }]).success).toBe(true);
    expect(packageInstructionsPreferenceSchema.safeParse([{ project: "relative/app", packageId: "p" }]).success).toBe(false);
    expect(packageInstructionsPreferenceSchema.safeParse([{ project, packageId: "" }]).success).toBe(false);
    expect(
      packageInstructionsPreferenceSchema.safeParse([
        { project, packageId: "p" },
        { project, packageId: "p" },
      ]).success,
    ).toBe(false);
  });

  it("adds or removes one pair and keeps the order of the rest", () => {
    const one = withPackageInstructions([], { project, packageId: "a", enabled: true });
    const two = withPackageInstructions(one, { project, packageId: "b", enabled: true });
    expect(withPackageInstructions(two, { project, packageId: "a", enabled: true })).toEqual([
      { project, packageId: "b" },
      { project, packageId: "a" },
    ]);
    expect(withPackageInstructions(two, { project, packageId: "a", enabled: false })).toEqual([{ project, packageId: "b" }]);
  });

  it("is written and undone only on a person-only route", () => {
    expect(isPersonOnlyRoute("PUT", `/preferences/${PACKAGE_INSTRUCTIONS_PREFERENCE}`)).toBe(true);
    expect(isPersonOnlyRoute("POST", `/preferences/${PACKAGE_INSTRUCTIONS_PREFERENCE}/undo`)).toBe(true);
    expect(isPersonOnlyRoute("GET", "/preferences")).toBe(false);
  });
});
