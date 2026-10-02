import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RESOURCE_PROFILES, packageManifestSchema } from "../../../../packages/contracts/src/index.ts";
import { runConformance } from "../../../../packages/widget-cli/src/conformance.ts";

/**
 * The media render tool as a package: it passes the conformance suite `clark widget test` runs, asks for a profile by
 * name and never for numbers, and names the one argument that carries a file.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8")) as Record<string, unknown>;
}

describe("the media render package", () => {
  it("passes the conformance suite", () => {
    const result = runConformance(ROOT);
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is a widget and a service with one job capability that reads one file, and no network or permissions", () => {
    const manifest = packageManifestSchema.parse(json("clarkcant.json"));
    expect(manifest.facets.map((facet) => facet.kind)).toEqual(["ui", "tools"]);
    const tools = manifest.facets.find((facet) => facet.kind === "tools");
    expect(tools).toMatchObject({ isolation: "service", protocol: "mcp-stdio", entry: "service/server.mjs" });
    expect(tools?.kind === "tools" ? tools.capabilities : []).toEqual([
      expect.objectContaining({
        tool: "render_audio",
        ref: "com.clarkcant.reference.media-render.render@1",
        effectCategory: "read",
        execution: { kind: "job", version: 1 },
        inputArtifacts: { version: 1, fields: ["source"] },
      }),
    ]);
    expect(manifest.requestedCapabilities).toEqual([]);
    expect(manifest.permissions).toEqual({ networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] });
  });

  it("asks for a profile by name, and the profile it asks for bounds the input", () => {
    const manifest = json("clarkcant.json");
    expect(manifest.resources).toEqual({ version: 1, profile: "background-compute" });
    const profile = RESOURCE_PROFILES["background-compute"];
    expect(profile.input.maxBytes).toBeGreaterThan(256 * 1024);
    expect(profile.input.maxMediaSeconds).toBe(3600);
  });

  it("refuses a manifest that tries to raise its own input limits", () => {
    const manifest = json("clarkcant.json");
    const facets = (manifest.facets as Record<string, unknown>[]).map((facet) =>
      facet.kind === "tools"
        ? {
            ...facet,
            capabilities: (facet.capabilities as Record<string, unknown>[]).map((capability) => ({
              ...capability,
              inputArtifacts: { version: 1, fields: ["source"], maxBytes: 1_000_000_000 },
            })),
          }
        : facet,
    );
    expect(packageManifestSchema.safeParse({ ...manifest, facets }).success).toBe(false);
    expect(packageManifestSchema.safeParse({ ...manifest, resources: { version: 1, profile: "background-compute", memoryMib: 8192 } }).success).toBe(false);
  });

  it("keeps state that holds file refs, a job and parameters, and nothing else", () => {
    const definition = json("widgets/main/widget.json");
    const state = definition.stateSchema as { properties: Record<string, unknown>; additionalProperties: unknown };
    expect(Object.keys(state.properties).sort()).toEqual(["gainDb", "job", "output", "source", "trimEndMs", "trimStartMs"]);
    expect(state.additionalProperties).toBe(false);
  });
});
