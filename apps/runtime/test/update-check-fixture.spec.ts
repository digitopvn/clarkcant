import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inboxResponseSchema, platformForHost } from "@clarkcant/contracts";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createUpdateCheckFixture } from "../src/test-support/fixture-update-check.ts";

/**
 * The route a browser journey runs the package update check through, and the notice that check writes: unreachable
 * without its gate, and with it the production check, whose update notice says what the new version reaches beyond the
 * installed one.
 */

const PACKAGE_ID = "com.example.forecast";
const DIGEST = "sha256:forecast-1";
const FORECAST = { origin: "https://forecast.example.com", purpose: "Reads the forecast." };

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;

function entry(version: string, digest: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageId: PACKAGE_ID,
    version,
    displayName: "Forecast",
    description: "The forecast for the week.",
    source: { kind: "local", path: join(dir, "package") },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: [platformForHost(process.platform, process.arch) ?? "web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 512,
    digest,
    ...overrides,
  };
}

const send = (method: string, path: string, body?: Record<string, unknown>): Promise<GatewayResponse> =>
  handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-update-check-fixture-"));
  mkdirSync(join(dir, "package"), { recursive: true });
  writeFileSync(
    join(dir, "package", "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: PACKAGE_ID,
      version: "1.0.0",
      displayName: "Forecast",
      description: "The forecast for the week.",
      hostApi: { min: 1, max: 1 },
      facets: [{ kind: "ui", id: "com.example.forecast.week@1", entry: "widgets/week/index.html", definition: "widgets/week/widget.json", isolation: "isolated-ui" }],
      requestedCapabilities: [],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
    }),
  );
  services = bootNodeServices({ dataDir: dir, label: "update check fixture test node" });
  deps = { services, now: () => new Date().toISOString() as never };
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = join(dir, "directory.json");
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /update-check-fixture/run", () => {
  it("is not there on a node started without its gate", async () => {
    expect((await send("POST", "/update-check-fixture/run")).status).toBe(404);
  });

  it("runs the package check once, and the notice it writes lists what the new version adds", async () => {
    services.updateCheckFixture = createUpdateCheckFixture(services);
    writeFileSync(join(dir, "directory.json"), JSON.stringify([entry("1.0.0", DIGEST)]));
    const installed = await send("POST", "/packages/install", { packageId: PACKAGE_ID, version: "1.0.0", localDigest: DIGEST });
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);

    // Nothing newer is listed: the check writes nothing.
    expect((await send("POST", "/update-check-fixture/run")).body).toEqual({ packageUpdates: 0 });

    writeFileSync(
      join(dir, "directory.json"),
      JSON.stringify([
        entry("1.0.0", DIGEST),
        entry("1.1.0", "sha256:forecast-2", { declaredReach: { origins: [FORECAST], secrets: [], browserTokens: [] } }),
      ]),
    );
    expect((await send("POST", "/update-check-fixture/run")).body).toEqual({ packageUpdates: 1 });
    expect((await send("GET", "/update-check-fixture/run")).status).toBe(404);

    const inbox = inboxResponseSchema.parse((await send("GET", "/inbox")).body);
    const notice = inbox.notices.find((item) => item.category === "update" && item.subject?.kind === "package");
    expect(notice?.subject).toMatchObject({ packageId: PACKAGE_ID, version: "1.1.0" });
    expect(notice?.reachChange).toMatchObject({ verdict: "wider", origins: { added: [FORECAST], removed: [] } });
  });
});
