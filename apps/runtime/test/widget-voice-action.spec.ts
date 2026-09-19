import { describe, expect, it } from "vitest";

import { type SemanticView } from "@clarkcant/contracts";

import {
  describeVoiceWidgetAction,
  NO_FOCUSED_SURFACE_SAY,
  resolveVoiceWidgetAction,
} from "../src/widget-voice-action.ts";

/**
 * Matching a spoken sentence to a widget action.
 *
 * The property that matters is negative: a sentence can only ever select an action the focused instance already
 * offers, and the binding id that gets invoked is the one the view published. If that ever stops being true, voice
 * becomes a way to invoke an action a widget never announced, which is a class of bug no amount of permission
 * checking downstream would catch.
 */

function view(actions: { actionBindingId: string; label: string; requiresApproval?: boolean }[]): SemanticView {
  return {
    instanceId: "winst_calendar",
    summary: "Lịch tháng 9",
    selectedIds: [],
    availableActions: actions.map((action) => ({
      actionBindingId: action.actionBindingId,
      label: action.label,
      requiresApproval: action.requiresApproval ?? false,
    })),
    textRepresentation: "Lịch tháng 9, có 3 sự kiện.",
    dataFreshness: { source: "live" },
  };
}

const CALENDAR = view([
  { actionBindingId: "act_prev", label: "Kỳ trước" },
  { actionBindingId: "act_next", label: "Kỳ sau" },
  { actionBindingId: "act_this", label: "Tháng này" },
]);

describe("a spoken action", () => {
  it("names an action the focused instance actually offers", () => {
    const resolved = resolveVoiceWidgetAction({ utterance: "cho tôi xem kỳ trước", focused: CALENDAR });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.action.actionBindingId).toBe("act_prev");
    // The label travels with it, because the read-back has to name what is about to happen rather than the id.
    expect(resolved.action.label).toBe("Kỳ trước");
    expect(resolved.action.requiresApproval).toBe(false);
  });

  it("reads the same words whether the tone marks arrived or not", () => {
    const accented = resolveVoiceWidgetAction({ utterance: "xem kỳ sau đi", focused: CALENDAR });
    const bare = resolveVoiceWidgetAction({ utterance: "xem ky sau di", focused: CALENDAR });
    expect(accented).toEqual(bare);
  });

  it("matches the label the widget offers rather than a phrase this file happens to know", () => {
    // A widget nobody has written a phrasing table for still works: the label is the contract.
    const other = view([{ actionBindingId: "act_sync", label: "Đồng bộ dữ liệu" }]);
    const resolved = resolveVoiceWidgetAction({ utterance: "đồng bộ dữ liệu giúp tôi", focused: other });
    expect(resolved.ok && resolved.action.actionBindingId).toBe("act_sync");
  });

  it("carries the argument the words implied, so the widget's own contract is what validates it", () => {
    // The label this application actually publishes, and the operation behind it needs period: "week" | "month".
    const overview = view([{ actionBindingId: "act_period", label: "Đổi khoảng thời gian" }]);

    const byMonth = resolveVoiceWidgetAction({ utterance: "xem theo tháng", focused: overview });
    expect(byMonth.ok && byMonth.action.actionBindingId).toBe("act_period");
    expect(byMonth.ok && byMonth.action.args).toEqual({ period: "month" });

    const byWeek = resolveVoiceWidgetAction({ utterance: "xem theo tuần", focused: overview });
    expect(byWeek.ok && byWeek.action.args).toEqual({ period: "week" });

    // Naming the action without saying what it should do carries no argument. Whether that is an error is the
    // widget's business, and its refusal names what it wanted - which this file cannot know and must not guess.
    const bare = resolveVoiceWidgetAction({ utterance: "đổi khoảng thời gian", focused: overview });
    expect(bare.ok && bare.action.args).toEqual({});
  });

  it("keeps the approval flag the widget sets, so a spoken sentence alone cannot run it", () => {
    const guarded = view([{ actionBindingId: "act_delete", label: "Xoá sự kiện", requiresApproval: true }]);
    const resolved = resolveVoiceWidgetAction({ utterance: "xoá sự kiện", focused: guarded });

    expect(resolved.ok && resolved.action.requiresApproval).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    // And the read-back asks rather than announcing, for the same reason a spoken quit asks: a question at the end is
    // what tells the person they are expected to answer before anything happens.
    const said = describeVoiceWidgetAction(resolved.action);
    expect(said).toContain("xác nhận");
    expect(said.trim().endsWith("?")).toBe(true);
    // The one that needs no approval announces instead, so the two are not the same sentence.
    expect(
      describeVoiceWidgetAction({ actionBindingId: "act_next", label: "Kỳ sau", requiresApproval: false, args: {} }),
    ).not.toContain("xác nhận");
  });
});

describe("what the resolver declines to do", () => {
  it("refuses an utterance naming no offered action rather than guessing one", () => {
    const resolved = resolveVoiceWidgetAction({ utterance: "cho tôi xem tháng mười hai", focused: CALENDAR });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    // A sentence, not an empty result: being refused is a complete answer and has to sound like one.
    expect(resolved.say.length).toBeGreaterThan(0);
    expect(resolved.say).not.toContain("act_");
  });

  it("takes the binding id from the view and never from the words", () => {
    // The sentence names a binding that the instance does not offer, and one that exists nowhere. Neither may be
    // invoked: the id that comes back is always one the view published.
    const resolved = resolveVoiceWidgetAction({
      utterance: "chạy act_delete ngay đi",
      focused: CALENDAR,
    });

    expect(resolved.ok).toBe(false);
    // And if something does match, it is still an offered id.
    const real = resolveVoiceWidgetAction({ utterance: "act_next kỳ sau", focused: CALENDAR });
    expect(real.ok && real.action.actionBindingId).toBe("act_next");
  });

  it("answers that nothing is focused instead of blaming the words", () => {
    const resolved = resolveVoiceWidgetAction({ utterance: "kỳ sau", focused: undefined });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    // Different answer from "I did not understand you", because the two need different things from the person.
    expect(resolved.say).toBe(NO_FOCUSED_SURFACE_SAY);
  });

  it("refuses when the focused widget offers no actions at all", () => {
    const resolved = resolveVoiceWidgetAction({ utterance: "kỳ sau", focused: view([]) });
    expect(resolved.ok).toBe(false);
  });

  it("refuses an empty utterance rather than matching the first action", () => {
    expect(resolveVoiceWidgetAction({ utterance: "   ", focused: CALENDAR }).ok).toBe(false);
  });
});
