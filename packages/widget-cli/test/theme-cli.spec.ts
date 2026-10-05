import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.ts";
import { initTheme } from "../src/theme-cli.ts";
import { runThemeConformance } from "../src/theme-conformance.ts";
import { packageFiles } from "../src/package-files.ts";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "clark-theme-300-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function edit(path: string, change: (theme: Record<string, unknown>) => void): void {
  const file = join(path, "themes/main.json");
  const theme = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  change(theme);
  writeFileSync(file, JSON.stringify(theme));
}
function quiet(): void {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("theme authoring through the shared clark CLI", () => {
  it("initializes, audits and packs an immutable generalized theme artifact without an account", async () => {
    quiet();
    const path = root();
    expect(await runCli(["theme", "init", path])).toBe(0);
    expect(await runCli(["theme", "test", path])).toBe(0);
    const report = runThemeConformance(path);
    expect(report.summary.fail).toBe(0);
    expect(report.summary["requires-dev-host"]).toBe(1);
    expect(await runCli(["theme", "pack", path])).toBe(0);
    const file = join(path, "dist/artifact.json");
    const artifact = JSON.parse(readFileSync(file, "utf8"));
    const manifest = JSON.parse(readFileSync(join(path, "clarkcant.json"), "utf8"));
    expect(Object.keys(artifact.themeDigests)).toEqual([manifest.facets[0].id]);
    expect(artifact.authorDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(artifact).not.toHaveProperty("definitionDigest");
    expect(artifact.unverifiedChecks).toContain("theme-browser");
    expect(await runCli(["theme", "pack", path])).toBe(0);
    const before = readFileSync(file, "utf8");
    edit(path, (theme) => { theme.displayName = "Changed theme"; });
    expect(await runCli(["theme", "pack", path])).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("preserves existing author files and refuses missing directories and unknown commands", async () => {
    quiet();
    const path = root();
    writeFileSync(join(path, "keep.txt"), "keep");
    expect(await runCli(["theme", "init", path])).toBe(1);
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("keep");
    expect(await runCli(["theme", "init"])).toBe(1);
    expect(await runCli(["theme", "unknown"])).toBe(2);
    expect(await runCli(["theme", "test", path, "extra"])).toBe(1);
    expect(await runCli(["theme", "test", path, "--port", "4319"])).toBe(1);
    expect(await runCli(["theme", "dev", path, "--unknown"])).toBe(1);
    expect(await runCli(["theme", "dev", path, "--port"])).toBe(1);
  });
  it("audits arbitrary third-party contrast and protected status colors", () => {
    const path = root(); initTheme(path);
    edit(path, (theme) => { theme.colors = { dark: { text: "#000000", canvas: "#000000" } }; });
    const contrast = runThemeConformance(path);
    expect(contrast.checks.some((check) => check.id.endsWith(":contrast") && check.status === "fail")).toBe(true);
    edit(path, (theme) => { theme.colors = { light: { danger: "#007700", success: "#007700" } }; });
    expect(runThemeConformance(path).checks.some((check) => check.id.endsWith(":protected") && check.status === "fail")).toBe(true);
  });
  it.each([
    { css: "@import url(https://external.test/theme.css)" },
    { script: "execute()" },
    { typography: { font: "https://external.test/font.woff2" } },
    { typography: { scale: 100 } },
  ])("refuses undeclared styling, executable payload and unbounded typography: %j", (patch) => {
    const path = root(); initTheme(path);
    edit(path, (theme) => Object.assign(theme, patch));
    expect(runThemeConformance(path).ok).toBe(false);
  });
  it("cannot make reduced-motion durations nonzero with a theme's speed multiplier", () => {
    const path = root(); initTheme(path);
    edit(path, (theme) => { theme.motion = { speed: 2, easing: "stepped" }; });
    const report = runThemeConformance(path);
    expect(report.ok).toBe(true);
    expect(report.checks.filter((check) => check.id.endsWith(":reduced")).map((check) => check.status)).toEqual(["pass", "pass"]);
  });
  it("refuses a symlink asset instead of hashing bytes outside the package", () => {
    const path = root(); initTheme(path);
    const outside = root(); writeFileSync(join(outside, "private.txt"), "outside bytes");
    symlinkSync(outside, join(path, "assets"), "junction");
    expect(() => packageFiles(path)).toThrow(/symlink/);
    expect(runThemeConformance(path).checks.find((check) => check.id === "theme-assets")?.status).toBe("fail");
  });
  it("refuses undeclared executable assets in a data-only theme artifact", () => {
    const path = root(); initTheme(path);
    writeFileSync(join(path, "extra.js"), "console.log('not a theme')");
    expect(runThemeConformance(path).checks.find((check) => check.id === "theme-asset-execution")?.status).toBe("fail");
  });
  it("excludes repository metadata, dependencies and artifacts from author bytes", () => {
    const path = root(); initTheme(path);
    for (const directory of [".git", "node_modules", "dist"]) {
      mkdirSync(join(path, directory)); writeFileSync(join(path, directory, "ignored.txt"), "ignored");
    }
    expect(packageFiles(path).map((file) => file.path)).toEqual(["README.md", "clarkcant.json", "themes/main.json"]);
  });
});
