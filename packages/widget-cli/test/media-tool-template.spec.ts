import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { packageManifestSchema } from "@clarkcant/contracts";

import { runCli } from "../src/cli.ts";
import { runConformance } from "../src/conformance.ts";

/**
 * `clark widget init --template media-tool` starts a person from the reference media render tool: a widget and a
 * service whose one capability runs as a job reading a picked file through the host. These tests prove the copy is a
 * package of its own (every id renamed), carries the working app, and passes conformance before anything is edited.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function quietly(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  try {
    return { code: await runCli(args), out: out.join(""), err: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

function scaffold(): string {
  const parent = mkdtempSync(join(tmpdir(), "clark-media-tool-"));
  roots.push(parent);
  return join(parent, "my-render");
}

describe("the media-tool template", () => {
  it("copies the reference tool under the new package's own identity, service and capability included", async () => {
    const root = scaffold();
    const { code, out } = await quietly(["widget", "init", root, "--template", "media-tool"]);

    expect(code).toBe(0);
    expect(out).toContain("created a media-tool widget package");
    const manifest = packageManifestSchema.parse(JSON.parse(readFileSync(join(root, "clarkcant.json"), "utf8")));
    expect(manifest).toMatchObject({ id: "com.example.my-render", version: "0.1.0", displayName: "My Media Tool" });
    expect(manifest.facets.map((facet) => facet.id)).toEqual(["com.example.my-render.main@1", "com.example.my-render.service"]);
    const tools = manifest.facets.find((facet) => facet.kind === "tools");
    expect(tools?.kind === "tools" ? tools.capabilities.map((capability) => capability.ref) : []).toEqual(["com.example.my-render.render@1"]);
    expect(manifest.resources).toEqual({ version: 1, profile: "background-compute" });
    for (const file of ["clarkcant.json", "widgets/main/widget.json", "fixtures/dev-host-services.json", "service/server.mjs"]) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toContain("com.clarkcant.reference");
    }
  });

  it("carries the working widget and service, and leaves the reference app's own tests behind", async () => {
    const root = scaffold();
    await quietly(["widget", "init", root, "--template", "media-tool"]);

    for (const file of ["widgets/main/main.js", "widgets/main/render-core.js", "service/server.mjs", "service/wav.mjs"]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
    const frame = readFileSync(join(root, "widgets", "main", "main.js"), "utf8");
    expect(frame).toContain("api.jobs.subscribe");
    expect(frame).toContain("api.jobs.cancel");
    const service = readFileSync(join(root, "service", "server.mjs"), "utf8");
    expect(service).toContain("clarkcant/artifacts.read");
    // A test knob is not part of what a person starts from: a slow render for a journey is the fixture node's doing.
    expect(service).not.toContain("paceMs");
    expect(existsSync(join(root, "test", "service.spec.ts"))).toBe(false);
    expect(existsSync(join(root, "README.vi.md"))).toBe(false);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("# My Media Tool");
  });

  it("passes the conformance suite as it is scaffolded", async () => {
    const root = scaffold();
    await quietly(["widget", "init", root, "--template", "media-tool"]);

    const result = runConformance(root);
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names the template among those it accepts when given one it does not", async () => {
    const root = scaffold();
    const { code, err } = await quietly(["widget", "init", root, "--template", "media"]);

    expect(code).toBe(2);
    expect(err).toContain("media-tool");
    expect(existsSync(join(root, "clarkcant.json"))).toBe(false);
  });
});
