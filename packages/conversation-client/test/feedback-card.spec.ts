import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type FeedbackCard, feedbackCardSchema } from "@clarkcant/contracts";

import type { BlockActions } from "../src/blocks.tsx";
import { FeedbackCardBlock, FeedbackResult } from "../src/feedback-card.tsx";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { feedbackReportToReuse } from "../src/use-block-actions.ts";
import { findAll, textOf } from "./block-helpers.ts";

/**
 * The host's report cards: a prepared report is shown exactly as it would be filed and filed only by the person's
 * press; Check again only looks; Send again is offered, and says it sends, only once sending again is the truth; and a
 * card a later result answers reads as used, after a reload too.
 */

const t = (key: MessageKey): string => MESSAGES_EN[key];
const AT = "2026-10-06T09:00:00.000Z";
const BASE = { type: "feedback-card", owner: "host", repository: "digitopvn/clarkcant", kind: "bug", diagnostics: [], updatedAt: AT };

const PREPARED: FeedbackCard = feedbackCardSchema.parse({
  ...BASE,
  cardId: "card_draft",
  stage: "compose",
  reportId: "rpt_1",
  title: "bug: the orb freezes",
  preview: { body: "### What happened\n\nThe orb freezes.\n\n<!-- clark-report:rpt_1 -->" },
});
const BLANK: FeedbackCard = feedbackCardSchema.parse({ ...BASE, cardId: "card_blank", stage: "compose" });
const result = (publication: Record<string, unknown>): FeedbackCard =>
  feedbackCardSchema.parse({ ...BASE, cardId: "card_result", stage: "result", reportId: "rpt_1", title: "bug: the orb freezes", publication });

type Pressed = Parameters<NonNullable<BlockActions["onFeedbackCreate"]>>[0];

function live(answered: string[] = []): { actions: BlockActions; pressed: Pressed[] } {
  const pressed: Pressed[] = [];
  return { actions: { onFeedbackCreate: (input) => pressed.push(input), answeredFeedbackCards: answered }, pressed };
}

const markup = (block: FeedbackCard, actions?: BlockActions): string =>
  renderToStaticMarkup(createElement(FeedbackCardBlock, { block, t, ...(actions === undefined ? {} : { actions }) }));

describe("a report Clark prepared", () => {
  it("shows the exact issue, read-only, with Create issue as the only way to file it", () => {
    const html = markup(PREPARED, live().actions);

    expect(html).toContain("data-feedback-prepared");
    expect(html).toContain("The orb freezes.");
    expect(html).toContain("data-feedback-create");
    expect(html).not.toContain("<textarea");
    expect(html).toContain(MESSAGES_EN["feedback.prepared.notSent"]);
  });

  it("is a record once a result answers it, and in a snapshot", () => {
    expect(markup(PREPARED, live(["card_draft"]).actions)).not.toContain("data-feedback-create");
    expect(markup(PREPARED)).not.toContain("data-feedback-create");
    expect(markup(PREPARED)).toContain("The orb freezes.");
  });
});

describe("the blank composer", () => {
  it("is a used record after a reload once a result answers it", () => {
    const html = markup(BLANK, live(["card_blank"]).actions);

    expect(html).toContain("data-feedback-answered");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("data-feedback-create");
  });

  it("can still be written in while nothing answers it", () => {
    expect(markup(BLANK, live().actions)).toContain("<textarea");
  });
});

describe("a result", () => {
  it("offers Check again on an unknown outcome, and that press only checks", () => {
    const { actions, pressed } = live();
    const card = FeedbackResult({ block: result({ status: "unknown", reportId: "rpt_1", reason: "GitHub did not answer" }), t, actions });
    const [check] = findAll(card, "data-feedback-check");
    (check?.props.onClick as () => void)();

    expect(findAll(card, "data-feedback-send-again")).toHaveLength(0);
    expect(pressed).toEqual([{ cardId: "card_result", reportId: "rpt_1", intent: "check" }]);
  });

  it("offers Send again — and says so in both languages — once sending again is what would happen", () => {
    const { actions, pressed } = live();
    const card = FeedbackResult({
      block: result({ status: "failed", reportId: "rpt_1", reason: "GitHub does not hold this report", retryable: true }),
      t,
      actions,
    });
    const [send] = findAll(card, "data-feedback-send-again");
    (send?.props.onClick as () => void)();

    expect(textOf(send)).toBe("Send again");
    expect(MESSAGES_VI["feedback.sendAgain"]).toBe("Gửi lại");
    expect(findAll(card, "data-feedback-check")).toHaveLength(0);
    expect(pressed).toEqual([{ cardId: "card_result", reportId: "rpt_1", intent: "send" }]);
  });

  it("says plainly when checking cannot settle it: no Check again, both links, the warning, and Send anyway", () => {
    const { actions, pressed } = live();
    const block = result({
      status: "unknown",
      reportId: "rpt_1",
      reason: "Clark can't tell whether GitHub kept this report, and checking again won't change that.",
      inconclusive: {
        since: "2026-10-06T08:58:00.000Z",
        searchUrl: "https://github.com/digitopvn/clarkcant/issues?q=is%3Aissue%20author%3A%40me%20created%3A%3E%3D2026-10-06",
        manualUrl: "https://github.com/digitopvn/clarkcant/issues/new?title=bug",
      },
    });
    const card = FeedbackResult({ block, t, actions });
    const [anyway] = findAll(card, "data-feedback-send-anyway");
    (anyway?.props.onClick as () => void)();

    expect(findAll(card, "data-feedback-check")).toHaveLength(0);
    expect(findAll(card, "data-feedback-send-again")).toHaveLength(0);
    expect(textOf(anyway)).toBe("Send anyway — this may file it twice");
    expect(pressed).toEqual([{ cardId: "card_result", reportId: "rpt_1", intent: "send-anyway" }]);
    const html = markup(block, actions);
    expect(html).toContain("Can&#x27;t be checked");
    expect(html).toContain("See what you filed on GitHub since 2026-10-06");
    expect(html).toContain('href="https://github.com/digitopvn/clarkcant/issues/new?title=bug"');
    expect(html).toContain("data-feedback-duplicate-warning");
    expect(MESSAGES_VI["feedback.sendAnyway"]).toBe("Vẫn gửi — có thể tạo bản trùng");
    // A snapshot keeps the links and the warning, and offers no press.
    expect(markup(block)).not.toContain("data-feedback-send-anyway");
    expect(markup(block)).toContain("data-feedback-search");
  });

  it("offers nothing once a later result answers it", () => {
    const html = markup(result({ status: "unknown", reportId: "rpt_1", reason: "GitHub did not answer" }), live(["card_result"]).actions);

    expect(html).not.toContain("data-feedback-check");
  });
});

describe("pressing again after a press that did not get through", () => {
  it("acts on the same report for the same words, and on a new one for different words", () => {
    const failed = { status: "failed" as const, message: "network", reportId: "rpt_9", requestKey: "same" };

    expect(feedbackReportToReuse(failed, "same")).toBe("rpt_9");
    expect(feedbackReportToReuse(failed, "different")).toBeUndefined();
    expect(feedbackReportToReuse({ status: "failed", message: "network" }, "same")).toBeUndefined();
    expect(feedbackReportToReuse(undefined, "same")).toBeUndefined();
  });
});
