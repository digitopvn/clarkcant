import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Serving a package's own files.
 *
 * A widget that runs in its own frame is loaded by URL, so the frame fetches the widget's files from here. That makes
 * this route the one place where a package's bytes become a response, and the two things worth checking are the two
 * ways that goes wrong: a path that escapes the package, and a package whose bytes this node does not have.
 *
 * The traversal case is the reason the check is on the *resolved* path rather than on the string that arrived —
 * `widgets/../../../../secrets` reads like a path inside a package and is not one.
 */

const AT = "2026-09-20T06:00:00.000Z";
const SECRET = "a file that is not in any package\n";

let dir: string;
let packageRoot: string;
let indexPath: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;
let previousAppOrigin: string | undefined;

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageId: "com.example.widget",
    version: "1.0.0",
    displayName: "Example widget",
    description: "A widget with files.",
    source: { kind: "local", path: packageRoot },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 1024,
    digest: "sha256:widget-digest",
    ...overrides,
  };
}

async function get(path: string): Promise<GatewayResponse> {
  const request: GatewayRequest = {
    method: "GET",
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: "",
  };
  return handleRequest(deps, request);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-files-"));
  packageRoot = join(dir, "package");
  indexPath = join(dir, "directory.json");
  mkdirSync(join(packageRoot, "widgets", "main"), { recursive: true });
  writeFileSync(join(packageRoot, "widgets", "main", "index.html"), "<!doctype html><p>widget</p>\n");
  writeFileSync(join(packageRoot, "widgets", "main", "main.js"), "export const x = 1;\n");
  // Outside the package, and reachable by a path that starts inside it.
  writeFileSync(join(dir, "outside.txt"), SECRET);
  writeFileSync(indexPath, JSON.stringify([entry()]));

  services = bootNodeServices({ dataDir: dir, label: "files route test node" });
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

describe("serving a package file", () => {
  it("serves a file from inside the package, with the type the frame needs", async () => {
    const response = await get("/packages/com.example.widget/1.0.0/files/widgets/main/index.html");

    expect(response.status).toBe(200);
    expect(response.binary?.contentType).toBe("text/html; charset=utf-8");
    expect(Buffer.from(response.binary?.bytes ?? []).toString("utf8")).toContain("widget");
  });

  it("names a script as a script, so the frame can load it as a module", async () => {
    const response = await get("/packages/com.example.widget/1.0.0/files/widgets/main/main.js");

    expect(response.status).toBe(200);
    expect(response.binary?.contentType).toBe("text/javascript; charset=utf-8");
  });

  it("refuses a path that escapes the package, resolved rather than read literally", async () => {
    // `widgets/../../outside.txt` normalises to `../outside.txt`: a path that starts inside the package and is not.
    const response = await get("/packages/com.example.widget/1.0.0/files/widgets/../../outside.txt");

    expect(response.status).toBe(403);
    expect((response.body as Record<string, unknown>)["code"]).toBe("FILE_OUTSIDE_PACKAGE");
    expect(JSON.stringify(response.binary ?? {})).not.toContain("not in any package");
  });

  it("says there is no such file rather than serving something else", async () => {
    const response = await get("/packages/com.example.widget/1.0.0/files/widgets/main/missing.js");

    expect(response.status).toBe(404);
    expect((response.body as Record<string, unknown>)["code"]).toBe("FILE_NOT_FOUND");
  });

  it("refuses to serve a package whose bytes this node does not have", async () => {
    writeFileSync(
      indexPath,
      JSON.stringify([entry({ source: { kind: "npm", name: "com.example.widget", version: "1.0.0" } })]),
    );

    const response = await get("/packages/com.example.widget/1.0.0/files/widgets/main/index.html");

    // Serving it would mean proxying whatever that source returns, which is a different and much larger thing.
    expect(response.status).toBe(409);
    expect((response.body as Record<string, unknown>)["code"]).toBe("NOT_A_LOCAL_PACKAGE");
  });

  it("refuses a package the directory does not list", async () => {
    const response = await get("/packages/com.example.other/1.0.0/files/widgets/main/index.html");

    expect(response.status).toBe(404);
    expect((response.body as Record<string, unknown>)["code"]).toBe("NOT_IN_DIRECTORY");
  });

  it("says the directory is unconfigured rather than that the file is missing", async () => {
    delete process.env["CC_DIRECTORY_INDEX"];

    const response = await get("/packages/com.example.widget/1.0.0/files/widgets/main/index.html");

    expect(response.status).toBe(409);
    expect((response.body as Record<string, unknown>)["code"]).toBe("NO_DIRECTORY");
  });

  it("requires the token like every other route", async () => {
    const request: GatewayRequest = {
      method: "GET",
      path: "/packages/com.example.widget/1.0.0/files/widgets/main/index.html",
      query: {},
      headers: {},
      body: "",
    };

    const response = await handleRequest(deps, request);

    expect(response.status).toBe(401);
  });
});

/**
 * The policy the widget entry is served under.
 *
 * The `sandbox` attribute keeps the frame from reaching the host, but the document itself is code the host agreed to
 * run, and the policy is what keeps that agreement narrow: no network, no forms, no base URL rewriting, and exactly
 * one inline script — the bootstrap — admitted by a nonce minted for this one response.
 *
 * The nonce is the point. A policy that admits `'unsafe-inline'` is a hole; a policy that names a *different* nonce
 * than the document carries is worse, because it fails silently: the frame loads, the bridge never starts, and the
 * widget looks like one that has not loaded yet.
 */
describe("the policy the widget entry is served under", () => {
  const APP_ORIGIN = "http://app.example.test";

  beforeEach(() => {
    previousAppOrigin = process.env["CC_APP_ORIGIN"];
    process.env["CC_APP_ORIGIN"] = APP_ORIGIN;
  });

  afterEach(() => {
    if (previousAppOrigin === undefined) delete process.env["CC_APP_ORIGIN"];
    else process.env["CC_APP_ORIGIN"] = previousAppOrigin;
  });

  it("admits the bootstrap by the nonce the document actually carries, and nothing else inline", async () => {
    const response = await get("/packages/com.example.widget/1.0.0/files/widgets/main/index.html");

    const policy = response.binary?.headers?.["content-security-policy"];
    expect(policy).toBeDefined();

    const html = Buffer.from(response.binary?.bytes ?? []).toString("utf8");
    const nonce = /<script type="module" nonce="([^"]+)"/.exec(html)?.[1];
    expect(nonce).toBeTruthy();

    // The same nonce in the header and in the document, which is the only reason the bridge runs at all.
    expect(policy).toContain(`script-src 'nonce-${String(nonce)}' 'self'`);

    const scriptSource = /script-src [^;]+/.exec(policy ?? "")?.[0] ?? "";
    expect(scriptSource).not.toContain("unsafe-inline");
    expect(scriptSource).not.toContain("unsafe-eval");
    // No wildcard, and no origin beyond the node that served this document and the app that frames it.
    expect(scriptSource).not.toContain("*");
  });

  it("closes what the document does not need, and lets only the app frame it", async () => {
    const response = await get("/packages/com.example.widget/1.0.0/files/widgets/main/index.html");
    const policy = response.binary?.headers?.["content-security-policy"] ?? "";

    for (const directive of [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${APP_ORIGIN}`,
      // The package declared no origins, so none are reachable: a widget's data arrives over the bridge.
      "connect-src 'none'",
    ]) {
      expect(policy).toContain(directive);
    }
  });
});
