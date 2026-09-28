import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manifestProblems, packageManifestSchema, type PackageManifest } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { readPackage } from "../src/widget-package.ts";

/**
 * The one manifest a package has.
 *
 * Two things are pinned here. A package can carry more than widgets — a service, skills — and say so in the same file
 * with each facet in its own lane. And a package written in the widget-only format keeps being read, into the same
 * shape, because its consent is bound to bytes that must not be rewritten.
 */

const WIDGET_ID = "com.example.board.main@1";

function canonical(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    schemaVersion: 2,
    id: "com.example.board",
    version: "1.0.0",
    displayName: "Board",
    description: "A board with a service behind it.",
    hostApi: { min: 1, max: 1 },
    facets: [
      {
        kind: "ui",
        id: WIDGET_ID,
        entry: "widgets/main/index.html",
        definition: "widgets/main/widget.json",
        isolation: "isolated-ui",
      },
      {
        kind: "tools",
        id: "com.example.board.service",
        entry: "service/server.mjs",
        isolation: "service",
        protocol: "mcp-stdio",
        capabilities: [
          { tool: "list_cards", ref: "com.example.board.cards.list@1", summary: "List the board's cards", effectCategory: "read" },
          {
            tool: "move_card",
            ref: "com.example.board.cards.move@1",
            summary: "Move a card to another column",
            effectCategory: "local-write",
          },
        ],
      },
      { kind: "skills", id: "com.example.board.skills", entry: "skills/", isolation: "declarative" },
    ],
    requestedCapabilities: [],
    permissions: { networkOrigins: [], filesystem: [{ path: "data", access: "write" }], microphone: false, camera: false, lifecycleScripts: [] },
    platforms: ["darwin-arm64", "linux-x64", "win32-x64"],
    dependencies: [],
    ...overrides,
  };
}

function v1Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "com.example.board",
    version: "1.0.0",
    displayName: "Board",
    description: "A widget-only package.",
    hostApi: { min: 1, max: 1 },
    facets: [
      { kind: "widget", id: WIDGET_ID, entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" },
    ],
    requestedCapabilities: ["widget.state.read@1"],
    permissions: { networkOrigins: [], filesystem: ["notes"], microphone: false, camera: false, lifecycleScripts: [] },
    platforms: ["linux-x64"],
    publisher: { id: "com.example", sourceUrl: "https://example.invalid", license: "MIT" },
    ...overrides,
  };
}

function writePackage(manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "cc-package-manifest-"));
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  writeFileSync(join(root, "clarkcant.json"), JSON.stringify(manifest));
  writeFileSync(
    join(root, "widgets", "main", "widget.json"),
    JSON.stringify({
      id: WIDGET_ID,
      version: "1.0.0",
      renderer: "isolated-app",
      propsSchema: { type: "object", properties: {} },
      eventSchemas: {},
      semanticDescription: "A board",
      requestedCapabilities: [],
      sizing: { compact: true, expanded: true },
      textFallback: "Board. Shown as text when it cannot be mounted.",
      effectCategories: ["read"],
      datasetRefs: [],
    }),
  );
  return root;
}

describe("the canonical package manifest", () => {
  it("describes a package with a widget, a service and skills, each in its own lane", () => {
    const parsed = packageManifestSchema.safeParse(canonical());
    expect(parsed.success).toBe(true);
    expect(manifestProblems(canonical())).toEqual([]);
  });

  it("ties each facet kind to the only lane it may run in", () => {
    const [ui, tools, skills] = canonical().facets;
    const wrongLanes = [
      { ...ui, isolation: "service" },
      { ...tools, isolation: "trusted-native" },
      { ...skills, isolation: "isolated-ui" },
    ];
    for (const facet of wrongLanes) {
      expect(packageManifestSchema.safeParse({ ...canonical(), facets: [facet] }).success, JSON.stringify(facet)).toBe(false);
    }
  });

  it("refuses a service facet that declares no capability, because consent could not say what it does", () => {
    const tools = { ...canonical().facets[1], capabilities: [] };
    expect(packageManifestSchema.safeParse({ ...canonical(), facets: [tools] }).success).toBe(false);
  });

  it("refuses a facet kind it does not know rather than ignoring it", () => {
    const unknown = { kind: "daemon", id: "x", entry: "x.mjs", isolation: "service" };
    expect(packageManifestSchema.safeParse({ ...canonical(), facets: [unknown] }).success).toBe(false);
  });

  it("reports facet ids declared twice", () => {
    const [ui] = canonical().facets;
    expect(manifestProblems(canonical({ facets: [ui!, ui!] }))).toEqual([`facets: id "${WIDGET_ID}" is declared twice`]);
  });

  it("reports a facet whose files are outside the package, however the path is spelled", () => {
    const [ui] = canonical().facets;
    for (const entry of ["../outside/index.html", "/etc/index.html", "\\\\server\\share\\index.html", "C:/index.html", "widgets/../../x.html"]) {
      const problems = manifestProblems(canonical({ facets: [{ ...ui!, entry } as PackageManifest["facets"][number]] }));
      expect(problems, entry).toEqual([`facet ${WIDGET_ID}: ${entry} escapes the package root`]);
    }
    const remote = manifestProblems(canonical({ facets: [{ ...ui!, entry: "https://cdn.example/index.html" } as PackageManifest["facets"][number]] }));
    expect(remote).toEqual([`facet ${WIDGET_ID}: https://cdn.example/index.html is a URL; a facet's files must be inside the package`]);
  });

  it("refuses a capability named outside the package, so a package cannot pose as one users already trust", () => {
    const tools = canonical().facets[1] as Extract<PackageManifest["facets"][number], { kind: "tools" }>;
    const impostor = {
      ...tools,
      capabilities: [{ ...tools.capabilities[0]!, ref: "google.calendar.events.delete@1" }],
    };
    expect(manifestProblems(canonical({ facets: [impostor] }))).toEqual([
      "facet com.example.board.service: capability google.calendar.events.delete@1 must be named under the package id, as com.example.board.<name>@<n>",
    ]);
  });

  it("reports a tool or capability a service declares twice", () => {
    const tools = canonical().facets[1] as Extract<PackageManifest["facets"][number], { kind: "tools" }>;
    const first = tools.capabilities[0]!;
    const doubled = { ...tools, capabilities: [first, first] };
    expect(manifestProblems(canonical({ facets: [doubled] }))).toEqual([
      `facet com.example.board.service: capability ${first.ref} is declared twice`,
      `facet com.example.board.service: tool ${first.tool} is declared twice`,
    ]);
  });
});

describe("reading a package", () => {
  it("reads a canonical manifest and returns its widgets, leaving the other facets to their hosts", () => {
    const pkg = readPackage(writePackage(canonical()));
    expect(pkg.problems).toEqual([]);
    expect(pkg.manifest.facets.map((facet) => facet.kind)).toEqual(["ui", "tools", "skills"]);
    expect(pkg.facets.map((facet) => facet.facetId)).toEqual([WIDGET_ID]);
  });

  it("reads a widget-only v1 manifest into the canonical shape without changing what it said", () => {
    const pkg = readPackage(writePackage(v1Manifest()));
    expect(pkg.problems).toEqual([]);
    expect(packageManifestSchema.safeParse(pkg.manifest).success).toBe(true);
    expect(pkg.manifest.schemaVersion).toBe(2);
    expect(pkg.manifest.facets).toEqual([
      { kind: "ui", id: WIDGET_ID, entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" },
    ]);
    // A path v1 listed with no access mode could only ever be read.
    expect(pkg.manifest.permissions.filesystem).toEqual([{ path: "notes", access: "read" }]);
    expect(pkg.manifest.requestedCapabilities).toEqual(["widget.state.read@1"]);
    expect(pkg.manifest.publisher).toEqual({ id: "com.example", sourceUrl: "https://example.invalid", license: "MIT" });
    expect(pkg.facets.map((facet) => facet.facetId)).toEqual([WIDGET_ID]);
  });

  it("reports a v1 value the canonical manifest does not accept instead of repairing it", () => {
    const pkg = readPackage(writePackage(v1Manifest({ platforms: ["amiga"] })));
    expect(pkg.facets).toEqual([]);
    expect(pkg.problems).toHaveLength(1);
    expect(pkg.problems[0]).toContain("platforms.0");
    expect(pkg.problems[0]).toContain("a schemaVersion 1 value the canonical manifest does not accept");
  });

  it("does not open a v1 definition outside the package", () => {
    const facet = { kind: "widget", id: WIDGET_ID, entry: "widgets/main/index.html", definition: "../widget.json", isolation: "isolated-ui" };
    const pkg = readPackage(writePackage(v1Manifest({ facets: [facet] })));
    expect(pkg.facets).toEqual([]);
    expect(pkg.problems).toEqual([expect.stringContaining(`facet ${WIDGET_ID}: ../widget.json escapes the package root`)]);
  });

  it("names the versions it reads when the file claims another", () => {
    const pkg = readPackage(writePackage({ ...canonical(), schemaVersion: 3 }));
    expect(pkg.facets).toEqual([]);
    expect(pkg.problems).toEqual([expect.stringContaining("schemaVersion must be 2 (or 1, the widget-only format still read)")]);
  });
});
