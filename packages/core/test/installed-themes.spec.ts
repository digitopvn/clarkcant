import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APPEARANCE_API_VERSION } from "@clarkcant/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { THEME_DOCUMENT_MAX_BYTES, installedThemes } from "../src/installed-themes.ts";

/**
 * Reading the themes an installed package declares.
 *
 * What matters is what the host will and will not take from a package: a document the contract accepts, from a file
 * inside the package, of a bounded size, whose id is the one the manifest gives it. Anything else is named as a
 * problem, and the package's other themes still load.
 */

const PACKAGE_ID = "com.example.themes";

let base: string;
let root: string;

function manifest(facets: readonly Record<string, unknown>[], id = PACKAGE_ID): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    version: "1.0.0",
    displayName: "Example themes",
    description: "Themes a package declares.",
    hostApi: { min: 1, max: 1 },
    facets,
    requestedCapabilities: [],
    permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
    platforms: ["web"],
  };
}

function themeFacet(id: string, entry = `themes/${id}.json`): Record<string, unknown> {
  return { kind: "themes", id, entry, isolation: "declarative" };
}

function themeDocument(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appearanceApi: { min: 1, max: 1 },
    id,
    displayName: `Theme ${id}`,
    colors: { dark: { accent: "#7AA2F7" } },
    ...overrides,
  };
}

function write(relative: string, value: unknown): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cc-installed-themes-"));
  root = join(base, "package");
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("installedThemes", () => {
  it("reads a valid theme and names it by the package's own id and the facet id", () => {
    write("clarkcant.json", manifest([themeFacet("dusk")]));
    write("themes/dusk.json", themeDocument("dusk"));

    const read = installedThemes({ source: { kind: "local", path: root } });

    expect(read).toEqual({
      ok: true,
      manifestId: PACKAGE_ID,
      themes: [
        {
          themeRef: `package:${PACKAGE_ID}#dusk`,
          facetId: "dusk",
          document: themeDocument("dusk"),
        },
      ],
      problems: [],
    });
  });

  it("keeps a package's working themes when one of them is broken, and names the broken one", () => {
    write(
      "clarkcant.json",
      manifest([themeFacet("good"), themeFacet("hostile"), themeFacet("mismatch"), themeFacet("missing"), themeFacet("garbled")]),
    );
    write("themes/good.json", themeDocument("good"));
    // A value that would break out of a declaration block if it ever reached CSS.
    write("themes/hostile.json", themeDocument("hostile", { colors: { dark: { accent: "red; } * { display: none" } } }));
    write("themes/mismatch.json", themeDocument("someone-else"));
    write("themes/garbled.json", "{ not json");

    const read = installedThemes({ source: { kind: "local", path: root } });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.themes.map((theme) => theme.facetId)).toEqual(["good"]);
    expect(read.problems).toHaveLength(4);
    // Named by the reference a selection would hold, so a person who chose it can be told which theme broke.
    expect(read.problems.map((problem) => problem.themeRef)).toEqual([
      `package:${PACKAGE_ID}#hostile`,
      `package:${PACKAGE_ID}#mismatch`,
      `package:${PACKAGE_ID}#missing`,
      `package:${PACKAGE_ID}#garbled`,
    ]);
    expect(read.problems[0]?.message).toMatch(/^theme hostile .*colors\.dark\.accent: must be a six-digit hex colour/);
    expect(read.problems[1]?.message).toMatch(/^theme mismatch .*id "someone-else" does not match the manifest facet id "mismatch"/);
    expect(read.problems[2]?.message).toMatch(/^theme missing .*no such file/);
    expect(read.problems[3]?.message).toMatch(/^theme garbled .*not valid JSON/);
  });

  it("refuses a document outside the appearance API range this host speaks", () => {
    write("clarkcant.json", manifest([themeFacet("future")]));
    write(
      "themes/future.json",
      themeDocument("future", { appearanceApi: { min: APPEARANCE_API_VERSION + 1, max: APPEARANCE_API_VERSION + 2 } }),
    );

    const read = installedThemes({ source: { kind: "local", path: root } });

    expect(read.ok && read.themes).toEqual([]);
    expect(read.ok && read.problems[0]?.message).toMatch(/appearance API/);
  });

  it("does not follow an entry that is a symlink to a file outside the package", () => {
    const outside = join(base, "outside.json");
    writeFileSync(outside, JSON.stringify(themeDocument("escape")));
    write("clarkcant.json", manifest([themeFacet("escape")]));
    mkdirSync(join(root, "themes"), { recursive: true });
    symlinkSync(outside, join(root, "themes", "escape.json"));

    const read = installedThemes({ source: { kind: "local", path: root } });

    expect(read.ok && read.themes).toEqual([]);
    expect(read.ok && read.problems[0]?.message).toMatch(/outside the package/);
  });

  it("refuses a document over the size limit without parsing it", () => {
    write("clarkcant.json", manifest([themeFacet("huge")]));
    // Valid JSON, and a valid document apart from its size, so only the limit can refuse it.
    write("themes/huge.json", `${JSON.stringify(themeDocument("huge"))}${" ".repeat(THEME_DOCUMENT_MAX_BYTES)}`);

    const read = installedThemes({ source: { kind: "local", path: root } });

    expect(read.ok && read.themes).toEqual([]);
    expect(read.ok && read.problems[0]?.message).toMatch(/over the 65536-byte limit/);
  });

  it("names a package id a theme reference cannot carry instead of offering a theme nobody can select", () => {
    write("clarkcant.json", manifest([themeFacet("dusk")], "has#hash"));
    write("themes/dusk.json", themeDocument("dusk"));

    const read = installedThemes({ source: { kind: "local", path: root } });

    expect(read.ok && read.themes).toEqual([]);
    expect(read.ok && read.problems[0]?.message).toMatch(/cannot name a theme/);
  });

  it("never reaches for bytes this node does not hold", () => {
    const read = installedThemes({ source: { kind: "npm", name: "com.example.themes", version: "1.0.0" } });

    expect(read).toMatchObject({ ok: false, code: "NOT_LOCAL" });
  });

  it("reports a package whose manifest cannot be read as unreadable, not as a package with no themes", () => {
    write("clarkcant.json", { schemaVersion: 2, id: PACKAGE_ID });

    const read = installedThemes({ source: { kind: "local", path: root } });

    expect(read).toMatchObject({ ok: false, code: "UNREADABLE" });
  });

  it("ignores a package's other facets", () => {
    write(
      "clarkcant.json",
      manifest([
        { kind: "skills", id: "notes", entry: "skills/notes/SKILL.md", isolation: "declarative" },
        themeFacet("dusk"),
      ]),
    );
    write("themes/dusk.json", themeDocument("dusk"));

    const read = installedThemes({ source: { kind: "local", path: root } });

    expect(read.ok && read.themes.map((theme) => theme.facetId)).toEqual(["dusk"]);
    expect(read.ok && read.problems).toEqual([]);
  });
});
