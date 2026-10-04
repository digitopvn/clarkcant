import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { browserRuntime, packageAssets, referenceAppDirectory } from "../src/package-assets.ts";

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
  writeFileSync(join(root, "runtime", "dev-frame-runtime.js"), "");
  return { root, url: pathToFileURL(`${root}/`) };
}

describe("package assets in this repository", () => {
  it("copies templates from the checkout's reference apps", () => {
    const directory = referenceAppDirectory("text-editor");
    expect(existsSync(join(directory, "clarkcant.json"))).toBe(true);
    expect(directory.replaceAll("\\", "/")).toMatch(/examples\/reference-apps\/text-editor\/$/);
  });

  it("serves the browser modules from source, through Vite's dependency optimiser", () => {
    expect(browserRuntime("dev-frame-runtime")).toEqual({ url: "/src/dev-frame-runtime.ts", prebundled: false });
    expect(browserRuntime("catalog-runtime")).toEqual({ url: "/src/catalog-runtime.tsx", prebundled: false });
    expect(browserRuntime("theme-dev-runtime")).toEqual({ url: "/src/theme-dev-runtime.tsx", prebundled: false });
  });
});

describe("package assets in an installed package", () => {
  it("prefers the templates and bundles shipped beside the code", () => {
    const { root, url } = installedPackage();
    const assets = packageAssets(url);
    expect(assets.referenceAppDirectory("text-editor")).toBe(`${join(root, "templates", "text-editor")}${sep}`);
    expect(assets.browserRuntime("dev-frame-runtime")).toEqual({ url: "/runtime/dev-frame-runtime.js", prebundled: true });
  });

  it("falls back to the source location for an asset the package does not ship", () => {
    const { url } = installedPackage();
    expect(packageAssets(url).browserRuntime("catalog-runtime")).toEqual({ url: "/src/catalog-runtime.tsx", prebundled: false });
  });
});
