import { describe, expect, it } from "vitest";

import { appIntentSchema, describeAppIntent, describeNoticeAction } from "../src/app-intents.ts";
import {
  MACHINE_NOTICE_OPERATION_IDS,
  NOTICE_OPERATION_IDS,
  PERSON_ONLY_NOTICE_OPERATIONS,
  inboxTargetSchema,
  isNoticeOperation,
  isPersonOnlyNoticeOperation,
  noticeOperationRequestSchema,
  noticeOperationResponseSchema,
} from "../src/inbox.ts";
import { isPersonOnlyRoute } from "../src/machine-surfaces.ts";

/**
 * The wire shapes every surface shares for acting on a notice and for a notification's deep link.
 *
 * What matters is what they refuse: an operation list that let a surface-only action or the person's answer about an
 * effect through would let a machine surface reach them, and a target grammar that let arbitrary text through would let
 * a notification steer the page.
 */

describe("the node's notice operations", () => {
  it("are exactly the actions the node carries out, never a screen's or the person's own", () => {
    expect([...NOTICE_OPERATION_IDS].sort()).toEqual(
      [
        "ask-again",
        "dismiss",
        "mark-read",
        "mark-unread",
        "restore",
        "retry",
        "skip-version",
        "snooze",
        "suppress",
        "unsnooze",
        "unsuppress",
        "update",
      ].sort(),
    );
    for (const notOperation of ["open", "ask-clark", "add-to-context", "review-update", "copy-details", "reconcile-confirmed", "reconcile-failed", "approve", ""]) {
      expect(isNoticeOperation(notOperation), notOperation).toBe(false);
    }
  });

  it("keep installing an update the person's own: never offered to a machine surface, and person-only on the route", () => {
    expect(PERSON_ONLY_NOTICE_OPERATIONS).toEqual(["update"]);
    expect(isPersonOnlyNoticeOperation("update")).toBe(true);
    expect(isPersonOnlyNoticeOperation("dismiss")).toBe(false);
    expect(MACHINE_NOTICE_OPERATION_IDS).not.toContain("update");
    expect([...MACHINE_NOTICE_OPERATION_IDS, ...PERSON_ONLY_NOTICE_OPERATIONS].sort()).toEqual([...NOTICE_OPERATION_IDS].sort());
    expect(isPersonOnlyRoute("POST", "/inbox/notices/ntf_1/actions/update")).toBe(true);
    for (const action of MACHINE_NOTICE_OPERATION_IDS) {
      expect(isPersonOnlyRoute("POST", `/inbox/notices/ntf_1/actions/${action}`), action).toBe(false);
    }
  });

  it("take an optional snooze end and the surface the person used, and nothing else", () => {
    expect(noticeOperationRequestSchema.safeParse({}).success).toBe(true);
    expect(noticeOperationRequestSchema.safeParse({ until: "2026-09-30T10:00:00.000Z" }).success).toBe(true);
    expect(noticeOperationRequestSchema.safeParse({ until: 5 }).success).toBe(false);
    for (const source of ["click", "chat", "voice"]) expect(noticeOperationRequestSchema.safeParse({ source }).success, source).toBe(true);
    for (const source of ["agent", "mcp", "relay", "api", ""]) expect(noticeOperationRequestSchema.safeParse({ source }).success, source).toBe(false);
  });

  it("say how many of an installed update's permissions wait or were refused, as counts", () => {
    const installed = { noticeId: "ntf_1", action: "update", outcome: "done", version: "1.1.0" };
    expect(noticeOperationResponseSchema.safeParse({ ...installed, pendingCapabilities: 2, deniedCapabilities: 0 }).success).toBe(true);
    expect(noticeOperationResponseSchema.safeParse({ ...installed, pendingCapabilities: -1 }).success).toBe(false);
    expect(noticeOperationResponseSchema.safeParse({ ...installed, deniedCapabilities: 1.5 }).success).toBe(false);
  });

  it("answer done or approval-required, and nothing that reads as installed when it was not", () => {
    expect(noticeOperationResponseSchema.safeParse({ noticeId: "ntf_1", action: "dismiss", outcome: "done" }).success).toBe(true);
    expect(
      noticeOperationResponseSchema.safeParse({ noticeId: "ntf_1", action: "update", outcome: "approval-required", approvalId: "appr_1", version: "1.1.0" })
        .success,
    ).toBe(true);
    expect(noticeOperationResponseSchema.safeParse({ noticeId: "ntf_1", action: "update", outcome: "installed" }).success).toBe(false);
    expect(noticeOperationResponseSchema.safeParse({ noticeId: "ntf_1", action: "open", outcome: "done" }).success).toBe(false);
  });

  it("each have a read-back in Vietnamese and English that names the notice when it has a title", () => {
    for (const action of NOTICE_OPERATION_IDS) {
      const vi = describeNoticeAction(action, "vi", "Việc nền đã xong");
      const en = describeNoticeAction(action, "en", "Việc nền đã xong");
      expect(vi, action).toContain("“Việc nền đã xong”");
      expect(en, action).toContain("“Việc nền đã xong”");
      expect(en, action).not.toBe(vi);
    }
    expect(new Set(NOTICE_OPERATION_IDS.map((action) => describeNoticeAction(action))).size).toBe(NOTICE_OPERATION_IDS.length);
  });
});

describe("a notice action as an app intent", () => {
  it("must name both the notice and the action, and only notice.act may name either", () => {
    expect(appIntentSchema.safeParse({ kind: "notice.act", noticeId: "ntf_1", noticeAction: "dismiss" }).success).toBe(true);
    expect(appIntentSchema.safeParse({ kind: "notice.act", noticeAction: "dismiss" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "notice.act", noticeId: "ntf_1" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "notice.act", noticeId: "ntf_1", noticeAction: "reconcile-confirmed" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "notice.act", noticeId: "ntf_1", noticeAction: "open" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "inbox.open", noticeId: "ntf_1" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "settings.open", noticeAction: "dismiss" }).success).toBe(false);
  });

  it("opens the inbox on a target only for inbox.open, and says so in the read-back", () => {
    expect(appIntentSchema.safeParse({ kind: "inbox.open", inboxTarget: "notice:ntf_1" }).success).toBe(true);
    expect(appIntentSchema.safeParse({ kind: "settings.open", inboxTarget: "notice:ntf_1" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "inbox.open", inboxTarget: "https://example.com" }).success).toBe(false);
    expect(describeAppIntent({ kind: "inbox.open", inboxTarget: "notice:ntf_1" }, "en")).toBe("Opening your inbox at that item.");
    expect(describeAppIntent({ kind: "inbox.open" }, "en")).toBe("Opening your inbox.");
  });
});

describe("a notification's inbox target", () => {
  // The same vectors as apps/desktop/test/security.spec.ts: the shell and the page read one grammar.
  it("names one kind of inbox item and an id, and nothing else", () => {
    for (const target of ["notice:ntf_1", "question:q_1", "command-approval:appr_1", "capability-approval:appr_2", "task-approval:task_1:appr_3", "notice:a.b-c_d@e/f"]) {
      expect(inboxTargetSchema.safeParse(target).success, target).toBe(true);
    }
    for (const target of ["", "notice:", "notice", "effect:eff_1", `${"java"}script:alert(1)`, "notice:a b", "notice:<script>", "notice:ntf\n1", `notice:${"a".repeat(161)}`]) {
      expect(inboxTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(false);
    }
  });
});
