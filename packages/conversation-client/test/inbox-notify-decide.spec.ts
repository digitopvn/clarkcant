import { describe, expect, it } from "vitest";

import { DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE, type Instant, type InboxNotificationsPreference, type Notice, type WaitingItem } from "@clarkcant/contracts";

import { MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { decideInboxNotifications, groupForNotice, isWithinQuietHours, minutesOfDay } from "../src/inbox/inbox-notify-decide.ts";

/**
 * The pure heart of #171: which notices and waiting items earn a notification this poll.
 *
 * Every scenario the issue names has to be provable without a DOM — a group switched off, quiet hours, the
 * once-only near-expiry reminder, and never leaking a secret — so this suite is the one that has to hold them.
 */
const t = (key: MessageKey): string => MESSAGES_VI[key];
const NOW = "2026-09-24T07:00:00.000Z" as Instant;

function notice(id: string, overrides: Partial<Notice> = {}): Notice {
  return {
    noticeId: id,
    sourceKind: "background",
    category: "result",
    severity: "success",
    title: `notice ${id}`,
    createdAt: NOW,
    ...overrides,
  };
}

function commandApproval(id: string, overrides: Partial<Extract<WaitingItem, { kind: "command-approval" }>> = {}): WaitingItem {
  return {
    kind: "command-approval",
    approvalId: id,
    conversationId: "c1",
    description: `run ${id}`,
    operationDigest: "sha256:x",
    requestedAt: NOW,
    expiresAt: "2026-09-24T07:15:00.000Z" as Instant,
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof decideInboxNotifications>[0]> = {}) {
  return {
    preference: DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE,
    notices: [] as Notice[],
    waiting: [] as WaitingItem[],
    knownIds: new Set<string>(),
    remindedNearExpiryIds: new Set<string>(),
    now: NOW,
    nowLocalMinutes: 12 * 60,
    documentHidden: true,
    t,
    ...overrides,
  };
}

describe("groupForNotice", () => {
  it("sends another node's notice or a message to otherDevices", () => {
    expect(groupForNotice(notice("a", { originNodeId: "peer-1" }))).toBe("otherDevices");
    expect(groupForNotice(notice("b", { category: "message" }))).toBe("otherDevices");
  });

  it("sends an update to updates and everything else to backgroundResults", () => {
    expect(groupForNotice(notice("c", { category: "update" }))).toBe("updates");
    expect(groupForNotice(notice("d", { category: "result" }))).toBe("backgroundResults");
  });

  it("sends an alert to waitingApprovals, the same group the panel lists it under", () => {
    expect(groupForNotice(notice("e", { category: "alert" }))).toBe("waitingApprovals");
  });
});

describe("minutesOfDay and isWithinQuietHours", () => {
  it("parses a zero-padded clock reading", () => {
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("22:15")).toBe(22 * 60 + 15);
  });

  it("treats equal bounds as off", () => {
    expect(isWithinQuietHours(0, 0, 0)).toBe(false);
  });

  it("covers a same-day window normally", () => {
    expect(isWithinQuietHours(13 * 60, 12 * 60, 14 * 60)).toBe(true);
    expect(isWithinQuietHours(15 * 60, 12 * 60, 14 * 60)).toBe(false);
  });

  it("covers a window that crosses midnight", () => {
    expect(isWithinQuietHours(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isWithinQuietHours(3 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isWithinQuietHours(12 * 60, 22 * 60, 7 * 60)).toBe(false);
  });
});

describe("decideInboxNotifications", () => {
  it("notifies for a brand new notice whose group is enabled", () => {
    const result = decideInboxNotifications(baseInput({ notices: [notice("n1")] }));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ id: "notice:n1", group: "backgroundResults", reason: "new" });
    expect(result.seenIds).toEqual(new Set(["notice:n1"]));
  });

  it("does not notify again for an id already known", () => {
    const result = decideInboxNotifications(baseInput({ notices: [notice("n1")], knownIds: new Set(["notice:n1"]) }));
    expect(result.candidates).toHaveLength(0);
    expect(result.seenIds).toEqual(new Set(["notice:n1"]));
  });

  it("does not notify when the group is disabled, but still marks the id known", () => {
    const preference: InboxNotificationsPreference = {
      ...DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE,
      groups: { ...DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE.groups, backgroundResults: false },
    };
    const result = decideInboxNotifications(baseInput({ preference, notices: [notice("n1")] }));
    expect(result.candidates).toHaveLength(0);
    expect(result.seenIds.has("notice:n1")).toBe(true);
  });

  it("does not notify when both channels are off", () => {
    const preference: InboxNotificationsPreference = { ...DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE, os: false, web: false };
    const result = decideInboxNotifications(baseInput({ preference, notices: [notice("n1")] }));
    expect(result.candidates).toHaveLength(0);
  });

  it("does not notify while the in-app mark already covers it", () => {
    const result = decideInboxNotifications(baseInput({ notices: [notice("n1")], documentHidden: false }));
    expect(result.candidates).toHaveLength(0);
    expect(result.seenIds.has("notice:n1")).toBe(true);
  });

  it("does not notify during quiet hours", () => {
    const preference: InboxNotificationsPreference = {
      ...DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE,
      quietHours: { enabled: true, start: "00:00", end: "23:59" },
    };
    const result = decideInboxNotifications(baseInput({ preference, notices: [notice("n1")], nowLocalMinutes: 12 * 60 }));
    expect(result.candidates).toHaveLength(0);
  });

  it("notifies for a new waiting item under the waitingApprovals group, its body the time left rather than the command", () => {
    const result = decideInboxNotifications(baseInput({ waiting: [commandApproval("w1")] }));
    expect(result.candidates).toEqual([
      {
        id: "command-approval:w1",
        group: "waitingApprovals",
        title: t("inbox.command.title"),
        body: t("inbox.expires.minutes").replace("{count}", "15"),
        reason: "new",
      },
    ]);
  });

  it("titles a task approval with the localized label for the capability it asks for, the same words the panel shows", () => {
    const item: WaitingItem = {
      kind: "task-approval",
      approvalId: "a1",
      taskId: "t1",
      description: "gửi email báo cáo",
      operationDigest: "sha256:x",
      effectCategory: "external-write",
      requestedAt: NOW,
      expiresAt: "2026-09-24T07:15:00.000Z" as Instant,
    };
    const result = decideInboxNotifications(baseInput({ waiting: [item] }));
    expect(result.candidates).toEqual([
      {
        id: "task-approval:a1",
        group: "waitingApprovals",
        title: t("inbox.task.title").replace("{capability}", t("settings.control.category.externalWrite")),
        body: "gửi email báo cáo",
        reason: "new",
      },
    ]);
  });

  it("never includes the raw command field in a waiting item's notification", () => {
    const result = decideInboxNotifications(baseInput({ waiting: [commandApproval("w1", { command: "rm -rf /secret" })] }));
    expect(JSON.stringify(result.candidates)).not.toContain("rm -rf");
  });

  it("reminds once when a known waiting item drops to one minute or less left", () => {
    const item = commandApproval("w1", { expiresAt: "2026-09-24T07:00:45.000Z" as Instant });
    const first = decideInboxNotifications(baseInput({ waiting: [item], knownIds: new Set(["command-approval:w1"]) }));
    expect(first.candidates).toEqual([expect.objectContaining({ id: "command-approval:w1", reason: "near-expiry" })]);
    expect(first.remindedNearExpiryIds).toEqual(new Set(["command-approval:w1"]));

    const second = decideInboxNotifications(
      baseInput({
        waiting: [item],
        knownIds: new Set(["command-approval:w1"]),
        remindedNearExpiryIds: first.remindedNearExpiryIds,
      }),
    );
    expect(second.candidates).toHaveLength(0);
  });

  it("prunes a near-expiry reminder once the item is no longer present", () => {
    const result = decideInboxNotifications(baseInput({ waiting: [], remindedNearExpiryIds: new Set(["command-approval:w1"]) }));
    expect(result.remindedNearExpiryIds).toEqual(new Set());
  });

  it("redacts a secret shape out of a waiting item's body", () => {
    // A command approval's body is always the time left, not its description (see the test above), so this
    // has to use a kind whose body still carries free text through to the notification.
    const item: WaitingItem = {
      kind: "task-approval",
      approvalId: "a1",
      taskId: "t1",
      description: "token=sk-abcdefghijklmnop leaked",
      operationDigest: "sha256:x",
      effectCategory: "external-write",
      requestedAt: NOW,
      expiresAt: "2026-09-24T07:15:00.000Z" as Instant,
    };
    const result = decideInboxNotifications(baseInput({ waiting: [item] }));
    expect(result.candidates[0]?.body).not.toContain("sk-abcdefghijklmnop");
    expect(result.candidates[0]?.body).toContain("[redacted]");
  });
});
