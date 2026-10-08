import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityRef, WidgetDefinition } from "@clarkcant/contracts";
import { registerCapability } from "@clarkcant/core";

import { locateIsolatedFrame } from "../src/routes/conversations.ts";
import type { ServiceHost } from "../src/service-host.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { listPlaceableWidgets, placeWidget } from "../src/widget-perform-tool.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * Whose widget a placed button belongs to, read through the node's own frame lookup and a real directory listing.
 *
 * Widget ids are not namespaced, so two packages can declare the same one. The package the node loads the widget from
 * is the directory entry the definition was read from, and its active generation is found by package identity — the
 * manifest id, or the path a local install was recorded under — and version. A button may only call what that
 * generation serves, and `list` shows the widget only under that package.
 */

const SHARED = "com.example.shared.main@1";
const IDLE = "com.example.idle.main@1";
const SHEET = "com.example.sheet";
const MAIL = "com.example.mail";
const OWN = "com.example.sheet.chart@1" as CapabilityRef;
const OTHER = "com.example.mail.send@1" as CapabilityRef;
const SHEET_GENERATION = "gen_sheet";
const MAIL_GENERATION = "gen_mail";

let dir: string;
let indexPath: string;
let previousIndex: string | undefined;
let services: NodeServices;

function definition(id: string): WidgetDefinition {
  return {
    id,
    version: "1.0.0",
    renderer: "isolated-app",
    propsSchema: { type: "object", properties: { chartBinding: { type: "string" } }, additionalProperties: false },
    eventSchemas: {},
    stateVersion: 1,
    sizing: { compact: true, expanded: true },
    textFallback: "A widget.",
    effectCategories: [],
    datasetRefs: [],
    semanticDescription: "A widget",
    requestedCapabilities: [],
  };
}

/** A local package on disk declaring one widget, and its directory entry. */
function writePackage(packageId: string, widgetId: string): Record<string, unknown> {
  const root = join(dir, packageId);
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  writeFileSync(join(root, "widgets", "main", "index.html"), "<!doctype html><div id=root></div>\n");
  writeFileSync(join(root, "widgets", "main", "widget.json"), JSON.stringify(definition(widgetId)));
  writeFileSync(
    join(root, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: packageId,
      version: "1.0.0",
      displayName: packageId,
      description: "A package.",
      hostApi: { min: 1, max: 1 },
      facets: [{ kind: "widget", id: widgetId, entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" }],
      requestedCapabilities: [],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
  return {
    packageId,
    version: "1.0.0",
    displayName: packageId,
    description: "A package.",
    source: { kind: "local", path: root },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 1024,
    digest: `sha256:${packageId}`,
  };
}

/** An active generation recorded under `recordedAs`: the manifest id, or the path a local install was recorded under. */
function activate(generationId: string, recordedAs: string, widgetIds: string[]): void {
  const nodeId = services.runtime.identity.nodeId;
  const at = new Date().toISOString();
  const document = {
    generationId,
    packageId: recordedAs,
    version: "1.0.0",
    digest: `sha256:${generationId}`,
    nodeId,
    codeGeneration: "code_1",
    activatedAt: at,
    uiOnlyFacets: ["ui"],
    grantedCapabilities: [],
    widgetIds,
  };
  services.runtime.db
    .prepare(
      `INSERT INTO package_generations (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(generationId, recordedAs, "1.0.0", document.digest, nodeId, "code_1", at, JSON.stringify(document));
}

function register(ref: CapabilityRef, generation: string): void {
  registerCapability(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
    {
      ref,
      providedBy: { packageId: generation, version: "1.0.0", digest: `sha256:${generation}`, generation },
      executionNodeId: services.runtime.identity.nodeId,
      summary: "A capability",
      resourceKinds: [],
      effectCategory: "read",
      supportsCancellation: false,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      uiAffordances: [],
      inputSchema: { type: "object", properties: { kind: { type: "string" } }, additionalProperties: false },
    },
  );
}

const count = (table: string): number =>
  (services.runtime.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number } | undefined)?.n ?? 0;
const chart = (ref: CapabilityRef) => ({ prop: "chartBinding", label: "Vẽ", capabilityRef: ref, inputs: ["kind"] });
const place = (widgetId: string, ref: CapabilityRef) => placeWidget(services, { messageId: () => "msg_place" }, { widgetId, buttons: [chart(ref)] });

let sheetEntry: Record<string, unknown>;
let mailEntry: Record<string, unknown>;
let idleEntry: Record<string, unknown>;

function listing(...entries: Record<string, unknown>[]): void {
  writeFileSync(indexPath, JSON.stringify(entries));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-place-identity-"));
  indexPath = join(dir, "directory.json");
  sheetEntry = writePackage(SHEET, SHARED);
  mailEntry = writePackage(MAIL, SHARED);
  idleEntry = writePackage("com.example.idle", IDLE);
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
  services = bootNodeServices({ dataDir: dir, label: "place widget identity test node" });
  // The sheet's local install was recorded under its path; the mail package under its manifest id.
  activate(SHEET_GENERATION, (sheetEntry.source as { path: string }).path, [SHARED]);
  activate(MAIL_GENERATION, MAIL, [SHARED]);
  register(OWN, SHEET_GENERATION);
  register(OTHER, MAIL_GENERATION);
  const served = new Map<CapabilityRef, { packageId: string; generationId: string }>([
    [OWN, { packageId: SHEET, generationId: SHEET_GENERATION }],
    [OTHER, { packageId: MAIL, generationId: MAIL_GENERATION }],
  ]);
  services.serviceHost = { serves: (ref: CapabilityRef) => served.get(ref) } as unknown as ServiceHost;
});

afterEach(async () => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.db.close();
  await removeTestDirectory(dir);
});

describe("a widget id two active packages declare", () => {
  it("belongs to the package of the entry its definition is read from, found under the path its install was recorded as", () => {
    listing(sheetEntry, mailEntry);
    expect(locateIsolatedFrame(services.runtime, SHARED)).toMatchObject({ ok: true, packageId: SHEET, active: true, generationId: SHEET_GENERATION });

    const before = [count("widget_instances"), count("action_bindings")];
    const refused = place(SHARED, OTHER);
    expect(refused.text).toContain("can only call its own package's service");
    expect([count("widget_instances"), count("action_bindings")]).toEqual(before);
    expect(place(SHARED, OWN).text).toContain("Placed");

    const rows = listPlaceableWidgets(services);
    expect(rows.map((row) => row.widgetId)).toEqual([SHARED]);
    expect(rows[0]?.summary).toContain(OWN);
    expect(rows[0]?.summary).not.toContain(OTHER);
  });

  it("follows the listing: with the other package's entry first, the widget and its buttons are that package's", () => {
    listing(mailEntry, sheetEntry);
    expect(locateIsolatedFrame(services.runtime, SHARED)).toMatchObject({ ok: true, packageId: MAIL, active: true, generationId: MAIL_GENERATION });
    expect(place(SHARED, OWN).text).toContain("can only call its own package's service");

    const rows = listPlaceableWidgets(services);
    expect(rows.map((row) => row.widgetId)).toEqual([SHARED]);
    expect(rows[0]?.summary).toContain(OTHER);
    expect(rows[0]?.summary).not.toContain(OWN);
  });
});

describe("a listed package no generation runs", () => {
  it("is located with no generation, and is neither placed nor listed", () => {
    listing(sheetEntry, mailEntry, idleEntry);
    expect(locateIsolatedFrame(services.runtime, IDLE)).toMatchObject({ ok: true, active: false, generationId: undefined });
    expect(place(IDLE, OWN).text).toContain("is not installed and running on this node");
    expect(listPlaceableWidgets(services).map((row) => row.widgetId)).not.toContain(IDLE);
  });
});
