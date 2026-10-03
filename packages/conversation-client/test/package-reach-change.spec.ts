import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { compareReach, type DeclaredReach } from "@clarkcant/contracts";

import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { PackageReachChange } from "../src/package-reach-change.tsx";

/**
 * What an update changes in what a package reaches, as the update notice and the install question show it before the
 * update is applied: what it adds, what it drops, and each resource limit that moves, with both values.
 */

const NONE: DeclaredReach = { origins: [], secrets: [], browserTokens: [] };
const lists = { origin: "https://lists.example.com", purpose: "Reads public word lists." };
const forecast = { origin: "https://forecast.example.com", purpose: "Reads the forecast $& {purpose}." };

function inLocale(locale: "vi" | "en", element: ReactElement): string {
  const t = (key: MessageKey) => CATALOGS[locale][key];
  return renderToStaticMarkup(createElement(LocaleProvider, { value: { locale, setLocale: () => undefined, t }, children: element }));
}

describe("what an update changes in what a package reaches", () => {
  it("lists an added origin with its purpose as written, and a key it drops by name", () => {
    const change = compareReach(
      { reach: { ...NONE, origins: [lists], secrets: [{ name: "LISTS_KEY", purpose: "Signs in." }] }, profile: "interactive-light" },
      { reach: { ...NONE, origins: [lists, forecast] }, profile: "interactive-light" },
    );
    const html = inLocale("en", createElement(PackageReachChange, { change }));
    expect(html).toContain('data-reach-change="wider"');
    expect(html).toContain("Compared with the version installed, this one reaches more:");
    expect(html).toContain('data-reach-added-origin="https://forecast.example.com"');
    expect(html).toContain("Adds: sends requests to https://forecast.example.com through Clark: Reads the forecast $&amp; {purpose}.");
    expect(html).toContain('data-reach-removed-secret="LISTS_KEY"');
    // An origin both versions reach is not listed.
    expect(html).not.toContain("lists.example.com");
  });

  it("lists each resource limit that moves, both ways, in units a person reads", () => {
    const change = compareReach({ reach: NONE, profile: "interactive-light" }, { reach: NONE, profile: "media-workstation" });
    const html = inLocale("en", createElement(PackageReachChange, { change }));
    expect(html).toContain("Resource profile: interactive-light → media-workstation");
    expect(html).toContain("Memory: 256 MiB → 4096 MiB");
    expect(html).toContain("Time per call: 1 min → 5 min");
    expect(html).toContain("Time per background job: 30 min → 2 h");
    expect(html).toMatch(/data-reach-limit="maxActiveJobs" data-reach-limit-direction="down"[^>]*>Jobs at once: 4 → 1/);
    expect(html).toContain("Out of view: pauses → keeps playing when allowed");
  });

  it("says an unchanged update reaches the same and lists nothing", () => {
    const change = compareReach({ reach: { ...NONE, origins: [lists] }, profile: "interactive-light" }, { reach: { ...NONE, origins: [lists] }, profile: "interactive-light" });
    const html = inLocale("en", createElement(PackageReachChange, { change }));
    expect(html).toContain('data-reach-change="unchanged"');
    expect(html).toContain("This version reaches the same as the one installed.");
    expect(html).not.toContain("<li");
    expect(inLocale("en", createElement(PackageReachChange, { change: undefined }))).toBe("");
  });

  it("says the same in Vietnamese", () => {
    const change = compareReach({ reach: NONE, profile: "interactive-light" }, { reach: { ...NONE, origins: [forecast] }, profile: "interactive-heavy" });
    const html = inLocale("vi", createElement(PackageReachChange, { change }));
    expect(html).toContain("So với bản đang cài, bản này với tới nhiều hơn:");
    expect(html).toContain("Thêm: gửi yêu cầu tới https://forecast.example.com qua Clark");
    expect(html).toContain("Bộ nhớ: 256 MiB → 1024 MiB");
  });
});
