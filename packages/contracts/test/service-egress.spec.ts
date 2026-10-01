import { describe, expect, it } from "vitest";

import {
  egressFetchRequestSchema,
  egressHeaderProblem,
  manifestProblems,
  packageManifestSchema,
  serviceEgressProblems,
  serviceEgressSchema,
} from "../src/index.ts";

const service = (egress: unknown) => ({
  kind: "tools",
  id: "com.example.search.tools@1",
  entry: "service/index.mjs",
  isolation: "service",
  protocol: "mcp-stdio",
  capabilities: [{ tool: "search", ref: "com.example.search.query@1", summary: "Searches.", effectCategory: "read" }],
  ...(egress === undefined ? {} : { egress }),
});

const manifest = (egress: unknown) => ({
  schemaVersion: 2,
  id: "com.example.search",
  version: "1.0.0",
  displayName: "Search",
  description: "Searches a provider.",
  hostApi: { min: 1, max: 1 },
  facets: [service(egress)],
  requestedCapabilities: [],
  permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
  platforms: ["web"],
});

const coherent = {
  version: 1,
  secrets: [{ name: "SEARCH_API_KEY", purpose: "Authenticates searches with the provider." }],
  origins: [
    {
      origin: "https://api.search.example",
      purpose: "Runs the searches you ask for.",
      credential: { secret: "SEARCH_API_KEY", header: "authorization", scheme: "bearer" },
    },
    { origin: "https://cdn.search.example", purpose: "Fetches result thumbnails." },
  ],
};

describe("a service's egress declaration", () => {
  it("is optional, so a service that declares none reads exactly as before", () => {
    const parsed = packageManifestSchema.parse(manifest(undefined));
    expect(parsed.facets[0]).not.toHaveProperty("egress");
    expect(manifestProblems(parsed)).toEqual([]);
  });

  it("reads a coherent declaration of origins and the secrets added to them", () => {
    const parsed = packageManifestSchema.parse(manifest(coherent));
    expect(manifestProblems(parsed)).toEqual([]);
    const facet = parsed.facets[0];
    expect(facet?.kind === "tools" ? facet.egress?.origins[0]?.credential : undefined).toEqual({
      secret: "SEARCH_API_KEY",
      header: "authorization",
      scheme: "bearer",
    });
  });

  it("names secrets and never carries a value", () => {
    expect(
      serviceEgressSchema.safeParse({ ...coherent, secrets: [{ name: "SEARCH_API_KEY", purpose: "x", value: "inline" }] }).success,
    ).toBe(false);
    expect(
      serviceEgressSchema.safeParse({
        ...coherent,
        origins: [{ origin: "https://api.search.example", purpose: "x", credential: { secret: "SEARCH_API_KEY", header: "authorization", scheme: "bearer", value: "inline" } }],
      }).success,
    ).toBe(false);
  });

  it("refuses an origin that is not exactly one https origin, or loopback http", () => {
    for (const origin of ["https://*.search.example", "https://api.search.example/v1", "http://api.search.example", "https://user:pw@api.search.example"]) {
      expect(serviceEgressSchema.safeParse({ ...coherent, origins: [{ origin, purpose: "x" }], secrets: [] }).success, origin).toBe(false);
    }
    expect(
      serviceEgressSchema.safeParse({ version: 1, secrets: [], origins: [{ origin: "http://127.0.0.1:8787", purpose: "A local provider." }] }).success,
    ).toBe(true);
  });

  it("refuses a credential header the host's HTTP client owns", () => {
    for (const header of ["host", "Cookie", "content-length", "proxy-authorization", "sec-fetch-mode", "x-forwarded-for", "bad header"]) {
      expect(egressHeaderProblem(header), header).toBeDefined();
      const origins = [{ origin: "https://api.search.example", purpose: "x", credential: { secret: "SEARCH_API_KEY", header, scheme: "raw" } }];
      expect(serviceEgressSchema.safeParse({ ...coherent, origins }).success, header).toBe(false);
    }
    expect(egressHeaderProblem("x-api-key")).toBeUndefined();
    expect(egressHeaderProblem("Authorization")).toBeUndefined();
  });

  it("reports, by field, a credential naming an undeclared secret, duplicates, unused secrets and websocket origins", () => {
    const parsed = packageManifestSchema.parse(
      manifest({
        version: 1,
        secrets: [
          { name: "SEARCH_API_KEY", purpose: "x" },
          { name: "SEARCH_API_KEY", purpose: "again" },
          { name: "UNUSED", purpose: "nothing uses it" },
        ],
        origins: [
          { origin: "https://api.search.example", purpose: "x", credential: { secret: "SEARCH_API_KEY", header: "authorization", scheme: "bearer" } },
          { origin: "https://api.search.example", purpose: "twice" },
          { origin: "https://other.example", purpose: "x", credential: { secret: "MISSING", header: "x-api-key", scheme: "raw" } },
          { origin: "wss://stream.search.example", purpose: "a stream" },
        ],
      }),
    );
    expect(manifestProblems(parsed)).toEqual([
      "facet com.example.search.tools@1: egress secret SEARCH_API_KEY is declared twice",
      "facet com.example.search.tools@1: egress origin https://api.search.example is declared twice",
      "facet com.example.search.tools@1: egress origin https://other.example uses secret MISSING, which is not declared in secrets",
      "facet com.example.search.tools@1: egress origin wss://stream.search.example must be http or https; egress makes requests, not connections",
      "facet com.example.search.tools@1: egress secret UNUSED is declared but no origin uses it",
    ]);
  });

  it("checks coherence on its own, for a host that reads the facet without the manifest", () => {
    expect(serviceEgressProblems(serviceEgressSchema.parse(coherent))).toEqual([]);
  });
});

describe("the egress request a service sends the host", () => {
  it("defaults to GET and bounds what it carries", () => {
    expect(egressFetchRequestSchema.parse({ version: 1, url: "https://api.search.example/q?x=1" })).toEqual({
      version: 1,
      url: "https://api.search.example/q?x=1",
      method: "GET",
    });
    expect(egressFetchRequestSchema.safeParse({ version: 2, url: "https://api.search.example" }).success).toBe(false);
    expect(egressFetchRequestSchema.safeParse({ version: 1, url: "https://api.search.example", method: "CONNECT" }).success).toBe(false);
    expect(egressFetchRequestSchema.safeParse({ version: 1, url: `https://a.example/${"x".repeat(2_100)}` }).success).toBe(false);
    expect(
      egressFetchRequestSchema.safeParse({ version: 1, url: "https://a.example", body: { encoding: "utf8", data: "x".repeat(2 * 1024 * 1024) } }).success,
    ).toBe(false);
    expect(egressFetchRequestSchema.safeParse({ version: 1, url: "https://a.example", credential: "SEARCH_API_KEY" }).success).toBe(false);
  });
});
