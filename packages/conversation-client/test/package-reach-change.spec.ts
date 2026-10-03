import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { REACH_CHANGE_LIST_MAX, compareReach, type DeclaredReach } from "@clarkcant/contracts";

import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { parseInboxResponse } from "../src/api.ts";
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
    expect(html).toContain("Resource profile: from Interactive light to Media workstation");
    expect(html).toContain("Memory: from 256 MiB to 4096 MiB");
    expect(html).toContain("Time per call: from 1 min to 5 min");
    expect(html).toContain("Time per background job: from 30 min to 2 h");
    expect(html).toMatch(/data-reach-limit="maxActiveJobs" data-reach-limit-direction="down"[^>]*>Jobs at once: from 4 to 1/);
    expect(html).toContain("When out of view: from pausing to playing on when you allow it");
    // Said in words, so a screen reader does not read an arrow.
    expect(html).not.toContain("→");
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
    expect(html).toContain("Bộ nhớ: từ 256 MiB sang 1024 MiB");
    expect(html).toContain("Mức tài nguyên: từ Tương tác nhẹ sang Tương tác nặng");
  });

  it("names the list with the verdict sentence", () => {
    const change = compareReach({ reach: NONE, profile: "interactive-light" }, { reach: { ...NONE, origins: [forecast] }, profile: "interactive-light" });
    const html = inLocale("en", createElement(PackageReachChange, { change }));
    const id = /<span id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`<ul class="cc-package-reach" aria-labelledby="${String(id)}"`);
  });

  it("says where a key now goes: moved to another origin, or sent to one more", () => {
    const a = { origin: "https://a.example.com", purpose: "Reads A." };
    const b = { origin: "https://b.example.com", purpose: "Reads B." };
    const key = [{ name: "X_KEY", purpose: "Signs in." }];
    const moved = compareReach(
      { reach: { ...NONE, origins: [{ ...a, secret: "X_KEY" }, b], secrets: key }, profile: "interactive-light" },
      { reach: { ...NONE, origins: [a, { ...b, secret: "X_KEY" }], secrets: key }, profile: "interactive-light" },
    );
    const html = inLocale("en", createElement(PackageReachChange, { change: moved }));
    expect(html).toContain('data-reach-change="wider"');
    expect(html).toContain("Adds: the key X_KEY is sent to https://b.example.com");
    expect(html).toContain("Drops: sending the key X_KEY to https://a.example.com");

    const also = compareReach(
      { reach: { ...NONE, origins: [{ ...a, secret: "X_KEY" }, b], secrets: key }, profile: "interactive-light" },
      { reach: { ...NONE, origins: [{ ...a, secret: "X_KEY" }, { ...b, secret: "X_KEY" }], secrets: key }, profile: "interactive-light" },
    );
    expect(inLocale("en", createElement(PackageReachChange, { change: also }))).toContain("Adds: the key X_KEY is now also sent to https://b.example.com");
    expect(inLocale("vi", createElement(PackageReachChange, { change: also }))).toContain("Thêm: khóa X_KEY giờ được gửi thêm tới https://b.example.com");
  });

  it("says a GPU request stops it running here", () => {
    const change = compareReach({ reach: NONE, profile: "media-workstation" }, { reach: NONE, profile: "media-workstation", gpu: true });
    const html = inLocale("en", createElement(PackageReachChange, { change }));
    expect(html).toContain("data-reach-added-gpu");
    expect(html).toContain("Adds: asks for a GPU. This machine does not give a package one, so this version will not run here.");
  });

  it("counts what is not listed when a change is larger than a list", () => {
    const providers = Array.from({ length: 8 }, (_, p) => ({
      provider: `example.p${String(p)}`,
      scopes: Array.from({ length: 16 }, (_, s) => `scope${String(s).padStart(2, "0")}:read`),
      purpose: "Draws something.",
    }));
    const change = compareReach({ reach: NONE, profile: "interactive-light" }, { reach: { ...NONE, browserTokens: providers }, profile: "interactive-light" });
    const html = inLocale("en", createElement(PackageReachChange, { change }));
    expect(html).toContain(`…and ${String(128 - REACH_CHANGE_LIST_MAX)} more additions not listed here`);
    expect(html.match(/data-reach-added-token=/g)).toHaveLength(REACH_CHANGE_LIST_MAX);
  });

  it("says when the two versions could not be compared, rather than nothing", () => {
    const html = inLocale("en", createElement(PackageReachChange, { change: { verdict: "unknown" } }));
    expect(html).toContain('data-reach-change="unknown"');
    expect(html).toContain("Could not compare with the installed version, so what this one changes is not known.");
    expect(inLocale("vi", createElement(PackageReachChange, { change: { verdict: "unknown" } }))).toContain("Không so sánh được với bản đang cài");
  });
});

describe("the inbox as the client reads it", () => {
  const at = "2026-10-03T00:00:00.000Z";
  const providers = Array.from({ length: 8 }, (_, p) => ({
    provider: `example.p${String(p)}`,
    scopes: Array.from({ length: 16 }, (_, s) => `scope${String(s).padStart(2, "0")}:read`),
    purpose: "Draws something.",
  }));
  const question = (reachChange: unknown) => ({
    kind: "install-approval",
    approvalId: "a1",
    packageId: "com.example.maps",
    version: "2.0.0",
    displayName: "Maps",
    riskTier: "isolated-ui",
    permissions: [],
    reachChange,
    description: "Install Maps 2.0.0",
    operationDigest: "sha256:x",
    requestedAt: at,
    expiresAt: "2026-10-04T00:00:00.000Z",
  });
  const notice = (noticeId: string, reachChange: unknown) => ({
    noticeId,
    sourceKind: "package",
    category: "update",
    severity: "info",
    title: "Maps 2.0.0 is available",
    createdAt: at,
    reachChange,
  });

  it("reads an update that adds 128 browser-token scopes, on the question and on the notice", () => {
    const change = compareReach({ reach: NONE, profile: "interactive-light" }, { reach: { ...NONE, browserTokens: providers }, profile: "interactive-light" });
    const inbox = parseInboxResponse(JSON.parse(JSON.stringify({ waiting: [question(change)], notices: [notice("n1", change)], unread: 1, readAt: at })));
    expect(inbox.unreadable).toBeUndefined();
    expect(inbox.waiting).toHaveLength(1);
    expect(inbox.notices[0]?.reachChange).toEqual(change);
  });

  it("leaves out an item that does not match, counts it, and keeps every other question and notice", () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const inbox = parseInboxResponse({
        waiting: [question({ verdict: "unknown" })],
        notices: [notice("bad", { verdict: "wider", origins: "not a set" }), notice("good", { verdict: "unknown" })],
        unread: 2,
        readAt: at,
      });
      expect(inbox.waiting).toHaveLength(1);
      expect(inbox.notices.map((entry) => entry.noticeId)).toEqual(["good"]);
      expect(inbox.unreadable).toBe(1);
      expect(errors).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  it("still refuses a response that is not an inbox at all", () => {
    expect(() => parseInboxResponse({ waiting: "nothing" })).toThrow();
    expect(() => parseInboxResponse({ waiting: [], notices: [], unread: -1, readAt: at })).toThrow();
  });
});