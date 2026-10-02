import { describe, expect, it } from "vitest";

import {
  browserTokenIssueBodySchema,
  browserTokenRequestSchema,
  isPersonOnlyRoute,
  manifestProblems,
  packageManifestSchema,
} from "../src/index.ts";

const manifest = (browserTokens: unknown) => ({
  schemaVersion: 2,
  id: "com.example.maps",
  version: "1.0.0",
  displayName: "Maps",
  description: "Shows a map.",
  hostApi: { min: 1, max: 1 },
  facets: [
    {
      kind: "ui",
      id: "com.example.maps.view@1",
      entry: "ui/index.html",
      definition: "ui/widget.json",
      isolation: "isolated-ui",
      ...(browserTokens === undefined ? {} : { browserTokens }),
    },
  ],
  requestedCapabilities: [],
  permissions: { networkOrigins: ["https://tiles.maps.example"], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
  platforms: ["web"],
});

const declared = { version: 1, providers: [{ provider: "example.maps", scopes: ["tiles:read"], purpose: "Draw the map tiles" }] };

describe("a UI facet's browser-token declaration", () => {
  it("is optional, and accepted when it names providers, scopes and a purpose", () => {
    expect(packageManifestSchema.safeParse(manifest(undefined)).success).toBe(true);
    const parsed = packageManifestSchema.parse(manifest(declared));
    expect(manifestProblems(parsed)).toEqual([]);
  });

  it("refuses a declaration with no scopes, no purpose, an unknown version or an invalid provider id", () => {
    for (const bad of [
      { ...declared, version: 2 },
      { version: 1, providers: [] },
      { version: 1, providers: [{ provider: "example.maps", scopes: [], purpose: "Draw" }] },
      { version: 1, providers: [{ provider: "example.maps", scopes: ["tiles:read"], purpose: "" }] },
      { version: 1, providers: [{ provider: "Example Maps", scopes: ["tiles:read"], purpose: "Draw" }] },
      { version: 1, providers: [{ provider: "example.maps", scopes: ["tiles read"], purpose: "Draw" }] },
    ]) {
      expect(packageManifestSchema.safeParse(manifest(bad)).success).toBe(false);
    }
  });

  it("names a provider or scope declared twice", () => {
    const parsed = packageManifestSchema.parse(
      manifest({
        version: 1,
        providers: [
          { provider: "example.maps", scopes: ["tiles:read", "tiles:read"], purpose: "Draw" },
          { provider: "example.maps", scopes: ["geocode:read"], purpose: "Search" },
        ],
      }),
    );
    expect(manifestProblems(parsed)).toEqual([
      "facet com.example.maps.view@1: browserTokens provider example.maps names the scope tiles:read twice",
      "facet com.example.maps.view@1: browserTokens provider example.maps is declared twice",
    ]);
  });
});

describe("a browser-token request", () => {
  it("bounds the lifetime and requires a host-chosen session id", () => {
    expect(browserTokenRequestSchema.safeParse({ provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 3_601 }).success).toBe(false);
    expect(browserTokenRequestSchema.safeParse({ provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 29 }).success).toBe(false);
    expect(
      browserTokenIssueBodySchema.safeParse({ session: "short", request: { provider: "example.maps", scopes: ["tiles:read"] } }).success,
    ).toBe(false);
    expect(
      browserTokenIssueBodySchema.safeParse({
        session: "0123456789abcdef0123",
        request: { provider: "example.maps", scopes: ["tiles:read"] },
      }).success,
    ).toBe(true);
  });

  it("is asked for only by the person's own surface, never relayed by a machine surface", () => {
    expect(isPersonOnlyRoute("POST", "/conversations/conv_1/widgets/inst_1/browser-tokens")).toBe(true);
    expect(isPersonOnlyRoute("post", "//conversations/conv_1//widgets/inst_1/browser-tokens?x=1")).toBe(true);
    // Ending a frame's tokens is not a grant, so any surface may ask for it.
    expect(isPersonOnlyRoute("DELETE", "/conversations/conv_1/widgets/inst_1/browser-tokens/0123456789abcdef")).toBe(false);
  });
});
