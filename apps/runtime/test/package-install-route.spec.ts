import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { platformForHost } from "@clarkcant/contracts";
import { setPreference } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Installing from the directory.
 *
 * The route the marketplace reaches, and the reason it is worth testing at this level rather than only in the
 * supervisor it calls: every refusal below has to arrive with the code the resolver already uses, because a caller
 * that has to interpret a second vocabulary is how a marketplace becomes a second install path.
 *
 * The refusals are tested as carefully as the success. A route that installs is only half of what this has to be;
 * the other half is that the four ways a package can be wrong — the wrong platform, no digest, a host API the
 * package does not support, an entry the directory does not have — all stop before anything is fetched.
 */

const AT = "2026-09-20T05:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let indexPath: string;
let previousIndex: string | undefined;

/** The platform this test is running on, in the vocabulary packages and hosts share. */
const HOST_PLATFORM = platformForHost(process.platform, process.arch);

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageId: "com.example.calendar",
    version: "1.2.0",
    displayName: "Calendar Plus",
    description: "A compact agenda and week view.",
    source: { kind: "npm", name: "com.example.calendar", version: "1.2.0" },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    // Whatever this machine is, so the success case is about installing rather than about the test's platform.
    platforms: [HOST_PLATFORM ?? "web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "isolated-ui",
    sizeBytes: 40_960,
    digest: "sha256:published-digest",
    ...overrides,
  };
}

function writeIndex(entries: readonly Record<string, unknown>[]): void {
  writeFileSync(indexPath, JSON.stringify(entries));
}

async function install(body: Record<string, unknown>): Promise<GatewayResponse> {
  const request: GatewayRequest = {
    method: "POST",
    path: "/packages/install",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: JSON.stringify(body),
  };
  return handleRequest(deps, request);
}

/** The activity route flattens each event to the fields the Control tab shows. */
async function activity(): Promise<{ effects: { kind?: string; category?: string; description?: string }[] }> {
  const request: GatewayRequest = {
    method: "GET",
    path: "/activity",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: "",
  };
  const response = await handleRequest(deps, request);
  return response.body as { effects: { kind?: string; category?: string; description?: string }[] };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-install-"));
  indexPath = join(dir, "directory.json");
  services = bootNodeServices({ dataDir: dir, label: "install route test node" });
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

describe("installing from the directory", () => {
  it("installs a listed package and says what it verified", async () => {
    writeIndex([entry()]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect((body["installed"] as Record<string, unknown>)["packageId"]).toBe("com.example.calendar");
    expect(String(body["generationId"])).toContain("com.example.calendar@1.2.0");
    expect(body["state"]).toBe("active");
    /*
     * Named rather than implied. This node does not fetch or run the artifact, so "active" means the plan was bound
     * to a published digest — not that the package is known to work, and a reader should not have to guess which.
     */
    expect(body["verified"]).toBe("digest-only");
  });

  it("records the effect it performed without a card", async () => {
    writeIndex([entry()]);
    await install({ packageId: "com.example.calendar", version: "1.2.0" });

    // Autonomy without a record is the one combination this node refuses, so the record is part of the contract.
    const listed = await activity();
    const installed = listed.effects.filter(
      (effect) => effect.kind === "effect.executed" && effect.description === "install com.example.calendar@1.2.0",
    );
    expect(installed).toHaveLength(1);
    expect(installed[0]?.category).toBe("local-write");
  });

  it("asks first when the policy says to, and installs nothing", async () => {
    writeIndex([entry()]);
    setPreference(
      { db: services.runtime.db, now: () => AT as never },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: "execution.mode",
        scope: "global",
        value: "ask",
        source: "user",
      },
    );

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    // 202 rather than an error: nothing failed, and the approval is the next step.
    expect(response.status).toBe(202);
    const body = response.body as Record<string, unknown>;
    expect(body["code"]).toBe("APPROVAL_REQUIRED");
    expect(typeof body["approvalId"]).toBe("string");
    // Nothing was installed, and nothing claims it was.
    expect(JSON.stringify(body)).not.toContain("generationId");
  });
});

describe("what the route refuses, with the code the resolver already uses", () => {
  it("refuses a package built for another platform, naming both sides", async () => {
    // The one platform this host is not, whatever this host is.
    const elsewhere = HOST_PLATFORM === "darwin-arm64" ? "linux-x64" : "darwin-arm64";
    writeIndex([entry({ platforms: [elsewhere] })]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(400);
    const body = response.body as Record<string, unknown>;
    expect(body["code"]).toBe("PLATFORM_MISMATCH");
    // Both facts, so the message reads as "built for another machine" rather than as a malformed package.
    expect(String(body["message"])).toContain(elsewhere);
    expect(String(body["message"])).toContain(HOST_PLATFORM ?? "unknown");
  });

  it("refuses an entry that publishes no digest", async () => {
    // A space passes "at least one character" and is still no digest; "no digest" must never behave like "matched".
    writeIndex([entry({ digest: " " })]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(400);
    expect((response.body as Record<string, unknown>)["code"]).toBe("DIGEST_MISMATCH");
  });

  it("refuses a package needing a host API this node does not implement", async () => {
    writeIndex([entry({ hostApi: { min: 9, max: 10 } })]);

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    expect(response.status).toBe(400);
    expect((response.body as Record<string, unknown>)["code"]).toBe("HOST_API_MISMATCH");
  });

  it("refuses a package the directory does not list", async () => {
    writeIndex([entry()]);

    const response = await install({ packageId: "com.example.other", version: "1.2.0" });

    expect(response.status).toBe(404);
    expect((response.body as Record<string, unknown>)["code"]).toBe("NOT_IN_DIRECTORY");
  });

  it("says the directory is unconfigured rather than that the package is missing", async () => {
    delete process.env["CC_DIRECTORY_INDEX"];

    const response = await install({ packageId: "com.example.calendar", version: "1.2.0" });

    // Two different truths, and only one of them is the user's to fix.
    expect(response.status).toBe(409);
    const body = response.body as Record<string, unknown>;
    expect(body["code"]).toBe("NO_DIRECTORY");
    expect(String(body["message"])).toContain("CC_DIRECTORY_INDEX");
  });

  it("refuses a request that does not say what to install", async () => {
    writeIndex([entry()]);

    const response = await install({ packageId: "com.example.calendar" });

    expect(response.status).toBe(400);
    expect((response.body as Record<string, unknown>)["code"]).toBe("INVALID_SCHEMA");
  });
});
