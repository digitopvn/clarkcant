import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarketplaceResultsBlock } from "../src/blocks.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";

/**
 * A marketplace card composed from several directory sources: each row says which source listed it, and a source that
 * did not fully answer is said on the card, so a partial answer is not read as the whole directory.
 */

function inLocale(locale: "vi" | "en", element: ReactElement): string {
  const t = (key: MessageKey) => CATALOGS[locale][key];
  return renderToStaticMarkup(createElement(LocaleProvider, { value: { locale, setLocale: () => undefined, t }, children: element }));
}

const BLOCK = {
  type: "marketplace-results",
  owner: "host",
  cardId: "market_1",
  query: "notes",
  directory: "/home/me/index.json · ClarkCant Marketplace",
  results: [
    {
      packageId: "com.example.notes",
      version: "1.0.0",
      displayName: "Notes",
      description: "Quick notes",
      source: { kind: "npm", name: "quick-notes", version: "1.0.0" },
      digest: "sha256:abc",
      riskTier: "isolated-ui",
      facets: ["ui"],
      platforms: ["web"],
      origin: { kind: "official-marketplace", label: "ClarkCant Marketplace" },
    },
  ],
  sources: [
    {
      kind: "official-marketplace",
      label: "ClarkCant Marketplace",
      state: "stale",
      fetchedAt: "2026-10-07T10:00:00.000Z",
      reason: "marketplace.clarkcant.cc answered HTTP 503; listing the copy fetched at 2026-10-07T10:00:00.000Z",
    },
  ],
};

describe("a card composed from several directory sources", () => {
  it("names the source of each row and the state of a source that did not fully answer, in both languages", () => {
    const en = inLocale("en", createElement(MarketplaceResultsBlock, { block: BLOCK }));
    expect(en).toContain('data-marketplace-origin="official-marketplace"');
    expect(en).toContain("listed by ClarkCant Marketplace");
    expect(en).toContain('data-marketplace-source-state="stale"');
    expect(en).toContain("ClarkCant Marketplace: showing an earlier copy — marketplace.clarkcant.cc answered HTTP 503");
    const vi = inLocale("vi", createElement(MarketplaceResultsBlock, { block: BLOCK }));
    expect(vi).toContain("liệt kê bởi ClarkCant Marketplace");
    expect(vi).toContain("đang hiện bản đã tải trước đó");
  });

  it("draws no note for a state it cannot name, and no origin for a malformed one", () => {
    const html = inLocale(
      "en",
      createElement(MarketplaceResultsBlock, {
        block: {
          ...BLOCK,
          results: [{ ...BLOCK.results[0], origin: { kind: 3 } }],
          sources: [{ kind: "custom-marketplace", label: "x", state: "approved" }],
        },
      }),
    );
    expect(html).not.toContain("data-marketplace-source-state");
    expect(html).not.toContain("data-marketplace-origin");
  });
});
