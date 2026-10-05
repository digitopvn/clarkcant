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

  it("says what was left out for its data class after who answered, and not on a stopped reply", () => {
    const withheldNote = "Withheld from deepseek/deepseek-v4-flash for their data class: AGENTS.md (confidential).";
    const detail = String((modelReplyCard(deps, { ...reply, withheldNote }, AT) as { detail?: string }).detail);
    expect(detail.startsWith("Câu trả lời này do model sinh ra.")).toBe(true);
    expect(detail.endsWith(withheldNote)).toBe(true);
    const stopped = modelReplyCard(deps, { ...reply, withheldNote, stopped: true }, AT);
    expect(JSON.stringify(stopped)).not.toContain("AGENTS.md");
  });
});
