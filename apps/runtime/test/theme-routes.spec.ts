import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Themes, installed and removed through the one package lifecycle and chosen through the one preference.
 *
 * Driven over the HTTP API the browser uses: a theme package is installed with `POST /packages/install`, updated by
 * installing its next version, rolled back, uninstalled and restored with the package routes, and selected by writing
 * `experience.themeRef`. What `GET /appearance` answers after each step is the claim — the theme a person chose is
 * drawn while its package is active, and when it is not, Clark Default is drawn and the reason is named, with the
 * choice itself kept so a restore brings the theme back.
 */

const AT = "2026-09-30T03:00:00.000Z";
const DUSK = "com.example.dusk";
const DUSK_REF = `package:${DUSK}#dusk`;

let dir: string;
let indexPath: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;
let entries: Record<string, unknown>[];

interface PackageSpec {
  id: string;
  version: string;
  facets: Record<string, unknown>[];
  files: Record<string, unknown>;
}

/** Writes a package to its own directory and lists it in the directory index, the way a local install finds it. */
function addPackage(spec: PackageSpec): void {
  const root = join(dir, `${spec.id}-${spec.version}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: spec.id,
      version: spec.version,
      displayName: spec.id,
      description: "A package a theme test installs.",
      hostApi: { min: 1, max: 1 },
      facets: spec.facets,
      requestedCapabilities: [],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64", "web"],
    }),
  );
  for (const [relative, value] of Object.entries(spec.files)) {
    mkdirSync(join(root, relative, ".."), { recursive: true });
    writeFileSync(join(root, relative), typeof value === "string" ? value : JSON.stringify(value));
  }
  const isolations = spec.facets.map((facet) => ({ facetKind: facet["kind"], isolation: facet["isolation"] }));
  entries.push({
    packageId: spec.id,
    version: spec.version,
    displayName: spec.id,
    description: "A package a theme test installs.",
    source: { kind: "local", path: root },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: spec.facets.map((facet) => facet["kind"]),
    isolations,
    platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64", "web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: isolations.some((facet) => facet.isolation === "isolated-ui") ? "isolated-ui" : "declarative",
    sizeBytes: 512,
    digest: digestOf(spec.id, spec.version),
  });
  writeFileSync(indexPath, JSON.stringify(entries));
}

function digestOf(id: string, version: string): string {
  return `sha256:${id}-${version}`;
}

function themeFacet(id: string): Record<string, unknown> {
  return { kind: "themes", id, entry: `themes/${id}.json`, isolation: "declarative" };
}

function theme(id: string, accent: string): Record<string, unknown> {
  return { appearanceApi: { min: 1, max: 1 }, id, displayName: `Theme ${id}`, colors: { dark: { accent } } };
}

function addDusk(version: string, accent: string): void {
  addPackage({
    id: DUSK,
    version,
    facets: [themeFacet("dusk")],
    files: { "themes/dusk.json": theme("dusk", accent) },
  });
}

async function call(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
  const request: GatewayRequest = {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  };
  return handleRequest(deps, request);
}

async function install(id: string, version: string): Promise<void> {
  const response = await call("POST", "/packages/install", { packageId: id, version, localDigest: digestOf(id, version) });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect((response.body as { state: string }).state).toBe("active");
}

async function change(id: string, action: "uninstall" | "restore" | "rollback"): Promise<Record<string, unknown>> {
  const response = await call("POST", `/packages/${encodeURIComponent(id)}/${action}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as Record<string, unknown>;
}

async function choose(themeRef: string): Promise<void> {
  const response = await call("PUT", "/preferences/experience.themeRef", { value: themeRef });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

interface AppearanceBody {
  selectedRef: string;
  appliedRef: string;
  theme: { colors?: { dark?: { accent?: string } } } | null;
  provider: Record<string, unknown>;
  fallback: { code: string; message: string } | null;
}

async function appearance(): Promise<AppearanceBody> {
  const response = await call("GET", "/appearance");
  expect(response.status).toBe(200);
  return response.body as AppearanceBody;
}

interface ThemesBody {
  themes: { themeRef: string; displayName: string; provider: Record<string, unknown> }[];
  problems: { packageId: string; themeRef: string | undefined; message: string }[];
  unchecked: { packageId: string; code: string }[];
}

async function themes(): Promise<ThemesBody> {
  const response = await call("GET", "/themes");
  expect(response.status).toBe(200);
  return response.body as ThemesBody;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-theme-routes-"));
  indexPath = join(dir, "directory.json");
  entries = [];
  writeFileSync(indexPath, "[]");
  services = bootNodeServices({ dataDir: dir, label: "theme routes test node" });
  deps = { services, now: () => AT as never };
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the themes this node can draw", () => {
  it("is Clark Default alone until a package provides another", async () => {
    const listed = await themes();

    expect(listed.themes).toEqual([
      { themeRef: "builtin:clark", displayName: "Clark Default", provider: { kind: "builtin" } },
    ]);
    expect(await appearance()).toEqual({
      selectedRef: "builtin:clark",
      appliedRef: "builtin:clark",
      theme: null,
      provider: { kind: "builtin" },
      fallback: null,
    });
  });

  it("lists an installed theme with the version, digest, lane and source of the package that provides it", async () => {
    addDusk("1.0.0", "#112233");
    await install(DUSK, "1.0.0");

    const listed = await themes();

    expect(listed.themes[1]).toEqual({
      themeRef: DUSK_REF,
      displayName: "Theme dusk",
      provider: {
        kind: "package",
        packageId: DUSK,
        version: "1.0.0",
        digest: digestOf(DUSK, "1.0.0"),
        lane: "declarative",
        sourceTier: expect.any(String) as unknown,
      },
    });
    expect(listed.problems).toEqual([]);
  });

  it("labels a theme shipped beside a stronger facet with the package's strongest lane", async () => {
    addPackage({
      id: "com.example.panel",
      version: "1.0.0",
      facets: [
        {
          kind: "ui",
          id: "canvas.panel@1",
          entry: "widgets/panel/index.html",
          definition: "widgets/panel/widget.json",
          isolation: "isolated-ui",
        },
        themeFacet("panel-dark"),
      ],
      files: {
        "widgets/panel/index.html": "<!doctype html><title>panel</title>",
        "widgets/panel/widget.json": {
          id: "canvas.panel@1",
          version: "1.0.0",
          renderer: "isolated",
          propsSchema: { type: "object" },
          eventSchemas: {},
          semanticDescription: "A panel",
          requestedCapabilities: [],
          sizing: { compact: true, expanded: true },
          textFallback: "A panel.",
          effectCategories: ["read"],
          datasetRefs: [],
        },
        "themes/panel-dark.json": theme("panel-dark", "#445566"),
      },
    });
    await install("com.example.panel", "1.0.0");

    const listed = await themes();

    expect(listed.themes.find((entry) => entry.themeRef === "package:com.example.panel#panel-dark")?.provider).toMatchObject({
      lane: "isolated-ui",
    });
  });

  it("names a theme that did not pass validation instead of leaving it out", async () => {
    addPackage({
      id: "com.example.broken",
      version: "1.0.0",
      facets: [themeFacet("loud")],
      files: { "themes/loud.json": theme("loud", "red; } body { display: none") },
    });
    await install("com.example.broken", "1.0.0");

    const listed = await themes();

    expect(listed.themes.map((entry) => entry.themeRef)).toEqual(["builtin:clark"]);
    expect(listed.problems).toEqual([
      expect.objectContaining({ packageId: "com.example.broken", themeRef: "package:com.example.broken#loud" }),
    ]);
    expect(listed.problems[0]?.message).toMatch(/six-digit hex/);
  });
});

describe("the appearance a choice resolves to", () => {
  it("follows the package through update, rollback, uninstall and restore without a Pi restart", async () => {
    addDusk("1.0.0", "#112233");
    addDusk("2.0.0", "#445566");
    await install(DUSK, "1.0.0");
    await choose(DUSK_REF);

    const chosen = await appearance();
    expect(chosen).toMatchObject({ selectedRef: DUSK_REF, appliedRef: DUSK_REF, fallback: null });
    expect(chosen.theme?.colors?.dark?.accent).toBe("#112233");
    expect(chosen.provider).toMatchObject({ kind: "package", version: "1.0.0" });

    // An update is an install of the next version, through the same route.
    await install(DUSK, "2.0.0");
    const updated = await appearance();
    expect(updated.theme?.colors?.dark?.accent).toBe("#445566");
    expect(updated.provider).toMatchObject({ version: "2.0.0", digest: digestOf(DUSK, "2.0.0") });

    const rolledBack = await change(DUSK, "rollback");
    expect(rolledBack["restartNeeded"]).toBe(false);
    expect((await appearance()).theme?.colors?.dark?.accent).toBe("#112233");

    const removed = await change(DUSK, "uninstall");
    expect(removed["restartNeeded"]).toBe(false);
    const fallen = await appearance();
    expect(fallen).toMatchObject({
      selectedRef: DUSK_REF,
      appliedRef: "builtin:clark",
      theme: null,
      provider: { kind: "builtin" },
      fallback: { code: "THEME_NOT_INSTALLED" },
    });

    const restored = await change(DUSK, "restore");
    expect(restored["restartNeeded"]).toBe(false);
    expect(await appearance()).toMatchObject({ appliedRef: DUSK_REF, fallback: null });
  });

  it("records a theme-only package as a change the UI refreshes, not one a Pi worker reloads", async () => {
    addDusk("1.0.0", "#112233");
    await install(DUSK, "1.0.0");

    const row = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE package_id = ? AND superseded_at IS NULL")
      .get(DUSK) as { document: string };
    expect((JSON.parse(row.document) as { uiOnlyFacets: string[] }).uiOnlyFacets).toEqual(["themes"]);
  });

  it("falls back to Clark Default and says why when the chosen theme is invalid", async () => {
    addPackage({
      id: "com.example.broken",
      version: "1.0.0",
      facets: [themeFacet("loud")],
      files: { "themes/loud.json": theme("loud", "url(https://example.com/x.png)") },
    });
    await install("com.example.broken", "1.0.0");
    await choose("package:com.example.broken#loud");

    const resolved = await appearance();

    expect(resolved).toMatchObject({
      selectedRef: "package:com.example.broken#loud",
      appliedRef: "builtin:clark",
      theme: null,
      fallback: { code: "THEME_INVALID" },
    });
  });

  it("falls back when the package is installed but its files cannot be located", async () => {
    addDusk("1.0.0", "#112233");
    await install(DUSK, "1.0.0");
    await choose(DUSK_REF);
    writeFileSync(indexPath, "[]");

    expect(await appearance()).toMatchObject({ appliedRef: "builtin:clark", fallback: { code: "THEME_UNAVAILABLE" } });
  });

  it("does not draw files the directory now lists under a digest other than the one installed", async () => {
    addDusk("1.0.0", "#112233");
    await install(DUSK, "1.0.0");
    await choose(DUSK_REF);
    writeFileSync(indexPath, JSON.stringify(entries.map((entry) => ({ ...entry, digest: "sha256:different-bytes" }))));

    expect(await appearance()).toMatchObject({ appliedRef: "builtin:clark", fallback: { code: "THEME_UNAVAILABLE" } });
    const listed = await themes();
    expect(listed.themes.map((theme) => theme.themeRef)).toEqual(["builtin:clark"]);
    expect(listed.unchecked).toEqual([expect.objectContaining({ packageId: DUSK, code: "NOT_IN_DIRECTORY" })]);
  });

  it("falls back when a built-in name is one this build does not have", async () => {
    await choose("builtin:neon");

    expect(await appearance()).toMatchObject({
      selectedRef: "builtin:neon",
      appliedRef: "builtin:clark",
      fallback: { code: "THEME_UNKNOWN" },
    });
  });
});
