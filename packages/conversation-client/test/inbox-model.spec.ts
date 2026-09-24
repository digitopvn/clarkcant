import { describe, expect, it } from "vitest";

import type { Instant, Notice, WaitingItem } from "@clarkcant/contracts";

import { MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import {
  canOpenOtherConversation,
  decideFailureCategory,
  decideFailureMessageKey,
  inboxMarkState,
  inboxMarkText,
  inboxMarkVisible,
  nextNoticeFocusTarget,
  noticeIdsToMarkRead,
  noticesMayBeCapped,
  noticeTone,
  relativeAge,
  sanitizeReason,
  timeLeft,
  waitingKey,
} from "../src/inbox/inbox-model.ts";

/** A minimal stand-in for `GatewayError` (`api.ts`): a `code` and a `"CODE: message"` shaped `Error.message`. */
function gatewayError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.name = "GatewayError";
  error.code = code;
  return error;
}

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

describe("the 50-notice cap", () => {
  it("is silent under the cap, and says so at it", () => {
    const under = Array.from({ length: 49 }, (_, index) => notice(String(index)));
    const at = Array.from({ length: 50 }, (_, index) => notice(String(index)));
    expect(noticesMayBeCapped(under)).toBe(false);
    expect(noticesMayBeCapped(at)).toBe(true);
  });
});

describe("a decide failure", () => {
  it("is certain about expired and already-decided, from the gateway's code alone", () => {
    expect(decideFailureCategory(gatewayError("APPROVAL_EXPIRED", "too late"))).toBe("expired");
    expect(decideFailureCategory(gatewayError("APPROVAL_ALREADY_DECIDED", "already decided"))).toBe("alreadyDecided");
  });

  it("is ambiguous for every other code, including ones that mean the decision was recorded", () => {
    expect(decideFailureCategory(gatewayError("APPROVAL_PAYLOAD_MISSING", "no payload"))).toBe("ambiguous");
    expect(decideFailureCategory(new TypeError("network down"))).toBe("ambiguous");
    expect(decideFailureCategory("not an error at all")).toBe("ambiguous");
  });

  it("picks the certain sentence without needing to know whether the item is still waiting", () => {
    expect(decideFailureMessageKey("expired", undefined)).toBe("inbox.decideFailed.expired");
    expect(decideFailureMessageKey("alreadyDecided", true)).toBe("inbox.decideFailed.alreadyDecided");
  });

  it("resolves 'ambiguous' from what a fresh read says, and defaults to 'still waiting' when the read itself is not trustworthy", () => {
    expect(decideFailureMessageKey("ambiguous", false)).toBe("inbox.decideFailed.notRun");
    expect(decideFailureMessageKey("ambiguous", true)).toBe("inbox.decideFailed.stillWaiting");
    expect(decideFailureMessageKey("ambiguous", undefined)).toBe("inbox.decideFailed.stillWaiting");
  });
});

describe("a reason fit to show", () => {
  it("strips the gateway's own code prefix off its message", () => {
    expect(sanitizeReason(gatewayError("APPROVAL_EXPIRED", "too late to decide"))).toBe("too late to decide");
  });

  it("passes an ordinary error's message through unchanged", () => {
    expect(sanitizeReason(new TypeError("network down"))).toBe("network down");
  });

  it("refuses to show a schema failure's raw issue list, and refuses anything that is not an Error", () => {
    const zod = new Error("[{\"code\":\"invalid_type\",\"path\":[\"waiting\"]}]");
    zod.name = "ZodError";
    expect(sanitizeReason(zod)).toBeUndefined();
    expect(sanitizeReason("a plain string")).toBeUndefined();
    expect(sanitizeReason(undefined)).toBeUndefined();
  });
});

describe("focus after dismissing a notice", () => {
  it("moves to the notice that took the dismissed one's place", () => {
    expect(nextNoticeFocusTarget(["a", "b", "c"], "b")).toBe("c");
  });

  it("moves to the previous notice when the dismissed one was last", () => {
    expect(nextNoticeFocusTarget(["a", "b", "c"], "c")).toBe("b");
  });

  it("has nowhere to go when the dismissed notice was the only one, so the caller falls back to the heading", () => {
    expect(nextNoticeFocusTarget(["a"], "a")).toBeUndefined();
  });

  it("has nowhere to go for an id that was never in the list", () => {
    expect(nextNoticeFocusTarget(["a", "b"], "z")).toBeUndefined();
  });
});

describe("whether 'open conversation' may switch away from the one on screen", () => {
  const clear = { busy: false, voiceOpen: false, draftNonEmpty: false, hasAttachments: false };

  it("is allowed when nothing here would be lost", () => {
    expect(canOpenOtherConversation(clear)).toBe(true);
  });

  it("is refused while a turn is running, a voice session is open, a draft is unsent, or a file is attached", () => {
    expect(canOpenOtherConversation({ ...clear, busy: true })).toBe(false);
    expect(canOpenOtherConversation({ ...clear, voiceOpen: true })).toBe(false);
    expect(canOpenOtherConversation({ ...clear, draftNonEmpty: true })).toBe(false);
    expect(canOpenOtherConversation({ ...clear, hasAttachments: true })).toBe(false);
  });
});

describe("waiting items still cover the union", () => {
  it("keys a capability approval too, so the busy lock and React's own key agree on identity", () => {
    const capability: WaitingItem = {
      kind: "capability-approval",
      approvalId: "cap-1",
      packageId: "pkg",
      version: "1.0.0",
      ref: "fs.read",
      description: "d",
      operationDigest: "sha256:x",
      requestedAt: READ_AT as Instant,
      expiresAt: READ_AT as Instant,
    };
    expect(waitingKey(capability)).toBe("capability-approval:cap-1");
  });
});
