import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GatewayError } from "../src/api.ts";
import { type BlockActions, MarketplaceResultsBlock } from "../src/blocks.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { installRefusalState } from "../src/use-block-actions.ts";

/**
 * A row whose files changed after its list was made. Pressing Install there again would send the same digest and be
 * refused the same way, so the row says it is out of date, keeps Install disabled with the reason, and offers the same
 * search again instead.
 */

const LISTED = "sha256:files-as-listed";
const NEWER = "sha256:files-as-they-are-now";

function render(locale: "vi" | "en", contentDigest: string, actions: BlockActions): string {
  const t = (key: MessageKey) => CATALOGS[locale][key];
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      value: { locale, setLocale: () => undefined, t },
      children: createElement(MarketplaceResultsBlock, {
        block: {
          directory: "fixtures",
          query: "harbor",
          results: [{ packageId: "com.example.local", version: "1.0.0", digest: "sha256:published", contentDigest }],
        },
        actions,
      }),
    }),
  );
}

const staleActions: BlockActions = {
  onInstallPackage: () => undefined,
  onSearchAgain: () => undefined,
  packageInstall: {
    "com.example.local": { status: "stale", message: "changed", staleContentDigest: LISTED },
  },
};

describe("a listing whose files changed after it was made", () => {
  const en = (key: MessageKey) => CATALOGS.en[key];

  it("goes out of date on a DIGEST_MISMATCH for a press that sent the listing's digest", () => {
    const refused = new GatewayError(409, "DIGEST_MISMATCH", "files changed after this list was made");
    expect(installRefusalState(refused, LISTED, en)).toEqual({
      status: "stale",
      message: CATALOGS.en["shell.package.filesChangedSinceListing"],
      staleContentDigest: LISTED,
    });
  });

  it("is refused with the node's reason for any other refusal, or a mismatch on a press that sent no digest", () => {
    const vi = (key: MessageKey) => CATALOGS.vi[key];
    const unreadable = new GatewayError(400, "LOCAL_SOURCE_UNREADABLE", "could not be read");
    // In the reader's words with the node's reason, never `CODE: message`.
    expect(installRefusalState(unreadable, LISTED, en)).toEqual({ status: "refused", message: "Could not install this package: could not be read" });
    expect(installRefusalState(unreadable, LISTED, vi)).toEqual({ status: "refused", message: "Không cài được gói này: could not be read" });
    const republished = new GatewayError(409, "DIGEST_MISMATCH", "no longer the artifact");
    expect(installRefusalState(republished, undefined, en)).toEqual({ status: "refused", message: "Could not install this package: no longer the artifact" });
    expect(installRefusalState("offline", undefined, en)).toEqual({
      status: "refused",
      message: CATALOGS.en["shell.package.installFailed"],
    });
  });

  it("disables Install with the reason and offers the same search again", () => {
    const html = render("en", LISTED, staleActions);
    expect(html).toMatch(/<button[^>]*data-install-package="com.example.local"[^>]*disabled=""/);
    expect(html).toContain('title="This list is out of date: the package');
    expect(html).toMatch(/aria-describedby="cc-marketplace-state-com.example.local-0"/);
    expect(html).toContain('id="cc-marketplace-state-com.example.local-0"');
    expect(html).toContain('data-install-state="stale"');
    expect(html).toContain('data-marketplace-search-again="com.example.local"');
    expect(html).toContain(">Search again<");
  });

  it("says so in Vietnamese", () => {
    const html = render("vi", LISTED, staleActions);
    expect(html).toContain(`title="${CATALOGS.vi["blocks.marketplace.staleReason"]}"`);
    expect(html).toContain(">Tìm lại<");
    expect(CATALOGS.vi["shell.package.filesChangedSinceListing"]).toContain("đã đổi");
    expect(CATALOGS.vi["blocks.marketplace.searchAgainMessage"]).toContain("{query}");
  });

  it("leaves a row from a newer search, which shows the files as they are now, installable", () => {
    const html = render("en", NEWER, staleActions);
    expect(html).not.toMatch(/<button[^>]*data-install-package="com.example.local"[^>]*disabled=""/);
    expect(html).not.toContain('data-install-state="stale"');
    expect(html).not.toContain("data-marketplace-search-again");
  });

  it("offers no search again where there is no conversation to send it to", () => {
    const html = render("en", LISTED, {
      onInstallPackage: () => undefined,
      packageInstall: { "com.example.local": { status: "stale", message: "changed", staleContentDigest: LISTED } },
    });
    expect(html).toContain('data-install-state="stale"');
    expect(html).not.toContain("data-marketplace-search-again");
  });
});
