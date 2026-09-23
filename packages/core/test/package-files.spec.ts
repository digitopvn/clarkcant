import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPackageFile } from "../src/package-files.ts";

/**
 * Regression coverage for the symlink containment escape reported in issue #93: a package root
 * checked with `resolve()`/`startsWith()` admits a symlink placed inside the root whose target
 * resolves outside it, because that check is lexical and `readFileSync` follows the link. These
 * tests reproduce the escape against the real module and then prove it is refused, alongside the
 * ordinary paths that must keep working.
 */
describe("readPackageFile", () => {
  let packageRoot: string;
  let outside: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "cc-package-files-"));
    packageRoot = join(base, "package");
    outside = join(base, "outside");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  afterEach(() => {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const entry = () => ({ source: { kind: "local" as const, path: packageRoot } });

  it("serves a normal file inside the package", () => {
    writeFileSync(join(packageRoot, "widget.js"), "export default 1;");
    const result = readPackageFile({ entry: entry(), relativePath: "widget.js" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.toString("utf8")).toBe("export default 1;");
      expect(result.contentType).toContain("javascript");
    }
  });

  it("refuses a lexical traversal", () => {
    writeFileSync(join(outside, "secret.txt"), "outside bytes");
    const result = readPackageFile({ entry: entry(), relativePath: "../outside/secret.txt" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FILE_OUTSIDE_PACKAGE");
  });

  it("refuses a symlink placed inside the package that resolves outside it", () => {
    writeFileSync(join(outside, "secret.txt"), "outside bytes");
    symlinkSync(join(outside, "secret.txt"), join(packageRoot, "leak.txt"));

    const result = readPackageFile({ entry: entry(), relativePath: "leak.txt" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FILE_OUTSIDE_PACKAGE");
    }
  });

  it("allows a symlink that resolves inside the package", () => {
    writeFileSync(join(packageRoot, "real.js"), "export default 2;");
    symlinkSync(join(packageRoot, "real.js"), join(packageRoot, "alias.js"));

    const result = readPackageFile({ entry: entry(), relativePath: "alias.js" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.toString("utf8")).toBe("export default 2;");
  });

  it("reports a missing file as not found", () => {
    const result = readPackageFile({ entry: entry(), relativePath: "missing.js" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FILE_NOT_FOUND");
  });

  it("refuses a non-local source", () => {
    const result = readPackageFile({
      entry: { source: { kind: "git", url: "https://example.com/repo.git" } as never },
      relativePath: "widget.js",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_A_LOCAL_PACKAGE");
  });
});
