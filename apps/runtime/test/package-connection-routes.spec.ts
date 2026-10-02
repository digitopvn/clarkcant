import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { createPackageConnectionBroker } from "../src/package-connections.ts";
import { SURFACE_HEADER } from "../src/routes/http.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { startFakeConnector } from "../../../examples/reference-apps/connected-app/dev/fake-connector.mjs";

/**
 * The routes Settings drives to connect a package's account, through the gateway as a client calls them: who may start
 * a connection and from where, the public callback the system browser lands on, status and revoke. The provider is the
 * reference app's fake connector, a test fixture.
 */

const REFERENCE = fileURLToPath(new URL("../../../examples/reference-apps/connected-app", import.meta.url));
const PACKAGE_ID = "com.clarkcant.reference.connected-app";
const DIGEST = "sha256:connected-app-routes";

type Connector = Awaited<ReturnType<typeof startFakeConnector>>;

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let connector: Connector;
let previousIndex: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-connection-routes-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  connector = await startFakeConnector();
  services.connections = createPackageConnectionBroker({
    db: services.runtime.db,
    principalId: services.runtime.identity.ownerPrincipalId,
    newId: services.conductor.newId,
    allowPrivateNetwork: true,
    audit: () => undefined,
  });
  const now = new Date().toISOString();
  deps = { services, now: () => now, newConversationId: () => "conv_connection_routes" };
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  install(now);
});

afterEach(async () => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  await connector.close();
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The reference app, installed on this node and listed in its directory, its provider moved to the fake's port. */
function install(now: string): void {
  const root = join(dir, "package");
  cpSync(REFERENCE, root, { recursive: true });
  const manifestPath = join(root, "clarkcant.json");
  writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replaceAll("http://127.0.0.1:8880", connector.origin));
  const generationId = "gen_connected_app";
  const generation = {
    generationId,
    packageId: PACKAGE_ID,
    version: "1.0.0",
    digest: DIGEST,
    nodeId: services.runtime.identity.nodeId,
    codeGeneration: "code-1",
    activatedAt: now,
    uiOnlyFacets: [],
    grantedCapabilities: [],
  };
  services.runtime.db
    .prepare(
      `INSERT INTO package_generations
         (generation_id, package_id, version, digest, node_id, code_generation, activated_at, superseded_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(generationId, PACKAGE_ID, "1.0.0", DIGEST, generation.nodeId, "code-1", now, JSON.stringify(generation));
  const indexPath = join(dir, "directory.json");
  writeFileSync(
    indexPath,
    JSON.stringify([
      {
        packageId: PACKAGE_ID,
        version: "1.0.0",
        displayName: "Connected tasks",
        description: "The reference connected app.",
        source: { kind: "local", path: root },
        publisher: { id: "clarkcant", sourceUrl: "https://github.com/digitopvn/clarkcant", license: "Apache-2.0" },
        preview: {},
        facets: ["ui", "tools", "skills"],
        isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
        platforms: ["linux-x64", "darwin-arm64", "win32-x64"],
        hostApi: { min: 1, max: 1 },
        permissionsSummary: [],
        riskTier: "isolated-ui",
        sizeBytes: 512,
        digest: DIGEST,
      },
    ]),
  );
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
}

function call(method: string, path: string, options: { headers?: Record<string, string>; query?: Record<string, string>; token?: boolean } = {}) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== false) headers["authorization"] = `Bearer ${services.runtime.identity.localToken}`;
  return handleRequest(deps, { method, path, query: options.query ?? {}, headers, body: "" });
}

const CONNECTION = `/packages/${encodeURIComponent(PACKAGE_ID)}/connection`;

function page(response: GatewayResponse): string {
  return response.binary === undefined ? "" : Buffer.from(response.binary.bytes).toString("utf8");
}

function body(response: GatewayResponse): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

function state(response: GatewayResponse): unknown {
  return (body(response)["connection"] as { state?: unknown } | undefined)?.state;
}

describe("the connection routes", () => {
  it("refuse to start a connection for a machine surface, as person-only", async () => {
    for (const surface of ["mcp", "relay"]) {
      const response = await call("POST", CONNECTION, { headers: { host: "127.0.0.1:7777", [SURFACE_HEADER]: surface } });
      expect(response.status, surface).toBe(403);
      expect(body(response)["code"]).toBe("PERSON_ONLY");
    }
  });

  it("start a connection only on the node's own machine, where the browser can come back over loopback", async () => {
    const remote = await call("POST", CONNECTION, { headers: { host: "192.168.1.20:7777" } });
    expect(remote.status).toBe(409);
    expect(body(remote)["code"]).toBe("CONNECT_ON_THIS_MACHINE");

    const local = await call("POST", CONNECTION, { headers: { host: "127.0.0.1:7777" } });
    expect(local.status).toBe(200);
    const url = new URL(String(body(local)["authorizationUrl"]));
    expect(url.origin).toBe(connector.origin);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:7777/connections/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("tasks.read tasks.write");
  });

  it("answer a package that declares no connection, or is not installed, plainly", async () => {
    const missing = await call("GET", `/packages/${encodeURIComponent("com.example.absent")}/connection`);
    expect(missing.status).toBe(404);
    expect(body(missing)["code"]).toBe("NOT_INSTALLED");
  });

  it("connect through the public callback, report only status, and revoke at once", async () => {
    expect(state(await call("GET", CONNECTION))).toBe("not-connected");

    const started = await call("POST", CONNECTION, { headers: { host: "127.0.0.1:7777" } });
    const consent = await fetch(String(body(started)["authorizationUrl"]), { redirect: "manual" });
    const back = new URL(consent.headers.get("location") ?? "");
    const query = Object.fromEntries(back.searchParams.entries());
    expect(query["code"]).toBeTruthy();

    // A browser following the redirect carries no token; the single-use state is what authenticates it.
    const landed = await call("GET", "/connections/callback", { query, token: false });
    expect(landed.status).toBe(200);
    const html = page(landed);
    expect(html).toContain('data-connection-result="connected"');
    expect(html).not.toContain(query["code"]);
    expect(html).not.toContain(query["state"]);
    expect(landed.binary?.headers?.["referrer-policy"]).toBe("no-referrer");

    // The same state cannot be used twice.
    const replayed = await call("GET", "/connections/callback", { query, token: false });
    expect(replayed.status).toBe(400);

    const status = await call("GET", CONNECTION);
    expect(state(status)).toBe("connected");
    const serialized = JSON.stringify(status.body);
    for (const secret of connector.secrets()) expect(serialized).not.toContain(secret);

    const revoked = await call("POST", `${CONNECTION}/revoke`);
    expect(revoked.status).toBe(200);
    expect(state(revoked)).toBe("revoked");
    expect(state(await call("GET", CONNECTION))).toBe("revoked");
  });

  it("answer a forged callback with a page that never repeats the code", async () => {
    const response = await call("GET", "/connections/callback", { query: { state: "forged-state", code: "fake-code-x" }, token: false });
    expect(response.status).toBe(400);
    const html = page(response);
    expect(html).toContain('data-connection-result="failed"');
    expect(html).not.toContain("fake-code-x");
    expect(html).not.toContain("forged-state");
  });

  it("keep status and revoke behind the node's token", async () => {
    expect((await call("GET", CONNECTION, { token: false })).status).toBe(401);
    expect((await call("POST", `${CONNECTION}/revoke`, { token: false })).status).toBe(401);
  });
});
