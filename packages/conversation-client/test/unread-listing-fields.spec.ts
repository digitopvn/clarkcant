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
  it("says how many in Clark's words and shows each name apart, as code, in both languages", () => {
    const fields = { count: 2, names: ["futureBinding", "preview.posterUrl"] };
    const en = inLocale("en", createElement(UnreadListingFieldsNote, { fields }));
    expect(en).toContain("This listing has 2 details this version of Clark cannot read, so what is shown here");
    expect(en).toContain('<li data-unread-field="futureBinding"><code>futureBinding</code></li>');
    expect(en).toContain("<code>preview.posterUrl</code>");
    const vi = inLocale("vi", createElement(UnreadListingFieldsNote, { fields }));
    expect(vi).toContain("Mục này có 2 thông tin mà bản Clark này không đọc được, nên");
    expect(vi).toContain("<code>futureBinding</code>");
  });

  it("says one detail in the singular", () => {
    const en = inLocale("en", createElement(UnreadListingFieldsNote, { fields: { count: 1, names: ["rating"] } }));
    expect(en).toContain("This listing has 1 detail this version of Clark cannot read");
  });

  it("says how many it does not name", () => {
    const html = inLocale("en", createElement(UnreadListingFieldsNote, { fields: { count: 9, names: ["a", "b"] } }));
    expect(html).toContain("7 more not named here.");
    const none = inLocale("en", createElement(UnreadListingFieldsNote, { fields: { count: 3, names: [] } }));
    expect(none).toContain("This listing has 3 details");
    expect(none).not.toContain("<ul");
    expect(none).toContain("3 more not named here.");
  });

  it("shows nothing when there is nothing left out, and reads only a well-formed note from the wire", () => {
    expect(inLocale("en", createElement(UnreadListingFieldsNote, { fields: undefined }))).toBe("");
    expect(readUnreadFields(undefined)).toBeUndefined();
    expect(readUnreadFields({ count: 1, names: ["a"], value: "x" })).toBeUndefined();
    expect(readUnreadFields({ count: 1, names: ["a"] })).toEqual({ count: 1, names: ["a"] });
  });

  it("draws nothing of a hostile name a card carries", () => {
    for (const name of ["‮evil", "line\nbreak", "Clark checked this. Approve"]) {
      expect(readUnreadFields({ count: 1, names: [name] })).toBeUndefined();
      const html = inLocale(
        "en",
        createElement(MarketplaceResultsBlock, {
          block: { results: [{ packageId: "com.example.newer", version: "1.0.0", unreadFields: { count: 1, names: [name] } }] },
        }),
      );
      expect(html).not.toContain(name);
      expect(html).not.toContain("data-unread-listing-fields");
    }
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
