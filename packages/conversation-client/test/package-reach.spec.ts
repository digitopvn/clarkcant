import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DeclaredReach, WaitingItem } from "@clarkcant/contracts";

import { MarketplaceResultsBlock } from "../src/blocks.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { PackageReach, readReach } from "../src/package-reach.tsx";

/**
 * What a package reaches outside its sandbox, as the person sees it before installing and in package details: each
 * origin, each key by name with its purpose, and each browser-token provider with its scopes. Never a key's value.
 */

const reach: DeclaredReach = {
  origins: [{ origin: "https://api.example.com", purpose: "Looks up the words you ask about.", secret: "LOOKUP_API_KEY" }],
  secrets: [{ name: "LOOKUP_API_KEY", purpose: "Signs the lookups in with the provider." }],
  browserTokens: [{ provider: "example.maps", scopes: ["geocode:read", "tiles:read"], purpose: "Draws the map $& {purpose}." }],
};

function inLocale(locale: "vi" | "en", element: ReactElement): string {
  const t = (key: MessageKey) => CATALOGS[locale][key];
  return renderToStaticMarkup(createElement(LocaleProvider, { value: { locale, setLocale: () => undefined, t }, children: element }));
}

describe("what a package reaches", () => {
  it("lists each origin with the key sent to it, each key with its purpose, and each token provider with its scopes", () => {
    const html = inLocale("en", createElement(PackageReach, { reach }));
    expect(html).toContain('data-reach-origin="https://api.example.com"');
    expect(html).toContain("Sends requests to https://api.example.com through Clark, with the key LOOKUP_API_KEY: Looks up the words you ask about.");
    expect(html).toContain('data-reach-secret="LOOKUP_API_KEY"');
    expect(html).toContain(
      "Needs a key you provide, LOOKUP_API_KEY (Clark adds it to the requests; the package never sees its value): Signs the lookups in with the provider.",
    );
    // A purpose is shown as the publisher wrote it, with nothing appended after it.
    expect(html).not.toContain("provider..");
    expect(html).toContain('data-reach-token="example.maps"');
    // A publisher's purpose is shown as written, never read as a placeholder or a replacement pattern.
    expect(html).toContain("from example.maps for geocode:read, tiles:read: Draws the map $&amp; {purpose}.");
  });

  it("says the same in Vietnamese", () => {
    const html = inLocale("vi", createElement(PackageReach, { reach }));
    expect(html).toContain("Gửi yêu cầu tới https://api.example.com qua Clark, kèm khóa LOOKUP_API_KEY");
    expect(html).toContain("Cần khóa LOOKUP_API_KEY do bạn cung cấp");
    expect(html).toContain("Có thể nhận token trình duyệt ngắn hạn từ example.maps cho geocode:read, tiles:read");
  });

  it("shows nothing for a package that reaches nothing, and reads only a well-formed reach from the wire", () => {
    expect(inLocale("en", createElement(PackageReach, { reach: undefined }))).toBe("");
    expect(readReach({ origins: [], secrets: [], browserTokens: [] })).toBeUndefined();
    expect(readReach("https://api.example.com")).toBeUndefined();
    // A value smuggled beside a key's name is not a reach, so nothing of it is drawn.
    expect(readReach({ ...reach, secrets: [{ name: "LOOKUP_API_KEY", purpose: "x", value: "fake-value" }] })).toBeUndefined();
    expect(readReach(reach)).toEqual(reach);
  });

  it("is on the marketplace listing, before the Install press", () => {
    const html = inLocale(
      "en",
      createElement(MarketplaceResultsBlock, {
        block: { results: [{ packageId: "com.example.lookup", version: "1.0.0", declaredReach: reach }] },
        actions: { onInstallPackage: () => undefined },
      }),
    );
    const listed = html.indexOf('data-package-reach="true"');
    expect(listed).toBeGreaterThan(-1);
    expect(listed).toBeLessThan(html.indexOf("data-install-package"));
    expect(html).toContain('data-reach-secret="LOOKUP_API_KEY"');
  });

  it("is carried by the install question the inbox shows", () => {
    // The shape the inbox draws from: the contract's install-approval item with its reach.
    const item: Extract<WaitingItem, { kind: "install-approval" }> = {
      kind: "install-approval",
      approvalId: "appr_1",
      packageId: "com.example.lookup",
      version: "1.0.0",
      displayName: "Lookup",
      riskTier: "service",
      permissions: [],
      reach,
      description: "",
      operationDigest: "sha256:lookup",
      requestedAt: "2026-10-02T00:00:00.000Z" as never,
      expiresAt: "2026-10-02T01:00:00.000Z" as never,
    };
    expect(inLocale("en", createElement(PackageReach, { reach: item.reach }))).toContain('data-reach-token="example.maps"');
    for (const locale of ["vi", "en"] as const) {
      for (const key of [
        "settings.extensions.installed.reach",
        "settings.extensions.reach.heading",
        "settings.extensions.reach.origin",
        "settings.extensions.reach.originWithKey",
        "settings.extensions.reach.secret",
        "settings.extensions.reach.token",
      ] as const) {
        expect(CATALOGS[locale][key]).toBeTruthy();
      }
    }
  });
});
