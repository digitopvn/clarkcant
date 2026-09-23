import { describe, expect, it } from "vitest";

import { matchAppIntent, resolveAppIntent, type WidgetTarget } from "../src/app-intents.ts";

/**
 * Widget sentences, both directions.
 *
 * The red team found that the plan's own examples could not work: `isAppCommandShaped` accepts a
 * sentence only if it opens with a known phrase or opens with a control verb *and* names something in
 * `APP_NOUNS`, and `widget` was not a noun. So `"hiện widget lịch"` and `"show the calendar widget"`
 * were not commands at all. Adding the noun is what makes these reachable, and the negative control
 * below is what keeps the rule from being widened further than that.
 */

const targets: readonly WidgetTarget[] = [
  { phrase: "Lịch", definitionId: "canvas.calendar@1" },
  { phrase: "calendar", definitionId: "canvas.calendar@1" },
  { phrase: "Biểu đồ đường", definitionId: "canvas.line@1" },
  { phrase: "biểu đồ", definitionId: "canvas.line@1" },
  { phrase: "media", family: "media" },
];

const mint = (): never => "00000000-0000-4000-8000-000000000000" as never;

describe("widget app intents", () => {
  it("opens the library from a typed Vietnamese command", () => {
    expect(matchAppIntent("mở thư viện widget")).toEqual({
      kind: "intent",
      intent: { kind: "widgets.open" },
    });
  });

  it("opens the library from an English command", () => {
    expect(matchAppIntent("open widget library")).toEqual({
      kind: "intent",
      intent: { kind: "widgets.open" },
    });
  });

  it("resolves a named widget from a Vietnamese control sentence", () => {
    expect(matchAppIntent("hiện widget lịch", { widgetTargets: targets })).toEqual({
      kind: "intent",
      intent: { kind: "widgets.show", definitionId: "canvas.calendar@1" },
    });
  });

  it("resolves a named widget from an English sentence", () => {
    expect(matchAppIntent("show the calendar widget", { widgetTargets: targets })).toEqual({
      kind: "intent",
      intent: { kind: "widgets.show", definitionId: "canvas.calendar@1" },
    });
  });

  it("prefers the longest target phrase, so a specific name is not stolen by a shorter one", () => {
    expect(matchAppIntent("hiện widget biểu đồ đường", { widgetTargets: targets })).toEqual({
      kind: "intent",
      intent: { kind: "widgets.show", definitionId: "canvas.line@1" },
    });
  });

  it("resolves a family when the sentence names one", () => {
    expect(matchAppIntent("hiện widget media", { widgetTargets: targets })).toEqual({
      kind: "intent",
      intent: { kind: "widgets.show", family: "media" },
    });
  });

  it("still treats a work request as work rather than as a command", () => {
    // The negative control. "cho tôi xem" opens with a work verb, so this is a request to Clark, not
    // an instruction to the shell - and it must reach the agent unchanged.
    expect(matchAppIntent("cho tôi xem widget biểu đồ")).toBeUndefined();
    expect(
      resolveAppIntent({
        text: "cho tôi xem widget biểu đồ",
        mintConfirmationToken: mint,
        widgetTargets: targets,
      }).kind,
    ).toBe("none");
  });

  it("opens the library when a widget sentence names nothing it can resolve", () => {
    // A widget sentence with no resolvable target opens the catalogue rather than being refused: the
    // library is a view action, so the worst outcome is a catalogue the person can close. What is
    // never done is guessing at an effect.
    expect(matchAppIntent("hiện widget thời tiết", { widgetTargets: targets })).toEqual({
      kind: "intent",
      intent: { kind: "widgets.show" },
    });
  });

  it("works without a target table at all, because opening the library needs none", () => {
    expect(matchAppIntent("hiện widget")).toEqual({
      kind: "intent",
      intent: { kind: "widgets.show" },
    });
  });

  it("answers with a read-back rather than a question, since neither kind can lose work", () => {
    const resolution = resolveAppIntent({ text: "mở thư viện widget", mintConfirmationToken: mint });
    expect(resolution.kind).toBe("intent");
    if (resolution.kind === "intent") expect(resolution.readBack).toContain("thư viện widget");
  });

  it("keeps a long widget sentence out of the command channel", () => {
    const long = `hiện widget ${Array.from({ length: 12 }, () => "nào").join(" ")}`;
    expect(matchAppIntent(long, { widgetTargets: targets })).toBeUndefined();
  });
});

/**
 * The regression a new phrase caused in the shape test.
 *
 * `COMMAND_OPENERS` is derived from every phrase's first two words, so adding "thu vien widget"
 * contributed the opener "thu vien" and made *any* sentence starting with "thư viện ..." look like a
 * command to the shell. "thư viện ảnh" is a request for work: it matched no phrase, so it was refused
 * with "tôi chưa hiểu câu lệnh đó" instead of reaching the agent. The gallery journey in
 * apps/web/e2e/widget.spec.ts caught it. These assertions pin the cause, not the symptom: they are
 * about the shape test, so they fail if any future phrase reintroduces a generic opening noun phrase.
 */
describe("a phrase added for the library does not capture sentences about work", () => {
  it("leaves a work request that merely starts with the same noun phrase alone", () => {
    expect(matchAppIntent("thư viện ảnh")).toBeUndefined();
  });

  it("leaves the same request alone even when it opens with a control verb", () => {
    // "mở" is a control verb, but a picture library is not application furniture, so this is still work.
    expect(matchAppIntent("mở thư viện ảnh")).toBeUndefined();
  });

  it("still reaches the library when the sentence really is about the shell's own widget", () => {
    expect(matchAppIntent("mở thư viện widget")?.kind).toBe("intent");
  });

  it("still shapes a widget sentence through the control verb and the widget noun", () => {
    // No phrase contributes this opener any more; the noun plus the verb is what has to carry it.
    expect(matchAppIntent("hiện widget", { widgetTargets: targets })?.kind).toBe("intent");
  });
});
