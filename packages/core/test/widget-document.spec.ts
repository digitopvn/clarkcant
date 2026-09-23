import { describe, expect, it } from "vitest";

import { resolveAppOrigin } from "../src/widget-document.ts";

/**
 * `resolveAppOrigin` decides what `frame-ancestors` in a widget document's CSP points at.
 *
 * The route used to build that value from `CC_APP_ORIGIN` when set, or from the request's own `Host` header when
 * not — with no validation on either. A `Host` header is client-controlled, so anything that made it into the
 * directive unchecked was a header injection into a CSP the widget's own isolation depends on. These cases are the
 * ones that distinguish "validated and normalised" from "trusted verbatim".
 */
describe("resolveAppOrigin", () => {
  it("accepts a bare http(s) origin from CC_APP_ORIGIN", () => {
    const outcome = resolveAppOrigin({ configured: "https://app.example.com:4273", hostHeader: undefined });
    expect(outcome).toEqual({ ok: true, origin: "https://app.example.com:4273" });
  });

  it("refuses CC_APP_ORIGIN with a path, query, or credentials rather than truncating it", () => {
    for (const configured of [
      "https://app.example.com/some-path",
      "https://app.example.com?x=1",
      "https://user:pass@app.example.com",
      "https://app.example.com/",
      "not a url at all",
      "javascript:alert(1)",
    ]) {
      const outcome = resolveAppOrigin({ configured, hostHeader: undefined });
      expect(outcome.ok, `expected ${configured} to be refused`).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("CC_APP_ORIGIN_INVALID");
    }
  });

  it("falls back to a fixed local origin when neither CC_APP_ORIGIN nor Host is present", () => {
    const outcome = resolveAppOrigin({ configured: undefined, hostHeader: undefined });
    expect(outcome).toEqual({ ok: true, origin: "http://127.0.0.1" });
  });

  it("accepts a bare host[:port] Host header when CC_APP_ORIGIN is not configured", () => {
    const outcome = resolveAppOrigin({ configured: undefined, hostHeader: "node.internal:8876" });
    expect(outcome).toEqual({ ok: true, origin: "http://node.internal:8876" });
  });

  it("uses only the first value of a repeated Host header", () => {
    const outcome = resolveAppOrigin({ configured: undefined, hostHeader: ["node.internal:8876", "evil.example"] });
    expect(outcome).toEqual({ ok: true, origin: "http://node.internal:8876" });
  });

  it("refuses a Host header carrying a scheme, path, or other injected content", () => {
    for (const hostHeader of [
      "evil.example\r\nX-Injected: 1",
      "evil.example/frame-ancestors *",
      "http://evil.example",
      "evil.example some-extra-token",
      "evil.example; script-src *",
    ]) {
      const outcome = resolveAppOrigin({ configured: undefined, hostHeader });
      expect(outcome.ok, `expected ${JSON.stringify(hostHeader)} to be refused`).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("HOST_HEADER_INVALID");
    }
  });

  it("ignores an unset Host header even when it arrives as an empty string", () => {
    const outcome = resolveAppOrigin({ configured: undefined, hostHeader: "" });
    expect(outcome).toEqual({ ok: true, origin: "http://127.0.0.1" });
  });

  it("prefers CC_APP_ORIGIN over a present Host header", () => {
    const outcome = resolveAppOrigin({ configured: "https://configured.example", hostHeader: "attacker.example" });
    expect(outcome).toEqual({ ok: true, origin: "https://configured.example" });
  });
});
