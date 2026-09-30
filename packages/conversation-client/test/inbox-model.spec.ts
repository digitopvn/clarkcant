import { describe, expect, it } from "vitest";

import { type Instant, type Notice, type NoticeSuppression, type WaitingItem, findHiddenCharacter } from "@clarkcant/contracts";

import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import {
  canOpenOtherConversation,
  decideFailureCategory,
  decideFailureMessageKey,
  inboxMarkState,
  inboxMarkText,
  inboxMarkVisible,
  nextNoticeFocusTarget,
  noticeActionGroups,
  noticeConversationTarget,
  noticeDetailsText,
  noticeIdsToMarkRead,
  noticeKindQuieted,
  noticeReconcileEffect,
  noticeReference,
  noticesMayBeCapped,
  noticeSourceKey,
  noticeTone,
  reconcileAlreadyRecorded,
  relativeAge,
  sanitizeReason,
  snoozePresetKey,
  snoozePresets,
  snoozeUntil,
  suppressionDescription,
  timeLeft,
  updateFailureReason,
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

describe("snoozing", () => {
  // Local wall-clock dates, so these hold in whatever time zone the suite runs: the presets are about the person's clock.
  const local = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);

  it("offers an hour, this evening, tomorrow morning and next Monday on a weekday morning", () => {
    // 29 September 2026 is a Tuesday.
    const presets = snoozePresets(local(29, 10, 30));
    expect(presets.map((preset) => preset.id)).toEqual(["hour", "evening", "tomorrow", "next-week"]);
    const until = Object.fromEntries(presets.map((preset) => [preset.id, preset.until]));
    expect(until.hour?.getTime()).toBe(local(29, 11, 30).getTime());
    expect(until.evening?.getTime()).toBe(local(29, 18).getTime());
    expect(until.tomorrow?.getTime()).toBe(local(30, 8).getTime());
    expect(until["next-week"]?.getTime()).toBe(new Date(2026, 9, 5, 8).getTime());
  });

  it("stops offering this evening once it is less than an hour away, and every choice is ahead of now", () => {
    const now = local(29, 17, 5);
    const presets = snoozePresets(now);
    expect(presets.map((preset) => preset.id)).toEqual(["hour", "tomorrow", "next-week"]);
    for (const preset of presets) expect(preset.until.getTime()).toBeGreaterThan(now.getTime());
  });

  it("makes next week a whole week away on a Monday, and the next day on a Sunday", () => {
    // 5 October 2026 is a Monday, 4 October a Sunday.
    expect(snoozePresets(local(35, 9)).find((preset) => preset.id === "next-week")?.until.getTime()).toBe(new Date(2026, 9, 12, 8).getTime());
    expect(snoozePresets(local(34, 9)).find((preset) => preset.id === "next-week")?.until.getTime()).toBe(new Date(2026, 9, 5, 8).getTime());
  });

  it("names every preset in words", () => {
    for (const preset of snoozePresets(local(29, 9))) expect(t(snoozePresetKey(preset.id)).length).toBeGreaterThan(0);
  });

  it("reads a quieted kind from the node's own actions rather than a copy of the list", () => {
    expect(noticeKindQuieted({ ...notice("a"), actions: [{ id: "unsuppress", placement: "menu" }] })).toBe(true);
    expect(noticeKindQuieted({ ...notice("b"), actions: [{ id: "suppress", placement: "menu" }] })).toBe(false);
    expect(noticeKindQuieted(notice("c"))).toBe(false);
  });

  it("offers an unknown effect's two answers as the row's buttons, and only the effect the node named", () => {
    const answering: Notice = {
      ...notice("e"),
      actions: [
        { id: "reconcile-confirmed", placement: "primary", effectId: "eff_1" },
        { id: "reconcile-failed", placement: "secondary", effectId: "eff_1" },
        { id: "open", placement: "menu" },
        { id: "dismiss", placement: "menu" },
      ],
    };

    expect(noticeActionGroups(answering).buttons.map((action) => action.id)).toEqual(["reconcile-confirmed", "reconcile-failed"]);
    expect(noticeReconcileEffect(answering)).toBe("eff_1");
    // Once the node stops offering them, the surface has nothing to answer for.
    expect(noticeReconcileEffect({ ...answering, actions: [{ id: "open", placement: "primary" }] })).toBeUndefined();
  });

  it("tells an answer someone already recorded apart from one that failed", () => {
    expect(reconcileAlreadyRecorded(gatewayError("EFFECT_NOT_UNKNOWN", "already confirmed"))).toBe(true);
    expect(reconcileAlreadyRecorded(gatewayError("EFFECT_NOT_FOUND", "no such effect"))).toBe(false);
    expect(reconcileAlreadyRecorded(new Error("network down"))).toBe(false);
  });
  it("keeps snooze and quieting behind More, never as one of the two buttons", () => {
    const { buttons, menu } = noticeActionGroups({
      ...notice("d"),
      actions: [
        { id: "open", placement: "primary" },
        { id: "ask-clark", placement: "secondary" },
        { id: "snooze", placement: "menu" },
        { id: "suppress", placement: "menu" },
      ],
    });
    expect(buttons.map((action) => action.id)).toEqual(["open", "ask-clark"]);
    expect(menu.map((action) => action.id)).toEqual(["snooze", "suppress"]);
  });

  it("works out a preset's time when it is pressed, so an evening that passed with the menu open is not offered", () => {
    // Drawn at 16:50, pressed at 17:10: the evening the menu showed is less than an hour away by then.
    expect(snoozeUntil("evening", local(29, 16, 50))?.getTime()).toBe(local(29, 18).getTime());
    expect(snoozeUntil("evening", local(29, 17, 10))).toBeUndefined();
    expect(snoozeUntil("hour", local(29, 17, 10))?.getTime()).toBe(local(29, 18, 10).getTime());
  });
});

describe("a quieted kind, in words", () => {
  const base = { suppressionId: "nsp_1", category: "alert", example: "Việc tự động bị từ chối", createdAt: READ_AT as Instant } as const;
  const words = (suppression: NoticeSuppression): string => {
    const parts = suppressionDescription(suppression);
    return `${t(parts.scopeKey).replace("{label}", parts.label).replace("{source}", t(noticeSourceKey(suppression.sourceKind)))} — ${t(parts.levelKey)}`;
  };

  it("names the automation, repository, package or node it is limited to, and the level", () => {
    expect(words({ ...base, sourceKind: "automation", severity: "warning", scope: "automation:int_a", scopeLabel: "Dọn repo A" })).toBe(
      "Việc tự động “Dọn repo A” — mức cảnh báo",
    );
    expect(words({ ...base, sourceKind: "automation", severity: "warning", scope: "source:github:acme/x", scopeLabel: "acme/x" })).toBe(
      "Nguồn tín hiệu “acme/x” — mức cảnh báo",
    );
    expect(words({ ...base, sourceKind: "package", category: "update", severity: "info", scope: "package:demo", scopeLabel: "demo" })).toBe(
      "Gói “demo” — mức thông tin",
    );
  });

  it("says plainly when it covers a whole source, and falls back to the scope itself when no label was stored", () => {
    expect(words({ ...base, sourceKind: "background", category: "result", severity: "success" })).toBe("Mọi thông báo loại “Việc nền” — mức thành công");
    expect(words({ ...base, sourceKind: "peer", severity: "error", scope: "peer:node_b" })).toBe("Node “node_b” — mức lỗi");
  });
});

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

describe("why an update from a notice did not install", () => {
  it("says a version the directory does not list in the reader's language, not the node's English sentence", () => {
    const reason = updateFailureReason(gatewayError("NOT_IN_DIRECTORY", "com.example.notes@1.0.1 is not in the directory"), "1.0.1", t);
    expect(reason).toBe("danh mục gói không có bản 1.0.1.");
    expect(t("inbox.updateFailed").replace("{reason}", reason)).toBe(
      "Không cập nhật được: danh mục gói không có bản 1.0.1. Bản đang cài vẫn giữ nguyên.",
    );
  });

  it("ends any other reason with a full stop, and adds none to one that already has it", () => {
    expect(updateFailureReason(gatewayError("PACKAGE_DIGEST_MISMATCH", "the download does not match its digest"), "2.0.0", t)).toBe(
      "the download does not match its digest.",
    );
    expect(updateFailureReason(new TypeError("network down!"), "2.0.0", t)).toBe("network down!");
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

describe("a notice's actions", () => {
  it("draws at most two as buttons, primary first, and puts the rest behind More", () => {
    const shown = {
      ...notice("ntf_1"),
      actions: [
        { id: "add-to-context", placement: "menu" },
        { id: "ask-clark", placement: "secondary" },
        { id: "open", placement: "primary" },
        { id: "dismiss", placement: "menu" },
      ],
    } satisfies Notice;
    const { buttons, menu } = noticeActionGroups(shown);
    expect(buttons.map((action) => action.id)).toEqual(["open", "ask-clark"]);
    expect(menu.map((action) => action.id)).toEqual(["add-to-context", "dismiss"]);
  });

  it("keeps Open and Dismiss for a notice read from a node that does not work actions out", () => {
    expect(noticeActionGroups({ ...notice("ntf_1"), conversationId: "conv_1" }).buttons.map((action) => action.id)).toEqual([
      "open",
      "dismiss",
    ]);
    expect(noticeActionGroups(notice("ntf_2")).buttons.map((action) => action.id)).toEqual(["dismiss"]);
  });

  it("opens the conversation its subject names before the one it was written in", () => {
    expect(noticeConversationTarget({ ...notice("ntf_1"), conversationId: "conv_a" })).toBe("conv_a");
    expect(
      noticeConversationTarget({ ...notice("ntf_1"), conversationId: "conv_a", subject: { kind: "task", taskId: "task_1", conversationId: "conv_b" } }),
    ).toBe("conv_b");
    expect(noticeConversationTarget({ ...notice("ntf_1"), subject: { kind: "package", packageId: "demo" } })).toBeUndefined();
  });

  it("points at the notice with a label a reference can carry", () => {
    const long = { ...notice("ntf_9"), title: `Việc nền  đã\nxong ${"rất dài ".repeat(30)}` };
    const { key, ref } = noticeReference(long);
    expect(key).toBe("notice:ntf_9");
    expect(ref.kind).toBe("notice");
    expect(ref.noticeId).toBe("ntf_9");
    expect(ref.label.length).toBeLessThanOrEqual(120);
    expect(ref.label.startsWith("Việc nền đã xong rất dài")).toBe(true);
    expect(ref.label.endsWith("…")).toBe(true);
    expect(noticeReference({ ...notice("ntf_3"), title: "Xong" }).ref.label).toBe("Xong");
  });
});
describe("a notice's details, as Copy details writes them", () => {
  const en = (key: MessageKey): string => MESSAGES_EN[key];

  it("says the notice's own fields in the panel's language, each kind in words", () => {
    const failed: Notice = {
      ...notice("ntf_7"),
      severity: "error",
      title: "Việc nền bị lỗi",
      body: "Không đọc được tệp.\nĐã giữ bản nháp.",
      subject: { kind: "background-work", workId: "work_42", conversationId: "conv_1" },
    };
    expect(noticeDetailsText(failed, t)).toBe(
      [
        "Thông báo: Việc nền bị lỗi",
        "Nội dung: Không đọc được tệp.",
        "  Đã giữ bản nháp.",
        "Nguồn: Việc nền · Kết quả",
        "Mức độ: Lỗi",
        `Thời điểm: ${READ_AT}`,
        "Về: Việc nền · work_42",
      ].join("\n"),
    );
    expect(noticeDetailsText({ ...failed, body: undefined, sourceKind: "package", category: "update", severity: "info", subject: { kind: "package", packageId: "demo" } }, en)).toBe(
      ["Notice: Việc nền bị lỗi", "Source: Extension · Update", "Severity: Information", `Time: ${READ_AT}`, "About: Extension package · demo"].join("\n"),
    );
  });

  it("writes every hidden and bidi character as a marker, and no field can pass for a line of its own", () => {
    const tricky: Notice = {
      ...notice("ntf_8"),
      // A right-to-left override, a zero-width space and a line break in a one-line field.
      title: "Tệp \u202Egnp.exe\u200B xong\nMức độ: Thành công",
      // A first-strong isolate, a tag character, a carriage return and a line that looks like a label.
      body: "Dòng \u2068một\u2069\r\nMức độ: Thành công \u{E0041}",
      subject: { kind: "task", taskId: "task_\u2066x\u2069" },
    };
    const text = noticeDetailsText(tricky, t);
    expect(findHiddenCharacter(text, { lineBreaks: true })).toBeUndefined();
    expect(text).toContain("Thông báo: Tệp ⟨U+202E⟩gnp.exe⟨U+200B⟩ xong⟨U+000A⟩Mức độ: Thành công");
    expect(text).toContain("Nội dung: Dòng ⟨U+2068⟩một⟨U+2069⟩⟨U+000D⟩\n  Mức độ: Thành công ⟨U+E0041⟩");
    expect(text).toContain("Về: Task · task_⟨U+2066⟩x⟨U+2069⟩");
    // The only line that starts with the severity label is the summary's own.
    expect(text.split("\n").filter((line) => line.startsWith("Mức độ:"))).toEqual(["Mức độ: Thành công"]);
  });

  it("says nothing beyond the notice's own fields: no id, conversation, node, actions, read or snooze state", () => {
    const busy: Notice = {
      ...notice("ntf_SECRET_ID"),
      title: "Nhắc việc đã chạy",
      conversationId: "conv_SECRET",
      originNodeId: "node_SECRET",
      readAt: "2026-09-24T07:05:00.000Z" as Instant,
      snoozedUntil: "2026-09-25T08:00:00.000Z" as Instant,
      actions: [{ id: "open", placement: "primary" }],
      subject: { kind: "automation", intentId: "intent_1", label: "label_SECRET", taskId: "task_SECRET", conversationId: "conv_SECRET_2" },
    };
    const text = noticeDetailsText(busy, t);
    for (const leaked of ["SECRET", "2026-09-24T07:05", "2026-09-25", "open", "automation", "background", "success", "result"]) {
      expect(text, leaked).not.toContain(leaked);
    }
    expect(text).toBe(
      ["Thông báo: Nhắc việc đã chạy", "Nguồn: Việc nền · Kết quả", "Mức độ: Thành công", `Thời điểm: ${READ_AT}`, "Về: Việc tự động · intent_1"].join("\n"),
    );
  });
});