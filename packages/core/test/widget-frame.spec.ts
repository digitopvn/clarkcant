import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DirectoryEntry } from "@clarkcant/contracts";

import { brokeredCapabilities, findIsolatedFrame, readyCapabilities } from "../src/widget-frame.ts";

/**
 * Finding the frame document for a widget.
 *
 * The join between what the conversation knows (a definition id) and what a frame needs (a URL). It is worth testing
 * at this level because every failure here is quiet: a wrong URL is a frame that loads nothing, and a widget that
 * should have been drawn in the conversation being sent to a frame instead is a surface that half works.
 *
 * The fixtures are packages written the way `clark init` writes them, because the point is to read the format
 * authors actually get rather than one this test invented.
 */

let dir: string;

function writePackage(
  root: string,
  options: {
    packageId?: string;
    widgetId: string;
    renderer: string;
    entry?: string;
    capabilities?: string[];
    origins?: string[];
    omitManifest?: boolean;
  },
): void {
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  if (options.omitManifest !== true) {
    writeFileSync(
      join(root, "clarkcant.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: options.packageId ?? "com.example.frame",
        version: "1.0.0",
        displayName: "Frame widget",
        description: "A widget that runs in its own frame.",
        hostApi: { min: 1, max: 1 },
        facets: [
          {
            kind: "widget",
            id: "main",
            entry: options.entry ?? "widgets/main/index.html",
            definition: "widgets/main/widget.json",
            isolation: "isolated-ui",
          },
        ],
        requestedCapabilities: options.capabilities ?? [],
        permissions: {
          networkOrigins: options.origins ?? [],
          filesystem: [],
          microphone: false,
          camera: false,
          lifecycleScripts: [],
        },
        platforms: ["linux-x64"],
        publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
      }),
    );
  }
  writeFileSync(
    join(root, "widgets", "main", "widget.json"),
    JSON.stringify({
      id: options.widgetId,
      version: "0.1.0",
      renderer: options.renderer,
      propsSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      eventSchemas: {},
      stateSchema: { type: "object", properties: {}, additionalProperties: true },
      stateVersion: 0,
      semanticDescription: "A frame widget.",
      requestedCapabilities: [],
      sizing: { compact: true, expanded: true, minHeight: 160 },
      textFallback: "Frame widget",
      effectCategories: [],
      datasetRefs: [],
    }),
  );
  writeFileSync(join(root, "widgets", "main", "index.html"), "<!doctype html><p>frame widget</p>\n");
}

function entry(source: DirectoryEntry["source"], overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    packageId: "com.example.frame",
    version: "1.0.0",
    displayName: "Frame widget",
    description: "A widget that runs in its own frame.",
    source,
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: ["linux-x64"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 1024,
    digest: "sha256:frame-digest",
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-frame-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("finding a widget's frame", () => {
  it("returns the URL of the entry the package declares, with what it asked for", () => {
    const root = join(dir, "package");
    writePackage(root, {
      widgetId: "com.example.frame.main@1",
      renderer: "isolated-app",
      capabilities: ["project.code.read@1"],
      origins: ["https://api.example.com"],
    });

    const found = findIsolatedFrame({
      directory: [entry({ kind: "local", path: root })],
      widgetId: "com.example.frame.main@1",
    });

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // The URL is under the package path on purpose: the widget's own relative imports resolve against it.
    expect(found.url).toBe("/packages/com.example.frame/1.0.0/files/widgets/main/index.html");
    expect(found.isolation).toBe("isolated-ui");
    expect(found.requestedCapabilities).toEqual(["project.code.read@1"]);
    expect(found.allowedOrigins).toEqual(["https://api.example.com"]);
  });

  it("refuses a widget that is drawn in the conversation, and says which renderer it has", () => {
    const root = join(dir, "package");
    writePackage(root, { widgetId: "com.example.frame.main@1", renderer: "catalog" });

    const found = findIsolatedFrame({
      directory: [entry({ kind: "local", path: root })],
      widgetId: "com.example.frame.main@1",
    });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.code).toBe("NOT_AN_ISOLATED_APP");
    // Naming the renderer is what makes the message useful: "not an isolated app" alone does not say what to do.
    expect(found.message).toContain("catalog");
  });

  it("refuses a widget no package this node can read declares", () => {
    const root = join(dir, "package");
    writePackage(root, { widgetId: "com.example.frame.main@1", renderer: "isolated-app" });

    const found = findIsolatedFrame({
      directory: [entry({ kind: "local", path: root })],
      widgetId: "com.example.other.main@1",
    });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.code).toBe("NO_SUCH_WIDGET");
  });

  it("does not claim a package whose bytes this node does not have", () => {
    // A git or npm entry names bytes nobody here has. Saying "not found" is the honest answer; a URL pointing at a
    // source this node cannot serve would fail later, in the frame, where nobody is looking.
    const found = findIsolatedFrame({
      directory: [
        entry({ kind: "npm", name: "com.example.frame", version: "1.0.0" }, { packageId: "com.example.frame" }),
      ],
      widgetId: "com.example.frame.main@1",
    });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.code).toBe("NO_SUCH_WIDGET");
  });

  it("says a package could not be read rather than that the widget does not exist", () => {
    // Two different truths, and only one of them is the author's to fix.
    const root = join(dir, "broken");
    writePackage(root, { widgetId: "com.example.frame.main@1", renderer: "isolated-app", omitManifest: true });

    const found = findIsolatedFrame({
      directory: [entry({ kind: "local", path: root })],
      widgetId: "com.example.frame.main@1",
    });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.code).toBe("PACKAGE_UNREADABLE");
  });
});

describe("what a frame is actually brokered", () => {
  it("narrows what a package requested to what a generation actually granted", () => {
    expect(brokeredCapabilities(["a@1", "b@1", "c@1"], ["b@1", "c@1", "d@1"])).toEqual(["b@1", "c@1"]);
  });

  it("brokers nothing for a package with no active generation on record", () => {
    // Undefined rather than an empty array is the honest shape for "no generation found", and it must not be
    // read as "granted everything".
    expect(brokeredCapabilities(["a@1"], undefined)).toEqual([]);
  });

  it("brokers nothing a package never asked for, even if it was granted for another reason", () => {
    expect(brokeredCapabilities([], ["a@1"])).toEqual([]);
  });
});

describe("brokering only what can run now", () => {
  const preflight = (ref: string) =>
    ref === "mail.send@1"
      ? { ready: false as const, code: "CAPABILITY_NOT_AUTHENTICATED", message: "mail.send@1 needs a connection before it can run" }
      : { ready: true as const };

  it("holds back a granted capability that is not ready, and says why", () => {
    expect(readyCapabilities(["calendar.read@1", "mail.send@1"], preflight)).toEqual({
      ready: ["calendar.read@1"],
      unavailable: [
        { ref: "mail.send@1", code: "CAPABILITY_NOT_AUTHENTICATED", message: "mail.send@1 needs a connection before it can run" },
      ],
    });
  });

  it("brokers everything granted when everything is ready", () => {
    expect(readyCapabilities(["calendar.read@1"], preflight)).toEqual({ ready: ["calendar.read@1"], unavailable: [] });
  });
});
