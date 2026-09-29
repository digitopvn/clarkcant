import { describe, expect, it } from "vitest";

import { type AppIntentDecision, type NoticeOperationId, type NoticeOperationResponse } from "@clarkcant/contracts";

import { runAppIntent, type AppIntentHost } from "../src/app-intents.ts";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { noticeOperationSay } from "../src/inbox/use-inbox-notice-actions.ts";
import { inboxTargetOf } from "../src/inbox/use-inbox-notifications.ts";

/**
 * The page's half of a notice action and of a notification's deep link.
 *
 * A typed or spoken "dismiss the latest notification" comes back from the node as a decision that already names the
 * notice; the page's one executor carries it out through the host's `actOnNotice` and says what the node answered. A
 * notification click carries only an inbox target, and a target the grammar does not allow opens the inbox at the top
 * rather than being passed on.
 */

function baseHost(extra: Partial<AppIntentHost> = {}): AppIntentHost {
  return {
    openSettings: () => undefined,
    goHome: () => undefined,
    openFilePicker: () => undefined,
    endVoice: () => undefined,
    ...extra,
  };
}

const decision = (intent: Extract<AppIntentDecision, { kind: "intent" }>["intent"], readBack = "Tôi bỏ thông báo nhé."): AppIntentDecision =>
  ({ kind: "intent", intent, requiresConfirmation: false, readBack }) as AppIntentDecision;

describe("carrying out a notice action", () => {
  it("sends the notice and the action the node named to the host, and says what the host answered", async () => {
    const calls: [string, NoticeOperationId][] = [];
    const host = baseHost({
      actOnNotice: (noticeId, action) => {
        calls.push([noticeId, action]);
        return Promise.resolve("Đã bỏ thông báo.");
      },
    });
    const run = await runAppIntent(decision({ kind: "notice.act", noticeId: "ntf_1", noticeAction: "dismiss" }), host);
    expect(run).toEqual({ ran: true, say: "Đã bỏ thông báo." });
    expect(calls).toEqual([["ntf_1", "dismiss"]]);
  });

  it("says the node's reason, not the read-back, when the node refused", async () => {
    const host = baseHost({
      actOnNotice: () => Promise.reject(new Error("Chưa làm được: thông báo không còn trong hộp thư. Thông báo vẫn như trước.")),
    });
    const run = await runAppIntent(decision({ kind: "notice.act", noticeId: "ntf_1", noticeAction: "dismiss" }), host);
    expect(run).toEqual({ ran: false, say: "Chưa làm được: thông báo không còn trong hộp thư. Thông báo vẫn như trước." });
  });

  it("refuses a decision that names no notice rather than acting on whichever is first", async () => {
    let called = false;
    const host = baseHost({
      actOnNotice: () => {
        called = true;
      },
    });
    const run = await runAppIntent(decision({ kind: "notice.act", noticeAction: "dismiss" }), host);
    expect(run.ran).toBe(false);
    expect(run.say).toBe(CATALOGS.vi["shell.intent.noticeMissing"]);
    expect(called).toBe(false);
  });

  it("says there is no inbox here when the host has none, instead of reporting it done", async () => {
    const run = await runAppIntent(decision({ kind: "notice.act", noticeId: "ntf_1", noticeAction: "dismiss" }), baseHost());
    expect(run).toEqual({ ran: false, say: CATALOGS.vi["shell.intent.notInbox"] });
  });

  it("opens the inbox on the item a notification was about", async () => {
    const opened: (string | undefined)[] = [];
    const host = baseHost({
      openInbox: (target) => {
        opened.push(target);
      },
    });
    await runAppIntent(decision({ kind: "inbox.open", inboxTarget: "notice:ntf_1" }, "Mở hộp thư."), host);
    await runAppIntent(decision({ kind: "inbox.open" }, "Mở hộp thư."), host);
    expect(opened).toEqual(["notice:ntf_1", undefined]);
  });
});

describe("a notification's inbox target", () => {
  it("keeps a target the grammar allows, for each kind of item", () => {
    for (const target of ["notice:ntf_1", "question:q_1", "command-approval:appr_1", "capability-approval:appr_2", "task-approval:task_1:appr_3"]) {
      expect(inboxTargetOf(target)).toBe(target);
    }
  });

  it("drops anything else, so a crafted notification cannot steer the page", () => {
    for (const bad of [undefined, null, 7, {}, "", "notice:", `${"java"}script:alert(1)`, "notice:a b", "notice:<x>", `notice:${"a".repeat(200)}`, "settings:open"]) {
      expect(inboxTargetOf(bad)).toBeUndefined();
    }
  });
});

describe("what the page says after a notice action", () => {
  const t = (key: MessageKey) => CATALOGS.en[key];
  const answer = (overrides: Partial<NoticeOperationResponse> & Pick<NoticeOperationResponse, "action">): NoticeOperationResponse => ({
    noticeId: "ntf_1",
    outcome: "done",
    ...overrides,
  });

  it("uses the panel's own words for the same action, so a sentence and a press are answered alike", () => {
    expect(noticeOperationSay(answer({ action: "dismiss" }), t, "en")).toBe(CATALOGS.en["inbox.dismissed"]);
    expect(noticeOperationSay(answer({ action: "mark-read" }), t, "en")).toBe(CATALOGS.en["inbox.markedRead"]);
    expect(noticeOperationSay(answer({ action: "retry", state: "queued", position: 2 }), t, "en")).toBe(
      CATALOGS.en["inbox.retryQueued"].replace("{position}", "2"),
    );
    expect(noticeOperationSay(answer({ action: "skip-version", version: "1.2.0" }), t, "en")).toBe(
      CATALOGS.en["inbox.skipped"].replace("{version}", "1.2.0"),
    );
  });

  it("says an update waits for approval rather than that it was installed", () => {
    expect(noticeOperationSay(answer({ action: "update", outcome: "approval-required", version: "1.1.0", approvalId: "appr_1" }), t, "en")).toBe(
      CATALOGS.en["inbox.updateNeedsApproval"],
    );
    expect(noticeOperationSay(answer({ action: "update", version: "1.1.0" }), t, "en")).toBe("Installed version 1.1.0; the notice is out of the inbox.");
  });
});
