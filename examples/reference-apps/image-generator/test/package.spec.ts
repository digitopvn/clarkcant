import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runConformance } from "../../../../packages/widget-cli/src/conformance.ts";
import { IMAGE_SIZE, renderImage } from "../service/png.mjs";

/**
 * The image generator as a package: it passes the conformance suite `clark widget test` runs, and declares exactly
 * what it reaches — one provider origin, one key the host adds, one capability that runs as a job.
 *
 * Here, in the default test run, so a change to the app or to the suite that breaks the reference app fails the
 * repository's own checks rather than waiting for someone to run the CLI by hand.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8")) as Record<string, unknown>;
}

describe("the image generator package", () => {
  it("passes the conformance suite", () => {
    const result = runConformance(ROOT);
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is an isolated UI facet and a service whose one capability runs as a job", () => {
    const manifest = json("clarkcant.json");
    expect(manifest.schemaVersion).toBe(2);
    const [ui, tools] = manifest.facets as Record<string, unknown>[];
    expect(ui).toEqual({
      kind: "ui",
      id: "com.clarkcant.reference.image-generator.main@1",
      entry: "widgets/main/index.html",
      definition: "widgets/main/widget.json",
      isolation: "isolated-ui",
    });
    expect(tools).toMatchObject({ kind: "tools", isolation: "service", protocol: "mcp-stdio", entry: "service/server.mjs" });
    expect(tools?.capabilities).toEqual([
      {
        tool: "generate_image",
        ref: "com.clarkcant.reference.image-generator.image.generate@1",
        summary: "Generate an image from a prompt, as a job the widget can follow and stop",
        effectCategory: "external-write",
        execution: { kind: "job", version: 1 },
      },
    ]);
    // Asking a provider to draw is a write to someone else's service, and the widget that presses it says so too.
    expect(json("widgets/main/widget.json").effectCategories).toEqual(["read", "external-write"]);
    expect(manifest.requestedCapabilities).toEqual([]);
    expect(manifest.permissions).toEqual({ networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] });
  });

  it("reaches one provider origin, with a key the host adds as a bearer header and the service never holds", () => {
    const tools = (json("clarkcant.json").facets as Record<string, unknown>[])[1];
    expect(tools?.egress).toEqual({
      version: 1,
      secrets: [{ name: "IMAGE_PROVIDER_KEY", purpose: "Signs the image requests in with the provider." }],
      origins: [
        {
          origin: "http://127.0.0.1:8881",
          purpose: "Draws the images you describe.",
          credential: { secret: "IMAGE_PROVIDER_KEY", header: "authorization", scheme: "bearer" },
        },
      ],
    });
    // Nothing in the service reads an environment variable: a key could only reach it that way, and none is given.
    expect(readFileSync(new URL("../service/server.mjs", import.meta.url), "utf8")).not.toMatch(/process\.env/);
  });

  it("keeps only the draft prompt in widget state: images are artifacts, jobs are read from the host", () => {
    const definition = json("widgets/main/widget.json");
    expect(definition.stateSchema).toEqual({
      type: "object",
      properties: { prompt: { type: "string", maxLength: 500 } },
      additionalProperties: false,
    });
    expect(definition.requestedCapabilities).toEqual([]);
  });
});

describe("the picture the provider and the local service draw", () => {
  it("is a deterministic PNG of the declared size, different for a different prompt", () => {
    const first = renderImage("a red kite");
    expect(first.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(first.readUInt32BE(16)).toBe(IMAGE_SIZE);
    expect(first.readUInt32BE(20)).toBe(IMAGE_SIZE);
    expect(renderImage("a red kite").equals(first)).toBe(true);
    expect(renderImage("a blue kite").equals(first)).toBe(false);
  });
});
