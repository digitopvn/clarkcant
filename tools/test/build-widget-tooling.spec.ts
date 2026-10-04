import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildWidgetTooling,
  installedPackageOf,
  packageNameOf,
  resolveExternalDependencies,
  rewriteDeclarationSpecifiers,
  thirdPartyNotices,
} from "../build-widget-tooling.mjs";
import { touchesWidgetTooling } from "../ci-test-scope.mjs";
import { BROWSER_RUNTIME_SOURCES, REFERENCE_APPS } from "../../packages/widget-cli/src/package-assets.ts";

const importer = (name: string, dependencies: Record<string, string>) => ({ name, dependencies });

describe("packageNameOf", () => {
  it("names the package of a plain, a subpath and a scoped specifier", () => {
    expect(packageNameOf("zod")).toBe("zod");
    expect(packageNameOf("react-dom/client")).toBe("react-dom");
    expect(packageNameOf("@vitejs/plugin-react")).toBe("@vitejs/plugin-react");
    expect(packageNameOf("@scope/name/sub/path")).toBe("@scope/name");
  });
});

describe("installedPackageOf", () => {
  it("names the installed package a bundled input comes from, plain or scoped", () => {
    expect(installedPackageOf("node_modules/.pnpm/react@19.3.0/node_modules/react/cjs/react.production.js")).toEqual({
      name: "react",
      dir: "node_modules/.pnpm/react@19.3.0/node_modules/react",
    });
    expect(installedPackageOf("node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs")).toEqual({
      name: "@xterm/xterm",
      dir: "node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm",
    });
  });

  it("leaves out the workspace's own sources and esbuild's virtual modules", () => {
    expect(installedPackageOf("packages/widget-sdk/src/index.ts")).toBeUndefined();
    expect(installedPackageOf("(disabled):node_modules/x/y.js")).toBeUndefined();
    expect(installedPackageOf("node_modules/react")).toBeUndefined();
  });
});

describe("thirdPartyNotices", () => {
  it("lists each package with its licence and text, in a fence its text cannot close", () => {
    const text = thirdPartyNotices("@clarkcant/widget-cli", [
      { name: "zeta", version: "1.0.0", license: "MIT", text: "MIT text with ```code``` inside" },
      { name: "alpha", version: "2.0.0", license: "BSD-3-Clause", text: undefined },
    ]);
    expect(text.indexOf("## alpha@2.0.0")).toBeLessThan(text.indexOf("## zeta@1.0.0"));
    expect(text).toContain("License: BSD-3-Clause");
    expect(text).toContain("````text\nMIT text with ```code``` inside\n````");
  });
});

describe("resolveExternalDependencies", () => {
  it("declares each external at the exact version its importer pins, and skips Node builtins", () => {
    const deps = resolveExternalDependencies([
      { specifier: "zod", importer: importer("@clarkcant/contracts", { zod: "4.6.5" }) },
      { specifier: "zod/v4", importer: importer("@clarkcant/core", { zod: "4.6.5" }) },
      { specifier: "vite", importer: importer("@clarkcant/widget-cli", { vite: "8.3.0" }) },
      { specifier: "node:fs", importer: importer("@clarkcant/core", {}) },
      { specifier: "path", importer: importer("@clarkcant/core", {}) },
    ]);
    expect(deps).toEqual({ vite: "8.3.0", zod: "4.6.5" });
  });

  it("refuses an import its package does not declare", () => {
    expect(() => resolveExternalDependencies([{ specifier: "left-pad", importer: importer("@clarkcant/core", {}) }])).toThrow(
      /@clarkcant\/core imports left-pad but does not declare left-pad/,
    );
  });

  it("refuses a range, and two importers that pin different versions", () => {
    expect(() => resolveExternalDependencies([{ specifier: "zod", importer: importer("@clarkcant/a", { zod: "^4.6.5" }) }])).toThrow(
      /needs an exact version/,
    );
    expect(() =>
      resolveExternalDependencies([
        { specifier: "zod", importer: importer("@clarkcant/a", { zod: "4.6.5" }) },
        { specifier: "zod", importer: importer("@clarkcant/b", { zod: "4.6.4" }) },
      ]),
    ).toThrow(/declared as 4\.6\.5 by @clarkcant\/a and 4\.6\.4 by @clarkcant\/b/);
  });
});

describe("rewriteDeclarationSpecifiers", () => {
  /** The references `ts.preProcessFile` reports: each specifier with `pos` at its opening quote. */
  const references = (text: string, specifiers: string[]) =>
    specifiers.map((fileName) => ({ fileName, pos: text.indexOf(`"${fileName}"`), end: text.indexOf(`"${fileName}"`) + fileName.length }));

  it("points relative, workspace and type-import specifiers at the shipped declarations and reports bare ones", () => {
    const text = [
      'import { z } from "zod";',
      'import type { A } from "@clarkcant/contracts";',
      'export * from "./runtime.ts";',
      'export type B = import("./dom.tsx").B;',
      '/** Not an import: "from "./nowhere.ts"" in a comment. */',
      "",
    ].join("\n");
    const resolveWorkspace = (specifier: string) => (specifier === "@clarkcant/contracts" ? "packages/contracts/src/index" : undefined);
    const { text: rewritten, bare } = rewriteDeclarationSpecifiers(
      text,
      "packages/widget-sdk/src/index.d.ts",
      resolveWorkspace,
      references(text, ["zod", "@clarkcant/contracts", "./runtime.ts", "./dom.tsx"]),
    );
    expect(rewritten).toContain('from "zod"');
    expect(rewritten).toContain('from "../../contracts/src/index.js"');
    expect(rewritten).toContain('export * from "./runtime.js"');
    expect(rewritten).toContain('import("./dom.js")');
    expect(rewritten).toContain('"from "./nowhere.ts"" in a comment');
    expect(bare).toEqual(["zod"]);
  });

  it("refuses a workspace import no package exports", () => {
    const text = 'import { x } from "@clarkcant/nope";\n';
    expect(() => rewriteDeclarationSpecifiers(text, "a/b.d.ts", () => undefined, references(text, ["@clarkcant/nope"]))).toThrow(
      /no workspace package exports/,
    );
  });
});

/*
 * The real build, into a scratch directory: what the release would publish. Installing it outside the repository and
 * running the commands is `tools/smoke-widget-tooling.mjs`, which needs the network; this needs only the checkout.
 */
describe("buildWidgetTooling", () => {
  let outRoot = "";
  let stages: { sdk: string; cli: string };
  let bundledWorkspace: string[];

  beforeAll(async () => {
    outRoot = mkdtempSync(join(tmpdir(), "clark-tooling-build-"));
    ({ stages, bundledWorkspace } = await buildWidgetTooling({ outRoot }));
  }, 180_000);

  it("inlines only workspace code CI's smoke gate watches, so a change to any of it runs the smoke", () => {
    expect(bundledWorkspace).toContain("packages/widget-sdk");
    for (const dir of bundledWorkspace) expect(touchesWidgetTooling([`${dir}/src/changed.ts`])).toBe(true);
  });

  afterAll(() => {
    if (outRoot !== "") rmSync(outRoot, { recursive: true, force: true });
  });

  const manifest = (stage: string): Record<string, unknown> & { dependencies: Record<string, string> } =>
    JSON.parse(readFileSync(join(stage, "package.json"), "utf8")) as Record<string, unknown> & { dependencies: Record<string, string> };

  it("writes publishable manifests: public, exact third-party dependencies, no workspace specifier or script", () => {
    for (const stage of [stages.sdk, stages.cli]) {
      const json = manifest(stage);
      expect(json.private).toBeUndefined();
      expect(json.scripts).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain("workspace:");
      for (const [name, version] of Object.entries(json.dependencies)) {
        expect(name.startsWith("@clarkcant/")).toBe(false);
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      }
      expect(json.publishConfig).toEqual({ access: "public", provenance: true });
    }
    expect(manifest(stages.cli).bin).toEqual({ clark: "./lib/cli.js" });
    // Only the command runs in Node; the SDK is a browser library.
    expect(manifest(stages.cli).engines).toEqual({ node: ">=22.19.0" });
    expect(manifest(stages.sdk).engines).toBeUndefined();
  });

  it("gives the SDK's ./dom subpath types under the older node10 resolution too", () => {
    const sdk = manifest(stages.sdk) as unknown as { exports: Record<string, { types: string }>; typesVersions: Record<string, Record<string, string[]>> };
    expect(sdk.typesVersions).toEqual({ "*": { dom: [sdk.exports["./dom"]?.types] } });
  });

  it("ships notices for the third-party code its runtimes inline, and lists them in files", () => {
    const cli = manifest(stages.cli) as unknown as { files: string[] };
    expect(cli.files).toContain("THIRD_PARTY_NOTICES.md");
    const notices = readFileSync(join(stages.cli, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toMatch(/^## react@\d/m);
    expect(notices).toMatch(/^## highlight\.js@\d/m);
    // The SDK inlines no third-party code: zod stays a dependency.
    expect(existsSync(join(stages.sdk, "THIRD_PARTY_NOTICES.md"))).toBe(false);
  });

  it("ships the SDK's two entry points with declarations, and no workspace import in any module", () => {
    const sdk = manifest(stages.sdk) as unknown as { exports: Record<string, { types: string; default: string }> };
    for (const subpath of [".", "./dom"]) {
      const entry = sdk.exports[subpath];
      expect(entry).toBeDefined();
      expect(existsSync(join(stages.sdk, entry?.types ?? ""))).toBe(true);
      expect(existsSync(join(stages.sdk, entry?.default ?? ""))).toBe(true);
    }
    const modules = [
      ...readdirSync(join(stages.sdk, "lib")).map((name) => join(stages.sdk, "lib", name)),
      join(stages.cli, "lib", "cli.js"),
      ...readdirSync(join(stages.cli, "runtime")).map((name) => join(stages.cli, "runtime", name)),
    ];
    for (const file of modules) expect(readFileSync(file, "utf8")).not.toMatch(/(?:from\s*|import\s*\(\s*)["']@clarkcant\//);
  });

  it("ships the CLI's reference templates without their tests, and its bundled browser runtimes", () => {
    // The lists the CLI looks assets up by, so a template or runtime the CLI names is one the package ships.
    expect(readdirSync(join(stages.cli, "templates")).sort()).toEqual([...REFERENCE_APPS].sort());
    for (const app of REFERENCE_APPS) {
      expect(existsSync(join(stages.cli, "templates", app, "clarkcant.json"))).toBe(true);
      for (const skipped of ["test", "README.md", "README.vi.md", "LICENSE"]) {
        expect(existsSync(join(stages.cli, "templates", app, skipped))).toBe(false);
      }
    }
    expect(existsSync(join(stages.cli, "templates", "connected-app", "dev", "service.test.mjs"))).toBe(true);
    expect(readdirSync(join(stages.cli, "runtime")).sort()).toEqual(Object.keys(BROWSER_RUNTIME_SOURCES).map((name) => `${name}.js`).sort());
  });
});
