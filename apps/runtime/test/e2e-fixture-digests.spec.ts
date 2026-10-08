import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkThemeDocument, declaredReachOf, type DeclaredReach, type ThemeDocument } from "@clarkcant/contracts";
import { digestOfDirectory, readPackage } from "@clarkcant/core";
import { themeDrawProblem } from "@clarkcant/design-tokens";

/**
 * The browser suite's package directory lists the theme packages by the digest of their files, as a published directory
 * would. The theme picker shows that digest, so a placeholder there would show a value no real package can have, and a
 * fixture edited without its digest would show one that is not the fixture's.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const THEME_PACKAGES = [
  "examples/themes/pixel-arcade",
  "examples/themes/neo-brutalism",
  "apps/web/e2e/fixtures/theme-dusk",
  "apps/web/e2e/fixtures/theme-dusk-dim",
  "apps/web/e2e/fixtures/theme-depth",
  "apps/web/e2e/fixtures/theme-hostile",
  "apps/web/e2e/fixtures/theme-local",
];

interface FixtureEntry {
  packageId: string;
  version: string;
  source: { kind: string; path?: string };
  digest: string;
  declaredReach?: DeclaredReach;
}

describe("the browser suite's theme packages", () => {
  const entries = JSON.parse(readFileSync(join(ROOT, "apps/web/e2e/fixtures/directory.json"), "utf8")) as FixtureEntry[];

  it.each(THEME_PACKAGES)("lists %s under the digest of its bytes", (path) => {
    const entry = entries.find((candidate) => candidate.source.kind === "local" && candidate.source.path === path);
    expect(entry?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOfDirectory(join(ROOT, path))).toEqual({ ok: true, digest: entry?.digest });
  });

  /*
   * The appearance suite relies on what each fixture theme is, so that is pinned here where a failure names the file:
   * Depth and Flatline are drawn, and Camouflage is refused for hiding status, not for being unreadable.
   */
  const theme = (path: string): ThemeDocument => {
    const checked = checkThemeDocument(JSON.parse(readFileSync(join(ROOT, "apps/web/e2e/fixtures", path), "utf8")));
    if (!checked.ok) throw new Error(`${path}: ${checked.problems.join("; ")}`);
    return checked.document;
  };

  it("has a depth theme, a flat one and a lookalike one that are drawn, and a camouflaged one and a blacked-out Orb the protected audit refuses", () => {
    expect(themeDrawProblem(theme("theme-depth/themes/depth.json"))).toBeUndefined();
    expect(themeDrawProblem(theme("theme-hostile/themes/flatline.json"))).toBeUndefined();
    expect(themeDrawProblem(theme("theme-hostile/themes/lookalike.json"))).toBeUndefined();
    expect(themeDrawProblem(theme("theme-hostile/themes/camouflage.json"))?.code).toBe("THEME_PROTECTED");
    const blackout = themeDrawProblem(theme("theme-hostile/themes/blackout.json"));
    expect(blackout?.code).toBe("THEME_PROTECTED");
    if (blackout?.code === "THEME_PROTECTED") expect(blackout.protected.map((failure) => failure.check)).toEqual(["orb-visible"]);
  });
});

/*
 * The update journey installs one version of the forecast package from the fixture npm registry and is offered the next,
 * whose listing says it reaches one more origin. Each listing is the digest of the bytes the registry serves, and the
 * reach it shows is what that version's manifest declares, so the install of either would be accepted.
 */
describe("the browser suite's forecast package, in two versions", () => {
  const entries = JSON.parse(readFileSync(join(ROOT, "apps/web/e2e/fixtures/directory.json"), "utf8")) as FixtureEntry[];

  it.each(["1.0.0", "1.1.0"])("lists %s under the digest of its bytes, with the reach its manifest declares", (version) => {
    const entry = entries.find((candidate) => candidate.packageId === "com.acme.forecast" && candidate.version === version);
    const root = join(ROOT, "apps/web/e2e/fixtures/forecast-widget", version);
    expect(digestOfDirectory(root)).toEqual({ ok: true, digest: entry?.digest });
    const pkg = readPackage(root);
    expect(pkg.problems).toEqual([]);
    expect(entry?.declaredReach ?? { origins: [], secrets: [], browserTokens: [] }).toEqual(declaredReachOf(pkg.manifest));
  });
});

/*
 * The package-instructions journey installs a package that carries only an instructions facet, listed like the theme
 * packages by the digest of its bytes, and checked the way `clarkcant instructions check` checks a package.
 */
describe("the browser suite's instructions package", () => {
  const entries = JSON.parse(readFileSync(join(ROOT, "apps/web/e2e/fixtures/directory.json"), "utf8")) as FixtureEntry[];

  it("lists it under the digest of its bytes, as a readable v3 package", () => {
    const path = "apps/web/e2e/fixtures/instructions-package";
    const entry = entries.find((candidate) => candidate.source.kind === "local" && candidate.source.path === path);
    expect(digestOfDirectory(join(ROOT, path))).toEqual({ ok: true, digest: entry?.digest });
    expect(readPackage(join(ROOT, path)).problems).toEqual([]);
  });
});
