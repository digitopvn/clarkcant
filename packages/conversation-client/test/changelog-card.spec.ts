import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type ChangelogCard, instantSchema } from "@clarkcant/contracts";

import { renderBlock } from "../src/blocks.tsx";
import { ChangelogCardBlock } from "../src/changelog-card.tsx";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { nonHost } from "./block-helpers.ts";

/**
 * The changelog card: what this version of Clark changed, drawn from the record the node read, grouped by kind, with no
 * control that this build could not act on.
 */

const en = (key: MessageKey): string => MESSAGES_EN[key];
const vi = (key: MessageKey): string => MESSAGES_VI[key];
const RANGE = { from: "806c39686b2b531a4671f519e7d8072041b2a494", to: "a448d3e4a448d3e4a448d3e4a448d3e4a448d3e4" };

const CARD: ChangelogCard = {
  type: "changelog-card",
  owner: "host",
  cardId: "card_changes",
  installed: { version: "0.3.0-beta.1", channel: "beta" },
  releases: [
    {
      version: "0.3.0-beta.1",
      kind: "release",
      channel: "beta",
      date: "2026-10-06",
      previousVersion: "0.2.1",
      commitRange: RANGE,
      entries: [
        { kind: "breaking", summary: "drop the v1 timeline route", scope: "runtime", commit: "a448d3e4a448" },
        { kind: "feature", summary: "a changelog card", scope: "web", commit: "b448d3e4a448" },
        { kind: "fix", summary: "keep the queued message", commit: "c448d3e4a448" },
      ],
      omittedEntries: 4,
    },
    {
      version: "0.2.1",
      kind: "baseline",
      date: "2026-10-01",
      previousVersion: null,
      commitRange: { from: null, to: RANGE.from },
      entries: [{ kind: "other", summary: "the first conversation", commit: "d448d3e4a448" }],
      omittedEntries: 0,
    },
  ],
  source: "https://github.com/digitopvn/clarkcant/releases",
  updatedAt: instantSchema.parse("2026-10-06T06:00:00.000Z"),
};

const surface = () => createElement("div");
const html = (card: ChangelogCard, t = en): string => renderToStaticMarkup(createElement(ChangelogCardBlock, { block: card, t }));

describe("the changelog card", () => {
  it("names the installed version and channel and draws each release, the newest open", () => {
    const out = html(CARD);
    expect(out).toContain("Clark 0.3.0-beta.1, beta channel");
    expect(out).toMatch(/<details[^>]*data-release-version="0.3.0-beta.1"[^>]*open=""/);
    expect(out).not.toMatch(/<details[^>]*data-release-version="0.2.1"[^>]*open=""/);
    expect(out).toContain("after 0.2.1");
    expect(out).toContain("Source history before the first published release");
  });

  it("groups the entries by kind, breaking first, and draws them as recorded", () => {
    const out = html(CARD);
    const order = ["Breaking changes", "Features", "Fixes"].map((label) => out.indexOf(label));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("drop the v1 timeline route");
    expect(out).toContain("a448d3e");
    expect(out).toContain("4 more changes are not listed here.");
    expect(out).toContain('href="https://github.com/digitopvn/clarkcant/releases"');
  });

  it("labels the chrome in the reader's language and leaves the entries alone", () => {
    const out = html({ ...CARD, installed: { version: "0.2.1", channel: "source" } }, vi);
    expect(out).toContain("Đang chạy Clark 0.2.1 từ mã nguồn");
    expect(out).toContain("Thay đổi không tương thích");
    expect(out).toContain("keep the queued message");
  });

  it("says when nothing came after the version asked about", () => {
    const out = html({ ...CARD, since: "0.3.0", releases: [] });
    expect(out).toContain("This build records no release after 0.3.0.");
  });

  it("offers no update, channel or other control", () => {
    const out = html(CARD);
    expect(out).not.toMatch(/<button|<select|<input/);
    expect(out.toLowerCase()).not.toContain("update");
  });

  it("draws nothing for a card the host did not write, or one that breaks its contract", () => {
    expect(ChangelogCardBlock({ block: nonHost(CARD) as unknown as ChangelogCard, t: en })).toBeNull();
    expect(renderBlock({ ...CARD, releases: "all of them" } as unknown as Record<string, unknown>, 0, surface)).toBeNull();
  });

  it("is what the conversation draws for the block", () => {
    const element = renderBlock(CARD as unknown as Record<string, unknown>, 0, surface, undefined, undefined, en);
    expect(renderToStaticMarkup(element ?? createElement("div"))).toContain('data-changelog="true"');
  });
});
