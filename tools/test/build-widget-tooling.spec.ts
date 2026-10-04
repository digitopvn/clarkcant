import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildWidgetTooling,
  packageNameOf,
  resolveExternalDependencies,
  rewriteDeclarationSpecifiers,
} from "../build-widget-tooling.mjs";

const importer = (name: string, dependencies: Record<string, string>) => ({ name, dependencies });

describe("packageNameOf", () => {
  it("names the package of a plain, a subpath and a scoped specifier", () => {
    expect(packageNameOf("zod")).toBe("zod");
    expect(packageNameOf("react-dom/client")).toBe("react-dom");
    expect(packageNameOf("@vitejs/plugin-react")).toBe("@vitejs/plugin-react");
    expect(packageNameOf("@scope/name/sub/path")).toBe("@scope/name");
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

  beforeAll(async () => {
    outRoot = mkdtempSync(join(tmpdir(), "clark-tooling-build-"));
    ({ stages } = await buildWidgetTooling({ outRoot }));
  }, 180_000);

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
    for (const app of ["text-editor", "image-generator", "media-render", "connected-app"]) {
      expect(existsSync(join(stages.cli, "templates", app, "clarkcant.json"))).toBe(true);
      expect(existsSync(join(stages.cli, "templates", app, "test"))).toBe(false);
    }
    expect(existsSync(join(stages.cli, "templates", "connected-app", "dev", "service.test.mjs"))).toBe(true);
    expect(readdirSync(join(stages.cli, "runtime")).sort()).toEqual(["catalog-runtime.js", "dev-frame-runtime.js", "theme-dev-runtime.js"]);
  });
});
