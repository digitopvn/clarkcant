import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAppearance } from "@clarkcant/design-tokens";
import { installedThemes } from "@clarkcant/core";
import { runCli } from "../src/cli.ts";
import { packageFiles } from "../src/package-files.ts";
import { runThemeConformance } from "../src/theme-conformance.ts";

const temporaryRoots: string[] = [];
const referenceThemes = [
  { name: "pixel-arcade", borderWidth: 2, headingWeight: 700, cardRadius: "0rem" },
  { name: "neo-brutalism", borderWidth: 3, headingWeight: 800, cardRadius: "0.125rem" },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const { name, borderWidth, headingWeight, cardRadius } of referenceThemes) describe(`${name} reference package`, () => {
  const source = resolve("examples/themes", name);
  it("passes arbitrary package conformance with only licensed data and portable font profiles", () => {
    const report = runThemeConformance(source);
    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.summary["requires-dev-host"]).toBe(1);
    const manifest = JSON.parse(readFileSync(join(source, "clarkcant.json"), "utf8"));
    expect(manifest.facets.map((facet: { kind: string; isolation: string }) => [facet.kind, facet.isolation])).toEqual([["themes", "declarative"]]);
    expect(manifest.requestedCapabilities).toEqual([]);
    expect(manifest.permissions).toEqual({ networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] });
    expect(manifest.publisher.license).toBe("Apache-2.0");
    expect(readFileSync(join(source, "LICENSE"), "utf8")).toContain("Apache License");
    expect(packageFiles(source).map((file) => file.path)).toEqual(["LICENSE", "README.md", "clarkcant.json", `themes/${name}.json`]);
  });
  it.each(["dark", "light"] as const)("retains host-owned status, text scale and zero-motion behavior in %s", (scheme) => {
    const loaded = installedThemes({ source: { kind: "local", path: source } });
    if (!loaded.ok) throw new Error("The actual package failed to load");
    const theme = loaded.themes[0]!;
    const baseline = compileAppearance({ scheme });
    const drawn = compileAppearance({ scheme, theme: theme.document, themeRef: theme.themeRef });
    const reduced = compileAppearance({ scheme, theme: theme.document, themeRef: theme.themeRef, reducedMotion: true });
    expect(drawn.tokens.type).toEqual(baseline.tokens.type);
    expect(drawn.tokens.layout).toEqual(baseline.tokens.layout);
    for (const status of ["danger", "success", "warning"] as const) expect(drawn.tokens.color[status]).toBe(baseline.tokens.color[status]);
    expect(drawn.tokens.identity?.typography.body).toBe("system");
    expect(drawn.tokens.identity?.border.width).toBe(borderWidth);
    expect(drawn.tokens.identity?.typography.headingWeight).toBe(headingWeight);
    expect(drawn.tokens.radius.card).toBe(cardRadius);
    expect(reduced.tokens.motion).toEqual(baseline.tokens.motionReduced);
    expect(compileAppearance({ scheme })).toEqual(baseline);
  });
  it("packs real source bytes and refuses a changed theme at the same version", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const root = mkdtempSync(join(tmpdir(), "clark-reference-theme-"));
    temporaryRoots.push(root);
    for (const file of packageFiles(source)) {
      const target = join(root, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
    expect(await runCli(["theme", "pack", root])).toBe(0);
    const target = join(root, "dist/artifact.json");
    const original = readFileSync(target, "utf8");
    const artifact = JSON.parse(original);
    expect(artifact.themeDigests[name]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(artifact.unverifiedChecks).toEqual(["theme-browser"]);
    expect(await runCli(["theme", "pack", root])).toBe(0);
    const documentPath = join(root, `themes/${name}.json`);
    const document = JSON.parse(readFileSync(documentPath, "utf8"));
    document.displayName += " changed";
    writeFileSync(documentPath, JSON.stringify(document));
    expect(await runCli(["theme", "pack", root])).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(original);
  });
});
