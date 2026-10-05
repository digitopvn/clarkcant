import { describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { modelReplyCard, type ModelTurnReply } from "../src/conductor.ts";

/**
 * The line under a reply that records which model wrote it.
 *
 * When a fallback answered because the chosen model refused, the record must say so — the chosen model, why it did not
 * answer, and that the choice is kept — rather than read like an ordinary reply from a model the person never picked.
 */
const AT = "2026-10-05T00:00:00.000Z" as Instant;
const deps = { newId: (prefix: string) => `${prefix}_1` };
const reply: ModelTurnReply = {
  text: "ok",
  segments: [{ kind: "text", text: "ok" }],
  provider: "deepseek",
  model: "deepseek-v4-flash",
  elapsedMs: 900,
};

describe("the model reply card", () => {
  it("says a fallback answered, which model was chosen and why it did not", () => {
    const card = modelReplyCard(deps, { ...reply, fallback: { from: "anthropic/claude-opus-5-5", reason: "HTTP 400" } }, AT);

    expect(card).toMatchObject({ title: "Trả lời bằng model dự phòng" });
    const detail = String((card as { detail?: string }).detail);
    expect(detail).toContain("anthropic/claude-opus-5-5 không trả lời được (HTTP 400)");
    expect(detail).toContain("deepseek/deepseek-v4-flash đã trả lời thay");
    expect(detail).toContain("vẫn giữ nguyên");
    expect((card as { fields?: unknown[] }).fields).toContainEqual({ label: "Model đã chọn", value: "anthropic/claude-opus-5-5" });
  });

  it("is the ordinary record when the chosen model answered", () => {
    const card = modelReplyCard(deps, reply, AT);

    expect(card).toMatchObject({ title: "Trả lời bằng model" });
    expect(JSON.stringify(card)).not.toContain("Model đã chọn");
  });
});

/** Any letter only Vietnamese writes: a host-written English card must contain none of them. */
const VIETNAMESE_LETTER = /[ăâđêôơưạảãàáậầấẩẫặằắẳẵẹẻẽèéệềếểễịỉĩìíọỏõòóộồốổỗợờớởỡụủũùúựừứửữỵỷỹỳýĐ]/iu;

describe("the model reply card in the person's interface language", () => {
  it("is written in English when the interface is English", () => {
    const card = modelReplyCard(deps, { ...reply, fallback: { from: "anthropic/claude-opus-5-5", reason: "HTTP 400" } }, AT, "en");

    expect(card).toMatchObject({ title: "Answered by a fallback model" });
    expect(String((card as { detail?: string }).detail)).toContain(
      "anthropic/claude-opus-5-5 could not answer (HTTP 400), so deepseek/deepseek-v4-flash answered instead",
    );
    const fields = (card as { fields?: { label: string; value: string }[] }).fields ?? [];
    expect(fields).toContainEqual({ label: "Chosen model", value: "anthropic/claude-opus-5-5" });
    expect(fields).toContainEqual({ label: "Time", value: "900 ms" });
    expect(JSON.stringify(card)).not.toMatch(VIETNAMESE_LETTER);
  });

  it("says a stopped reply was stopped, in English", () => {
    const card = modelReplyCard(deps, { ...reply, stopped: true }, AT, "en");

    expect(card).toMatchObject({ title: "Stopped on request" });
    expect((card as { fields?: unknown[] }).fields).toContainEqual({ label: "Ended", value: "stopped on request" });
    expect(JSON.stringify(card)).not.toMatch(VIETNAMESE_LETTER);
  });

  it("stays Vietnamese when the interface is Vietnamese", () => {
    const card = modelReplyCard(deps, reply, AT, "vi");

    expect(card).toMatchObject({ title: "Trả lời bằng model" });
    expect((card as { fields?: unknown[] }).fields).toContainEqual({ label: "Thời gian", value: "900 ms" });
  });
});
