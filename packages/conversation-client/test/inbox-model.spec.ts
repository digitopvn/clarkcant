import { describe, expect, it } from "vitest";

import type { Instant, Notice } from "@clarkcant/contracts";

import { MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import {
  inboxMarkState,
  inboxMarkText,
  inboxMarkVisible,
  noticeIdsToMarkRead,
  noticeTone,
  relativeAge,
  timeLeft,
  waitingKey,
} from "../src/inbox/inbox-model.ts";

/**
 * The inbox's decisions, apart from its rendering.
 *
 * Each of these is a claim the surface makes to a person — "nothing here", "two waiting", "read" — and each is the kind
 * that is easy to make slightly untrue: a mark left on screen at zero, a notice marked read that never was on screen, a
 * deadline measured on the wrong clock.
 */
const t = (key: MessageKey): string => MESSAGES_VI[key];
const READ_AT = "2026-09-24T07:00:00.000Z";

function notice(id: string, readAt?: string): Notice {
  return {
    noticeId: id,
    sourceKind: "background",
    category: "result",
    severity: "success",
    title: `thông báo ${id}`,
    createdAt: READ_AT as Instant,
    ...(readAt === undefined ? {} : { readAt: readAt as Instant }),
  };
}

describe("the header mark", () => {
  it("is absent at zero and while the node has not answered", () => {
    expect(inboxMarkVisible(undefined)).toBe(false);
    expect(inboxMarkVisible({ waiting: 0, unread: 0 })).toBe(false);
    expect(inboxMarkVisible({ waiting: 0, unread: 1 })).toBe(true);
  });

  it("says what is waiting before what is new, and only what is not zero", () => {
    expect(inboxMarkText({ waiting: 2, unread: 3 }, t)).toBe("2 việc chờ bạn · 3 thông báo mới");
    expect(inboxMarkText({ waiting: 0, unread: 1 }, t)).toBe("1 thông báo mới");
    expect(inboxMarkState({ waiting: 1, unread: 0 })).toBe("waiting");
    expect(inboxMarkState({ waiting: 0, unread: 4 })).toBe("unread");
  });
});

describe("opening the panel", () => {
  it("marks read exactly the unread notices it drew", () => {
    expect(noticeIdsToMarkRead([notice("a"), notice("b", READ_AT), notice("c")])).toEqual(["a", "c"]);
    expect(noticeIdsToMarkRead([])).toEqual([]);
  });
});

describe("words for time", () => {
  it("says how old a notice is, coarsely, and never in the future", () => {
    expect(relativeAge(READ_AT, READ_AT, t)).toBe("vừa xong");
    expect(relativeAge("2026-09-24T07:00:30.000Z", READ_AT, t)).toBe("vừa xong");
    expect(relativeAge("2026-09-24T06:55:00.000Z", READ_AT, t)).toBe("5 phút trước");
    expect(relativeAge("2026-09-24T04:00:00.000Z", READ_AT, t)).toBe("3 giờ trước");
    expect(relativeAge("2026-09-22T07:00:00.000Z", READ_AT, t)).toBe("2 ngày trước");
  });

  it("measures a deadline against the time the node read the inbox", () => {
    expect(timeLeft(undefined, READ_AT, t)).toBeUndefined();
    expect(timeLeft("2026-09-24T07:14:00.000Z", READ_AT, t)).toBe("còn 14 phút");
    expect(timeLeft("2026-09-24T07:00:30.000Z", READ_AT, t)).toBe("sắp hết hạn");
  });
});

describe("the rest of the vocabulary", () => {
  it("maps severity to the badge tones the surface already has", () => {
    expect(noticeTone("success")).toBe("ok");
    expect(noticeTone("warning")).toBe("warn");
    expect(noticeTone("error")).toBe("danger");
    expect(noticeTone("info")).toBeUndefined();
  });

  it("keys waiting items so an approval and a question with the same id cannot collide", () => {
    expect(
      waitingKey({
        kind: "question",
        questionId: "x",
        conversationId: "c",
        prompt: "?",
        requestedAt: READ_AT as Instant,
      }),
    ).not.toBe(
      waitingKey({
        kind: "command-approval",
        approvalId: "x",
        conversationId: "c",
        description: "d",
        operationDigest: "sha256:x",
        requestedAt: READ_AT as Instant,
        expiresAt: READ_AT as Instant,
      }),
    );
  });
});
