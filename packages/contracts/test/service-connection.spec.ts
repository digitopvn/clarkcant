import { describe, expect, it } from "vitest";

import {
  connectionCapabilityProblem,
  declaredReachIsEmpty,
  declaredReachMismatch,
  declaredReachOf,
  isPersonOnlyRoute,
  manifestProblems,
  packageManifestSchema,
  serviceConnectionProblems,
  serviceConnectionSchema,
} from "../src/index.ts";

const connection = {
  version: 1,
  provider: "example.tasks",
  displayName: "Example Tasks",
  flow: "oauth-pkce",
  authorization: {
    authorizationEndpoint: "https://auth.tasks.example/authorize",
    tokenEndpoint: "https://auth.tasks.example/token",
    revocationEndpoint: "https://auth.tasks.example/revoke",
    clientId: "public-client-id",
  },
  scopes: [
    { scope: "tasks.read", purpose: "Lists your tasks." },
    { scope: "tasks.write", purpose: "Renames a task when you ask." },
  ],
  endpoints: ["https://api.tasks.example"],
  probe: { url: "https://api.tasks.example/me" },
};

const service = (overrides: Record<string, unknown> = {}, capabilities?: unknown[]) =>
  Object.fromEntries(Object.entries(facet(overrides, capabilities)).filter(([, value]) => value !== undefined));

const facet = (overrides: Record<string, unknown>, capabilities?: unknown[]) => ({
  kind: "tools",
  id: "com.example.tasks.tools@1",
  entry: "service/server.mjs",
  isolation: "service",
  protocol: "mcp-stdio",
  capabilities: capabilities ?? [
    { tool: "list", ref: "com.example.tasks.list@1", summary: "Lists tasks.", effectCategory: "read", requiredScopes: ["tasks.read"] },
    {
      tool: "update",
      ref: "com.example.tasks.update@1",
      summary: "Renames a task.",
      effectCategory: "external-write",
      requiredScopes: ["tasks.write"],
    },
  ],
  connection,
  ...overrides,
});

const manifest = (facet: unknown) => ({
  schemaVersion: 2,
  id: "com.example.tasks",
  version: "1.0.0",
  displayName: "Tasks",
  description: "Works on a task list at a provider.",
  hostApi: { min: 1, max: 1 },
  facets: [facet],
  requestedCapabilities: [],
  permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
  platforms: ["web"],
});

describe("a service's connection requirement", () => {
  it("reads a coherent declaration with per-capability scopes", () => {
    const parsed = packageManifestSchema.parse(manifest(service()));
    expect(manifestProblems(parsed)).toEqual([]);
    const facet = parsed.facets[0];
    expect(facet?.kind === "tools" ? facet.connection?.provider : undefined).toBe("example.tasks");
    expect(facet?.kind === "tools" ? facet.capabilities[1]?.requiredScopes : undefined).toEqual(["tasks.write"]);
  });

  it("is optional, so a service without one reads exactly as before", () => {
    const parsed = packageManifestSchema.parse(manifest(service({ connection: undefined }, [
      { tool: "list", ref: "com.example.tasks.list@1", summary: "Lists tasks.", effectCategory: "read" },
    ])));
    expect(parsed.facets[0]).not.toHaveProperty("connection");
    expect(manifestProblems(parsed)).toEqual([]);
  });

  it("refuses endpoints a credential would travel to in the clear, and a client secret field", () => {
    expect(serviceConnectionSchema.safeParse({ ...connection, endpoints: ["http://api.tasks.example"] }).success).toBe(false);
    expect(
      serviceConnectionSchema.safeParse({
        ...connection,
        authorization: { ...connection.authorization, tokenEndpoint: "http://auth.tasks.example/token" },
      }).success,
    ).toBe(false);
    expect(
      serviceConnectionSchema.safeParse({
        ...connection,
        authorization: { ...connection.authorization, clientSecret: "never-in-a-manifest" },
      }).success,
    ).toBe(false);
    // Loopback is the one plain-http exception: the traffic never leaves the machine.
    expect(
      serviceConnectionSchema.safeParse({
        ...connection,
        endpoints: ["http://127.0.0.1:8880"],
        probe: { url: "http://127.0.0.1:8880/me" },
      }).success,
    ).toBe(true);
  });

  it("refuses a flow other than PKCE and a scope with a space in it", () => {
    expect(serviceConnectionSchema.safeParse({ ...connection, flow: "oauth-server-code" }).success).toBe(false);
    expect(serviceConnectionSchema.safeParse({ ...connection, scopes: [{ scope: "a b", purpose: "Two." }] }).success).toBe(false);
  });

  it("names a probe off the endpoints and a repeated scope", () => {
    const parsed = serviceConnectionSchema.parse({
      ...connection,
      scopes: [...connection.scopes, { scope: "tasks.read", purpose: "Again." }],
      probe: { url: "https://elsewhere.example/me" },
    });
    expect(serviceConnectionProblems(parsed)).toEqual([
      "scope tasks.read is declared twice",
      "probe https://elsewhere.example/me is not on one of the declared endpoints",
    ]);
  });

  it("names a capability scope the connection does not request, and a scope with no connection", () => {
    const undeclared = packageManifestSchema.parse(
      manifest(
        service({}, [
          { tool: "list", ref: "com.example.tasks.list@1", summary: "Lists.", effectCategory: "read", requiredScopes: ["tasks.admin"] },
        ]),
      ),
    );
    expect(manifestProblems(undeclared)).toEqual([
      "facet com.example.tasks.tools@1: capability com.example.tasks.list@1 requires scope tasks.admin, which the connection does not request",
    ]);
    const none = packageManifestSchema.parse(
      manifest(
        service({ connection: undefined }, [
          { tool: "list", ref: "com.example.tasks.list@1", summary: "Lists.", effectCategory: "read", requiredScopes: ["tasks.read"] },
        ]),
      ),
    );
    expect(manifestProblems(none)).toEqual([
      "facet com.example.tasks.tools@1: capability com.example.tasks.list@1 requires scope tasks.read, but the facet declares no connection",
    ]);
  });

  it("refuses an origin that would carry both an egress secret and the connection's token", () => {
    const parsed = packageManifestSchema.parse(
      manifest(
        service({
          egress: {
            version: 1,
            secrets: [],
            origins: [{ origin: "https://api.tasks.example", purpose: "Also this." }],
          },
        }),
      ),
    );
    expect(manifestProblems(parsed)).toEqual([
      "facet com.example.tasks.tools@1: https://api.tasks.example is both an egress origin and a connection endpoint",
    ]);
  });
});

describe("a capability's readiness on a connection", () => {
  const status = { displayName: "Example Tasks", grantedScopes: ["tasks.read"] };

  it("is ready when every scope it needs was granted", () => {
    expect(connectionCapabilityProblem({ ...status, state: "partial" }, ["tasks.read"])).toBeUndefined();
    expect(connectionCapabilityProblem({ ...status, state: "connected" }, [])).toBeUndefined();
  });

  it("names the missing scope on a partial grant", () => {
    expect(connectionCapabilityProblem({ ...status, state: "partial" }, ["tasks.write"])).toBe(
      "the Example Tasks account did not grant tasks.write; reconnect it in Settings and allow it",
    );
  });

  it("says why for every state that is not usable", () => {
    expect(connectionCapabilityProblem({ ...status, state: "not-connected" }, [])).toMatch(/not connected/);
    expect(connectionCapabilityProblem({ ...status, state: "expired" }, ["tasks.read"])).toMatch(/expired/);
    expect(connectionCapabilityProblem({ ...status, state: "revoked" }, ["tasks.read"])).toMatch(/revoked/);
  });
});

describe("who may start a connection", () => {
  it("is the person: a relay or MCP refuses the connect route, and still lets status be read", () => {
    expect(isPersonOnlyRoute("POST", "/packages/com.example.tasks/connection")).toBe(true);
    expect(isPersonOnlyRoute("POST", "//packages//com.example.tasks/connection/?x=1")).toBe(true);
    expect(isPersonOnlyRoute("GET", "/packages/com.example.tasks/connection")).toBe(false);
  });
});

describe("the reach a connection declares", () => {
  it("is shown before install, and a listing that omits it is a mismatch", () => {
    const parsed = packageManifestSchema.parse(manifest(service()));
    const reach = declaredReachOf(parsed);
    expect(declaredReachIsEmpty(reach)).toBe(false);
    expect(reach.connections).toEqual([
      {
        provider: "example.tasks",
        displayName: "Example Tasks",
        scopes: [
          { scope: "tasks.read", purpose: "Lists your tasks." },
          { scope: "tasks.write", purpose: "Renames a task when you ask." },
        ],
        endpoints: ["https://api.tasks.example"],
      },
    ]);
    expect(declaredReachMismatch(undefined, reach)).toBe("the listing does not show the accounts it connects to as the package declares them");
    expect(declaredReachMismatch(reach, reach)).toBeUndefined();
  });

  it("keeps the form it always had for a package that connects to nothing", () => {
    const parsed = packageManifestSchema.parse(manifest(service({ connection: undefined }, [
      { tool: "list", ref: "com.example.tasks.list@1", summary: "Lists tasks.", effectCategory: "read" },
    ])));
    expect(declaredReachOf(parsed)).toEqual({ origins: [], secrets: [], browserTokens: [] });
  });
});
