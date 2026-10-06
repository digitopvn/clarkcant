import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPOSITORY,
  HANDLING_PREREQUISITES,
  HOST_OWNED_BLOCK_TYPES,
  feedbackCardSchema,
  feedbackMarker,
  feedbackPublicationSchema,
  feedbackPublishRequestSchema,
  feedbackReportIdSchema,
  feedbackRequestSchema,
  handlingEligibilitySchema,
  readFeedbackMarker,
} from "../src/index.ts";

describe("product report contracts", () => {
  it("round-trips the hidden marker, and reads none from a body without one", () => {
    const body = `Something broke.\n\n${feedbackMarker("rpt_abc123")}`;
    expect(readFeedbackMarker(body)).toBe("rpt_abc123");
    expect(readFeedbackMarker("<!-- clark-report:not-a-report -->")).toBeUndefined();
    expect(readFeedbackMarker("no marker here")).toBeUndefined();
  });

  it("accepts only rpt_ ids", () => {
    expect(feedbackReportIdSchema.safeParse("rpt_x1").success).toBe(true);
    expect(feedbackReportIdSchema.safeParse("act_x1").success).toBe(false);
    expect(feedbackReportIdSchema.safeParse("rpt_../../etc").success).toBe(false);
  });

  it("files to the canonical repository, from trusted config rather than a request", () => {
    expect(FEEDBACK_REPOSITORY).toBe("digitopvn/clarkcant");
    // A request has no field to aim a report anywhere else.
    expect(feedbackRequestSchema.safeParse({ kind: "bug", description: "x", source: "chat", repository: "evil/repo" }).success).toBe(false);
  });

  it("shares diagnostics unless the person turns them off", () => {
    expect(feedbackRequestSchema.parse({ kind: "bug", description: "x", source: "chat" }).includeDiagnostics).toBe(true);
  });

  it("has no 'eligible' shape a caller can fake without an issue, and lists the handling prerequisites", () => {
    expect(handlingEligibilitySchema.safeParse({ eligible: true, reason: "go" }).success).toBe(false);
    expect(HANDLING_PREREQUISITES.map((issue) => issue.number)).toEqual(expect.arrayContaining([402, 508]));
  });

  it("says published only with the issue GitHub was read back as", () => {
    expect(feedbackPublicationSchema.safeParse({ status: "published", reportId: "rpt_1", mode: "created" }).success).toBe(false);
  });

  it("is a host-owned card", () => {
    expect(HOST_OWNED_BLOCK_TYPES).toContain("feedback-card");
    expect(
      feedbackCardSchema.safeParse({
        type: "feedback-card",
        owner: "widget",
        cardId: "c1",
        stage: "compose",
        repository: FEEDBACK_REPOSITORY,
        diagnostics: [],
        updatedAt: "2026-10-06T09:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("has no state in which a report waits on anyone's approval but the person's own press", () => {
    expect(feedbackPublicationSchema.safeParse({ status: "approval-required", reportId: "rpt_a1", approvalId: "appr_1" }).success).toBe(false);
  });

  it("publishes on a press unless the press only checks, and takes no other intent", () => {
    expect(feedbackPublishRequestSchema.parse({ conversationId: "conv_1" })).toEqual({ conversationId: "conv_1", intent: "send" });
    expect(feedbackPublishRequestSchema.parse({ conversationId: "conv_1", intent: "check", answers: "card_1" }).intent).toBe("check");
    expect(feedbackPublishRequestSchema.safeParse({ conversationId: "conv_1", intent: "approve" }).success).toBe(false);
  });

  it("carries a prepared report's exact preview on the composer, and which card a result answers", () => {
    const base = { type: "feedback-card", owner: "host", cardId: "card_1", repository: FEEDBACK_REPOSITORY, diagnostics: [], updatedAt: "2026-10-06T09:00:00.000Z" };
    expect(feedbackCardSchema.safeParse({ ...base, stage: "compose", reportId: "rpt_a1", title: "bug: x", preview: { body: "x" } }).success).toBe(true);
    expect(feedbackCardSchema.safeParse({ ...base, stage: "compose", preview: { body: "x", extra: true } }).success).toBe(false);
    expect(feedbackCardSchema.safeParse({ ...base, stage: "result", answers: "card_0" }).success).toBe(true);
  });
});
