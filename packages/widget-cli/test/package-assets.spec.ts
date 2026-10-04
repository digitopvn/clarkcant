import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  REFERENCE_APPS,
  browserRuntime,
  packageAssets,
  packageVersion,
  prebundledRuntime,
  referenceAppDirectory,
  skippedFromReference,
} from "../src/package-assets.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory laid out as an installed package: `lib/` beside `templates/` and `runtime/`. */
function installedPackage(): { root: string; url: URL } {
  const root = mkdtempSync(join(tmpdir(), "clark-assets-"));
  scratch.push(root);
  mkdirSync(join(root, "templates", "text-editor"), { recursive: true });
  writeFileSync(join(root, "templates", "text-editor", "clarkcant.json"), "{}");
  mkdirSync(join(root, "runtime"), { recursive: true });
  writeFileSync(join(root, "runtime", "dev-frame-runtime.js"), "export const bundled = true;\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@clarkcant/widget-cli", version: "1.2.3" }));
  return { root, url: pathToFileURL(`${root}/`) };
}

describe("package assets in this repository", () => {
  it("copies templates from the checkout's reference apps", () => {
    const directory = referenceAppDirectory("text-editor");
    expect(existsSync(join(directory, "clarkcant.json"))).toBe(true);
    expect(directory.replaceAll("\\", "/")).toMatch(/examples\/reference-apps\/text-editor\/$/);
  });

  it("has every reference app a template copies", () => {
    for (const app of REFERENCE_APPS) expect(existsSync(join(referenceAppDirectory(app), "clarkcant.json"))).toBe(true);
  });

  it("reads its version from the workspace package", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("has no prebundled runtime to serve from a checkout", () => {
    expect(prebundledRuntime("/runtime/dev-frame-runtime.js")).toBeUndefined();
  });

  it("serves the browser modules from source, through Vite's dependency optimiser", () => {
    expect(browserRuntime("dev-frame-runtime")).toEqual({ url: "/src/dev-frame-runtime.ts", prebundled: false });
    expect(browserRuntime("catalog-runtime")).toEqual({ url: "/src/catalog-runtime.tsx", prebundled: false });
    expect(browserRuntime("theme-dev-runtime")).toEqual({ url: "/src/theme-dev-runtime.tsx", prebundled: false });
  });
});

describe("skippedFromReference", () => {
  it("leaves out a reference app's tests, build output, readmes and licence, files and directories alike", () => {
    for (const path of ["test/a.spec.ts", "test/", "dist/", "README.md", "README.vi.md", "LICENSE"]) expect(skippedFromReference(path)).toBe(true);
    for (const path of ["clarkcant.json", "widgets/main/index.html", "dev/service.test.mjs", "testing/x"]) expect(skippedFromReference(path)).toBe(false);
  });
});

describe("package assets in an installed package", () => {
  it("prefers the templates and bundles shipped beside the code", () => {
    const { root, url } = installedPackage();
    const assets = packageAssets(url);
    expect(assets.referenceAppDirectory("text-editor")).toBe(`${join(root, "templates", "text-editor")}${sep}`);
    expect(assets.browserRuntime("dev-frame-runtime")).toEqual({ url: "/runtime/dev-frame-runtime.js", prebundled: true });
  });

  it("serves a shipped runtime bundle's bytes, and nothing for any other path", () => {
    const { url } = installedPackage();
    const assets = packageAssets(url);
    expect(assets.prebundledRuntime("/runtime/dev-frame-runtime.js")?.toString("utf8")).toBe("export const bundled = true;\n");
    expect(assets.prebundledRuntime("/runtime/catalog-runtime.js")).toBeUndefined();
    expect(assets.prebundledRuntime("/runtime/../package.json")).toBeUndefined();
    expect(assets.prebundledRuntime("/runtime/other.js")).toBeUndefined();
    expect(assets.prebundledRuntime("/src/dev-frame-runtime.ts")).toBeUndefined();
  });

  it("reads the installed package's version, and refuses a manifest without one", () => {
    const { root, url } = installedPackage();
    expect(packageAssets(url).version()).toBe("1.2.3");
    writeFileSync(join(root, "package.json"), "{}");
    expect(() => packageAssets(url).version()).toThrow(/names no version/);
  });

  it("falls back to the source location for an asset the package does not ship", () => {
    const { url } = installedPackage();
    expect(packageAssets(url).browserRuntime("catalog-runtime")).toEqual({ url: "/src/catalog-runtime.tsx", prebundled: false });
  });
});
