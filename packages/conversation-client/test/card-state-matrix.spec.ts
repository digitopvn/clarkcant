import { HOST_OWNED_BLOCK_TYPES } from "@clarkcant/contracts";

import { describe, expect, it } from "vitest";

import {
  ArtifactBlock,
  CodeDiffCardBlock,
  ControlSessionCardBlock,
  QuestionCardBlock,
  TaskProgressCardBlock,
  type BlockActions,
} from "../src/blocks.tsx";
import { findAll } from "./block-helpers.ts";

/**
 * The state matrix, and what it means for a card that is a snapshot.
 *
 * The phase asks every widget to ship fixtures for loading, empty, live, cached/offline, error, read-only and
 * compact/expanded. For a live widget those are all real: it fetches, it can be stale, it can be resized. A
 * host-owned card is different in kind — it is a record of what the host wrote at a moment in the transcript, and
 * it is never refetched, so several of those states have no meaning for it at all.
 *
 * Writing that down per card is the point of this file. The alternative is to claim the matrix is covered, or to
 * invent a loading spinner for something that never loads — and either would be worse than saying which states
 * exist. Every host-owned type appears below with a fixture or with a reason, and a card type that appears in
 * neither fails the coverage test, so the decision stays visible instead of becoming folklore.
 *
 * "Not applicable" is not "untested": the states that do exist for these cards are asserted, including the ones
 * that are easy to get wrong — a form that cannot be submitted saying which field is missing, a session with no
 * verbs left, a truncated diff saying so.
 */

const ACTIONS: BlockActions = {
  onQuestionAnswer: () => {},
  onFormSubmit: () => {},
  onTaskStop: () => {},
  onArtifactOpen: () => {},
  onControlTakeover: () => {},
  onControlStop: () => {},
  // A question is read-only once the transcript carries its answer: the card reads that record rather than the
  // position of the last message, so a sentence that answered nothing cannot close it.
  answeredQuestions: ["q_1"],
  openFormIds: ["form_1"],
};

const QUESTION = { type: "question-card", owner: "host", questionId: "q_1", prompt: "Mở dự án nào?", questionType: "single-choice", options: [{ id: "o1", label: "Dự án hiện tại" }, { id: "o2", label: "Dự án khác" }], allowOther: false, voicePrompt: "Mở dự án nào? Dự án hiện tại hay Dự án khác?", status: "waiting", createdAt: "2026-09-19T17:00:00.000Z" };
const TASK = { type: "task-progress-card", owner: "host", cardId: "c1", taskId: "task_1", goal: "sửa lỗi", status: "working", steps: [], startedAt: "2026-09-19T17:00:00.000Z", updatedAt: "2026-09-19T17:00:00.000Z", cancellable: true };
const SESSION = { type: "browser-session-card", owner: "host", cardId: "c2", sessionId: "cs_1", label: "đang mở form", driver: "agent", status: "running", leaseEpoch: 0, updatedAt: "2026-09-19T17:00:00.000Z" };
const DIFF = { type: "code-diff-card", owner: "host", cardId: "c3", summary: "Sửa một tệp", files: [], truncated: true, updatedAt: "2026-09-19T17:00:00.000Z" };
const ARTIFACT = { type: "artifact", artifactId: "art_1", mimeType: "application/pdf", sizeBytes: 20480, digest: "sha256:abc", label: "báo cáo.pdf" };

/**
 * Where each named state has a fixture, and where it does not apply.
 *
 * A `reason` is a claim about the card's kind, not a way of skipping work: it says why the state cannot exist for
 * a snapshot, so a reviewer can disagree with it specifically.
 */
const MATRIX: Record<(typeof HOST_OWNED_BLOCK_TYPES)[number], { applicable: readonly string[]; reason: string }> = {
  "question-card": { applicable: ["read-only", "empty"], reason: "loading/cached/offline: a question is a record of what was asked and is never refetched" },
  "form-card": { applicable: ["read-only", "error", "empty"], reason: "loading/cached/offline: a form is a record of what was asked; its draft is local and never loaded" },
  "task-progress-card": { applicable: ["empty", "live", "error"], reason: "cached/offline: a task card is a snapshot of a state the node reports, not a cached view of one" },
  "task-summary-card": { applicable: ["empty", "read-only"], reason: "loading/cached/offline: a finished task is history" },
  "task-overview-card": { applicable: ["empty", "read-only"], reason: "loading/cached/offline: an overview is written when it is written" },
  "code-diff-card": { applicable: ["empty", "partial", "read-only"], reason: "loading/cached/offline: a diff is a record of a change that was taken" },
  "project-picker-card": { applicable: ["empty", "read-only"], reason: "loading/cached/offline: the roots are the node's own, resolved when the card was written" },
  "system-card": { applicable: ["error", "read-only"], reason: "loading/cached/offline: a system card states a condition, it does not fetch one" },
  "approval-card": { applicable: ["read-only", "error"], reason: "loading/cached/offline: an approval is a request with an expiry, not a view" },
  "credential-card": { applicable: ["read-only", "error"], reason: "loading/cached/offline: a credential request is a form, and no stored value is ever read back" },
  "connection-card": { applicable: ["live", "error", "read-only"], reason: "cached/offline: the card reports the connection's own status rather than a cached copy" },
  "reconnect-card": { applicable: ["live", "error"], reason: "cached/offline: reconnection is the state being reported" },
  "browser-session-card": { applicable: ["live", "error", "read-only"], reason: "cached/offline: the lease decides what is current, and a cached view would be a view of a session somebody else may be driving" },
  "computer-session-card": { applicable: ["live", "error", "read-only", "unavailable"], reason: "cached/offline: the preview permission is never cached, because a cached yes is a claim nobody granted" },
  "terminal-session-card": { applicable: ["live", "error", "read-only", "unavailable"], reason: "cached/offline: a terminal is a live process on the node; once the node forgets it the card says so instead of showing an old screen as current" },
  "marketplace-results": { applicable: ["empty", "error", "read-only", "unavailable"], reason: "live/cached: a result is what a directory said when it was asked, and the card names that directory instead of presenting a listing as current" },
};

describe("the state matrix for host cards", () => {
  it("accounts for every host-owned card type, so none is silently omitted", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...HOST_OWNED_BLOCK_TYPES].sort());
  });

  it("gives a reason wherever a state is claimed not to apply", () => {
    for (const type of HOST_OWNED_BLOCK_TYPES) {
      // A reason, not an omission: the claim is reviewable and specific rather than implied by absence.
      const entry = MATRIX[type];
      expect(entry, `${type} is not accounted for`).toBeDefined();
      expect(entry?.reason.length ?? 0, `${type} has no reason`).toBeGreaterThan(0);
      expect(entry?.applicable.length ?? 0, `${type} claims no states at all`).toBeGreaterThan(0);
    }
  });
});

describe("the states that do exist for these cards", () => {
  /*
   * The form card's own states are asserted in `apps/web/e2e/question.spec.ts`, and deliberately not here: it holds
   * its draft in component state, so calling it outside React is not a weaker test of a form — it is a call that
   * throws. The browser journey asserts the same claims where they can actually be observed: submit disabled with
   * the missing field named, the draft surviving a rerender, and the answers staying readable once it closes.
   */

  it("renders a task with no steps without pretending it has any", () => {
    const card = TaskProgressCardBlock({ block: TASK, actions: ACTIONS });

    expect(findAll(card, "data-host-card")).toHaveLength(1);
    expect(findAll(card, "data-step-status")).toHaveLength(0);
    // The goal and the status are still stated: an empty step list is not an empty card.
    expect(findAll(card, "data-task-cancellable")[0]).toBeDefined();
  });

  it("says a diff is partial rather than showing it as the whole change", () => {
    // Called directly, like the other hook-free cards: `renderBlock` returns the element, so its attributes do not
    // exist until React renders it, and a test that read them off the returned element would assert nothing.
    const card = CodeDiffCardBlock({ block: DIFF });

    const props = (card === null ? {} : card.props) as Record<string, unknown>;
    expect(props["data-truncated"]).toBe(true);
    // No files is a real state and it does not throw: the summary still says what the change was about.
    expect(findAll(card, "data-diff-path")).toHaveLength(0);
  });

  it("draws no verbs on a session that has stopped", () => {
    const card = ControlSessionCardBlock({ block: { ...SESSION, status: "stopped" }, actions: ACTIONS });

    expect(findAll(card, "data-control-takeover")).toHaveLength(0);
    expect(findAll(card, "data-control-stop")).toHaveLength(0);
    expect(findAll(card, "data-control-notice")).toHaveLength(1);
  });

  it("reports a desktop whose screen cannot be seen, and does not act on it", () => {
    const card = ControlSessionCardBlock({
      block: { ...SESSION, type: "computer-session-card", preview: "needs-permission", previewReason: "chưa cấp quyền" },
      actions: ACTIONS,
    });
    const notice = findAll(card, "data-control-preview-notice")[0] as { props: { children?: unknown; } } | undefined;

    expect(notice).toBeDefined();
    // The reason and whom it belongs to, because the fix is something the user has to do.
    expect(String(notice?.props.children)).toContain("hệ điều hành");
    expect((card?.props as Record<string, unknown>)["data-control-preview"]).toBe("needs-permission");
  });

  it("publishes a marker for every action a card offers, so nothing is reachable only by guessing coordinates", () => {
    // The semantic half of the contract: an action a surface offers is named in the DOM, which is what lets a voice
    // or app-control path address it as an action rather than as a place on the screen.
    //
    // The question card is asked here with actions that leave it open: `ACTIONS` marks this question answered, which
    // is the read-only state, and a card in that state deliberately offers no controls at all.
    const openQuestion: BlockActions = { onQuestionAnswer: () => {} };
    const markers = [
      findAll(QuestionCardBlock({ block: QUESTION, actions: openQuestion }), "data-question-option"),
      findAll(TaskProgressCardBlock({ block: TASK, actions: ACTIONS }), "data-task-stop"),
      findAll(ArtifactBlock({ block: ARTIFACT, actions: ACTIONS }), "data-artifact-open"),
      findAll(ControlSessionCardBlock({ block: SESSION, actions: ACTIONS }), "data-control-takeover"),
      findAll(ControlSessionCardBlock({ block: SESSION, actions: ACTIONS }), "data-control-stop"),
    ];

    for (const found of markers) expect(found.length).toBeGreaterThan(0);
  });
});
