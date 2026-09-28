import { networkOriginProblem, packageManifestSchema } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { resolveFrameAncestors, widgetDocumentPolicy } from "../src/widget-document.ts";

/**
 * `resolveFrameAncestors` decides what `frame-ancestors` in a widget document's CSP says.
 *
 * It used to fall back to the request's own `Host` header when `CC_APP_ORIGIN` was unset: a client-controlled value
 * deciding who may frame the document. Now the default is `'self'`, which the browser resolves from the URL the
 * document came from, and `CC_APP_ORIGIN` only ever adds one validated origin to it.
 */
describe("resolveFrameAncestors", () => {
  it("lets only the node that served the document frame it when CC_APP_ORIGIN is unset (same-origin topology)", () => {
    expect(resolveFrameAncestors(undefined)).toEqual({ ok: true, sources: "'self'" });
    expect(resolveFrameAncestors("")).toEqual({ ok: true, sources: "'self'" });
  });

  it("adds exactly the configured app origin for an interface served elsewhere (split-origin topology)", () => {
    expect(resolveFrameAncestors("https://app.example.com:4273")).toEqual({
      ok: true,
      sources: "'self' https://app.example.com:4273",
    });
  });

  it("refuses CC_APP_ORIGIN with a path, query, credentials or a second source rather than truncating it", () => {
    for (const configured of [
      "https://app.example.com/some-path",
      "https://app.example.com?x=1",
      "https://user:pass@app.example.com",
      "https://app.example.com/",
      "https://app.example.com *",
      "https://app.example.com; script-src *",
      "not a url at all",
      "javascript:alert(1)",
    ]) {
      const outcome = resolveFrameAncestors(configured);
      expect(outcome.ok, `expected ${configured} to be refused`).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("CC_APP_ORIGIN_INVALID");
    }
  });
});

/**
 * A declared network origin goes into `connect-src`, so an origin that is not exactly one origin rewrites the policy.
 * These are the cases the review probe showed getting through verbatim.
 */
describe("the network origins a package may declare", () => {
  const MALICIOUS = [
    "*",
    "https://*",
    "https://*.example.com",
    "https://api.example.com *",
    "https://x.example; report-uri https://evil.example",
    "https://x.example;report-uri",
    "https://u@api.example.com",
    "https://api.example.com/path",
    "https://api.example.com?q=1",
    "https://api.example.com#frag",
    "https://api.example.com/",
    "https://API.example.com",
    "https://api.example.com:443",
    "http://api.example.com",
    "ws://api.example.com",
    "data:",
    "'self'",
    "https://api.example.com,https://b.example",
    "https://api.example.com\nhttps://b.example",
  ];

  it("accepts an exact encrypted origin, and plain http only on loopback", () => {
    for (const origin of [
      "https://api.example.com",
      "https://api.example.com:8443",
      "wss://stream.example.com",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "ws://[::1]:3000",
    ]) {
      expect(networkOriginProblem(origin), origin).toBeUndefined();
    }
  });

  it("refuses wildcards, directive injection, credentials, paths and non-canonical forms", () => {
    for (const origin of MALICIOUS) {
      expect(networkOriginProblem(origin), JSON.stringify(origin)).toBeDefined();
    }
  });

  it("refuses a manifest that declares one, with the reason", () => {
    const manifest = {
      schemaVersion: 2,
      id: "com.example.widget",
      version: "1.0.0",
      displayName: "Widget",
      description: "A widget.",
      hostApi: { min: 1, max: 1 },
      facets: [
        {
          kind: "ui",
          id: "com.example.widget.main@1",
          entry: "widgets/main/index.html",
          definition: "widgets/main/widget.json",
          isolation: "isolated-ui",
        },
      ],
      requestedCapabilities: [],
      permissions: {
        networkOrigins: ["https://x.example; report-uri https://evil.example"],
        filesystem: [],
        microphone: false,
        camera: false,
        lifecycleScripts: [],
      },
      platforms: ["darwin-arm64"],
      dependencies: [],
    };
    const parsed = packageManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("scheme://host[:port]");

    manifest.permissions.networkOrigins = ["https://api.example.com"];
    expect(packageManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("puts exactly the declared origin in connect-src", () => {
    const policy = widgetDocumentPolicy({ frameAncestors: "'self'", nonce: "n", allowedOrigins: ["https://api.example.com"] });
    expect(policy).toContain("connect-src https://api.example.com;");
  });

  it("reaches nothing when nothing was declared", () => {
    expect(widgetDocumentPolicy({ frameAncestors: "'self'", nonce: "n" })).toContain("connect-src 'none';");
    expect(widgetDocumentPolicy({ frameAncestors: "'self'", nonce: "n", allowedOrigins: [] })).toContain(
      "connect-src 'none';",
    );
  });

  it("drops an origin that bypassed the schema instead of writing it into the policy", () => {
    const policy = widgetDocumentPolicy({
      frameAncestors: "'self'",
      nonce: "n",
      allowedOrigins: [...MALICIOUS, "https://api.example.com"],
    });
    expect(policy).toContain("connect-src https://api.example.com;");
    expect(policy).not.toContain("report-uri");
    expect(policy).not.toContain("*");
    // Every directive is one the policy itself wrote.
    expect(policy.split("; ").map((directive) => directive.split(" ")[0])).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "frame-ancestors",
      "base-uri",
      "form-action",
      "sandbox",
    ]);
  });

  it("keeps the document on an opaque origin even when it is opened outside its frame", () => {
    expect(widgetDocumentPolicy({ frameAncestors: "'self'", nonce: "n" })).toMatch(/; sandbox allow-scripts$/);
  });
});
