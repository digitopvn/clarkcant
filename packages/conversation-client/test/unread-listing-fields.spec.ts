import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarketplaceResultsBlock } from "../src/blocks.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { UnreadListingFieldsNote, readUnreadFields } from "../src/unread-listing-fields.tsx";

/**
 * What a directory listing says that this node does not read, said on the card, the install question and the update
 * notice rather than dropped silently.
 */

function inLocale(locale: "vi" | "en", element: ReactElement): string {
  const t = (key: MessageKey) => CATALOGS[locale][key];
  return renderToStaticMarkup(createElement(LocaleProvider, { value: { locale, setLocale: () => undefined, t }, children: element }));
}

describe("the note for fields a listing carries that this node does not read", () => {
  it("names them and says a newer Clark shows them, in both languages", () => {
    const fields = { count: 2, names: ["futureBinding", "preview.posterUrl"] };
    expect(inLocale("en", createElement(UnreadListingFieldsNote, { fields }))).toContain(
      "This listing has 2 details this version of Clark cannot read (futureBinding, preview.posterUrl)",
    );
    expect(inLocale("vi", createElement(UnreadListingFieldsNote, { fields }))).toContain(
      "Mục này có 2 thông tin mà bản Clark này không đọc được (futureBinding, preview.posterUrl)",
    );
  });

  it("says there are more than it names", () => {
    const html = inLocale("en", createElement(UnreadListingFieldsNote, { fields: { count: 9, names: ["a", "b"] } }));
    expect(html).toContain("(a, b, …)");
  });

  it("shows nothing when there is nothing left out, and reads only a well-formed note from the wire", () => {
    expect(inLocale("en", createElement(UnreadListingFieldsNote, { fields: undefined }))).toBe("");
    expect(readUnreadFields(undefined)).toBeUndefined();
    expect(readUnreadFields({ count: 1, names: ["a"], value: "x" })).toBeUndefined();
    expect(readUnreadFields({ count: 1, names: ["a"] })).toEqual({ count: 1, names: ["a"] });
  });

  it("is on the marketplace listing, before the Install press", () => {
    const html = inLocale(
      "en",
      createElement(MarketplaceResultsBlock, {
        block: { results: [{ packageId: "com.example.newer", version: "1.0.0", unreadFields: { count: 1, names: ["rating"] } }] },
        actions: { onInstallPackage: () => undefined },
      }),
    );
    const note = html.indexOf('data-unread-listing-fields="1"');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(html.indexOf("data-install-package"));
  });
});
