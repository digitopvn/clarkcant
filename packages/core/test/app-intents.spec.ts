import { beforeEach, describe, expect, it } from "vitest";

import {
  APP_INTENT_KINDS,
  APP_INTENT_NOT_UNDERSTOOD,
  type AppIntentKind,
  describeAppIntent,
} from "@clarkcant/contracts";
import { migrate, openDatabase } from "@clarkcant/storage";
import {
  isAppCommandShaped,
  matchAppIntent,
  normaliseIntentText,
  recordAppIntentEvent,
  resolveAppIntent,
} from "../src/app-intents.ts";

/**
 * Matching sentences to application intents.
 *
 * The two claims worth testing are the two rules: every documented way of asking maps to exactly one
 * intent, and a sentence that is not a command is left alone. The second is the one that would do
 * damage if it broke, because a registry that swallows real questions is worse than no registry.
 */

const AT = "2026-09-19T07:00:00.000Z" as never;
const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function mint() {
  return TOKEN;
}

/**
 * The phrases the documentation promises, written here rather than read out of the implementation:
 * a table tested against itself proves nothing.
 */
const DOCUMENTED: readonly { kind: AppIntentKind; vietnamese: readonly string[]; english: string }[] = [
  {
    kind: "voice.end",
    vietnamese: ["kết thúc phiên thoại", "dừng phiên thoại lại giúp tôi", "kết thúc phiên"],
    english: "end the voice session",
  },
  {
    kind: "window.expand",
    vietnamese: ["mở rộng cửa sổ", "phóng to cửa sổ lên", "hiện lại cửa sổ"],
    english: "expand the window",
  },
  {
    kind: "window.minimise",
    vietnamese: ["thu nhỏ cửa sổ xuống thanh tác vụ", "thu nhỏ cửa sổ", "thu nhỏ xuống"],
    english: "minimise the window",
  },
  {
    kind: "window.minimal",
    vietnamese: ["thu nhỏ tối thiểu", "thu về thanh voice", "thu gọn về thanh voice"],
    english: "minimal bar",
  },
  {
    kind: "settings.open",
    vietnamese: ["mở cài đặt", "mở settings", "mở phần cài đặt"],
    english: "open settings",
  },
  {
    kind: "settings.tab",
    vietnamese: ["mở tab model", "đổi sang tab công cụ", "chuyển sang tab thiết bị"],
    english: "switch to the models tab",
  },
  {
    kind: "nav.home",
    vietnamese: ["về màn hình bắt đầu", "về trang chủ", "về nhà"],
    english: "go home",
  },
  {
    kind: "composer.attach",
    vietnamese: ["mở hộp thoại chọn tệp", "đính kèm tệp", "chọn tệp đính kèm"],
    english: "attach a file",
  },
  {
    kind: "app.quit",
    vietnamese: ["thoát ứng dụng", "thoát app", "đóng ứng dụng"],
    english: "quit the app",
  },
];

describe("every documented way of asking maps to one intent", () => {
  it("matches each Vietnamese and English phrase to exactly the intent it names", () => {
    for (const entry of DOCUMENTED) {
      for (const phrase of [...entry.vietnamese, entry.english]) {
        const match = matchAppIntent(phrase);
        expect(match, `"${phrase}" should be a command`).toBeDefined();
        expect(match?.kind, `"${phrase}" should be understood`).toBe("intent");
        if (match?.kind !== "intent") throw new Error("unreachable");
        // Exactly one: a phrase that matched two intents would have no defensible answer, and the
        // longest-phrase rule is what makes the answer deterministic rather than table-ordered.
        expect(match.intent.kind, `"${phrase}"`).toBe(entry.kind);
      }
    }
  });

  it("covers every intent kind that exists", () => {
    expect(DOCUMENTED.map((entry) => entry.kind).sort()).toEqual([...APP_INTENT_KINDS].sort());
  });

  it("a long command phrase wins over a short one", () => {
    const minimal = matchAppIntent("thu nhỏ tối thiểu");
    expect(minimal?.kind === "intent" && minimal.intent.kind).toBe("window.minimal");

    // The short phrase still means what it says; it just does not steal the longer request.
    const minimise = matchAppIntent("thu nhỏ cửa sổ");
    expect(minimise?.kind === "intent" && minimise.intent.kind).toBe("window.minimise");
  });

  it("reads the same whether the tone marks arrived or not", () => {
    expect(normaliseIntentText("Thu Nhỏ Tối Thiểu")).toBe("thu nho toi thieu");
    expect(normaliseIntentText("đổi sang tab")).toBe("doi sang tab");
    const accented = matchAppIntent("mở cài đặt");
    const bare = matchAppIntent("mo cai dat");
    expect(accented).toEqual(bare);
  });
});

describe("a command the registry does not know", () => {
  it("says so and produces nothing executable", () => {
    const sentence = "mở cửa sổ trời giúp tôi";
    expect(isAppCommandShaped(sentence)).toBe(true);

    const match = matchAppIntent(sentence);
    expect(match?.kind).toBe("refused");
    if (match?.kind !== "refused") throw new Error("unreachable");
    expect(match.say).toBe(APP_INTENT_NOT_UNDERSTOOD);

    const resolution = resolveAppIntent({ text: sentence, mintConfirmationToken: mint });
    // No intent in any branch: the refusal is not a weak "intent" that a caller might act on.
    expect(resolution.kind).toBe("refused");
    expect("intent" in resolution).toBe(false);
  });

  it("refuses a tab change that names no tab rather than guessing one", () => {
    const match = matchAppIntent("đổi sang tab");
    expect(match?.kind).toBe("refused");
    if (match?.kind !== "refused") throw new Error("unreachable");
    expect(match.say).toContain("tools");
    // And it names only tabs that exist: the Memory tab is not in the list until it is.
    expect(match.say).not.toContain("memory");
  });
});

describe("a work request is not an app intent", () => {
  it("leaves a question that mentions settings to the agent", () => {
    const question = "xem cài đặt của máy chủ này giúp tôi";
    expect(isAppCommandShaped(question)).toBe(false);
    expect(matchAppIntent(question)).toBeUndefined();
    // `none` is the value that means "carry on as before" - the registry does not block it.
    expect(resolveAppIntent({ text: question, mintConfirmationToken: mint }).kind).toBe("none");
  });

  it("leaves a long sentence that opens with a command verb to the agent", () => {
    const prose = "mở tài liệu kiến trúc ra và cho tôi biết phần nào nói về bộ nhớ của ứng dụng này";
    expect(prose.split(" ").length).toBeGreaterThan(8);
    expect(isAppCommandShaped(prose)).toBe(false);
  });

  it("leaves a short work request alone even though it starts with a verb-like word", () => {
    // "them" is not a control verb on purpose: this is work, and refusing it would be a worse failure
    // than not recognising one way of saying "attach a file".
    const request = "thêm ghi chú vào tài liệu";
    expect(request.split(" ").length).toBeLessThan(8);
    expect(isAppCommandShaped(request)).toBe(false);
    expect(resolveAppIntent({ text: request, mintConfirmationToken: mint }).kind).toBe("none");
  });

  it("does not refuse a short work request that opens with a control verb", () => {
    // "mở" opens real commands, so the verb alone cannot decide: this sentence starts with it and is a request for
    // work. What separates the two is that this one is not about the application's own furniture.
    const request = "mở tài liệu giúp tôi";
    expect(request.split(" ").length).toBeLessThan(8);
    expect(isAppCommandShaped(request)).toBe(false);
    expect(resolveAppIntent({ text: request, mintConfirmationToken: mint }).kind).toBe("none");

    // The same verb about the window is a command, and one the registry does not know, so it is refused rather than
    // handed on - which is the whole point of recognising the shape at all.
    expect(matchAppIntent("mở cửa sổ trời")?.kind).toBe("refused");
  });

  it("does not read an ordinary sentence as a command because of a shared bare spelling", () => {
    // Found by a regression rather than by reasoning: "thu" (thu nhỏ) and "thủ" (thủ đô) are the same string once the
    // tone marks are stripped, so a one-word test on the bare form refused this sentence. The shape test reads the
    // marks; the phrase table still does not, because a transcriber may drop them.
    const sentence = "Thủ đô là Paris.";
    expect(normaliseIntentText(sentence)).toBe("thu do la paris.");
    expect(isAppCommandShaped(sentence)).toBe(false);
    expect(resolveAppIntent({ text: sentence, mintConfirmationToken: mint }).kind).toBe("none");
  });

  it("is not fooled by a tab name inside a question", () => {
    expect(resolveAppIntent({ text: "model nào đang chạy vậy", mintConfirmationToken: mint }).kind).toBe("none");
  });
});

describe("quitting always asks first", () => {
  it("makes the eight other intents executable and the ninth a question", () => {
    for (const kind of APP_INTENT_KINDS) {
      const resolution = resolveAppIntent({ intent: { kind }, mintConfirmationToken: mint });
      if (kind === "app.quit") {
        expect(resolution.kind, kind).toBe("needs-confirmation");
        expect("confirmationToken" in resolution).toBe(true);
      } else {
        expect(resolution.kind, kind).toBe("intent");
      }
    }
  });

  it("carries the tab on a settings intent and nothing extra on the others", () => {
    const resolution = resolveAppIntent({
      intent: { kind: "settings.tab", tab: "tools" },
      mintConfirmationToken: mint,
    });
    expect(resolution.kind === "intent" && resolution.intent).toEqual({ kind: "settings.tab", tab: "tools" });
  });
});

describe("the read-back sentence", () => {
  it("exists once for every intent, in Vietnamese, and is a question only for the one that asks", () => {
    const sentences = APP_INTENT_KINDS.map((kind) => describeAppIntent({ kind }));
    for (const [index, sentence] of sentences.entries()) {
      expect(sentence.length, APP_INTENT_KINDS[index]).toBeGreaterThan(0);
      expect(sentence.trim()).toBe(sentence);
    }
    expect(new Set(sentences).size).toBe(APP_INTENT_KINDS.length);
    expect(describeAppIntent({ kind: "app.quit" })).toMatch(/\?$/);
    expect(sentences.filter((sentence) => sentence.endsWith("?"))).toHaveLength(1);
  });
});

describe("the audit record", () => {
  let deps: { db: ReturnType<typeof openDatabase>; nodeId: string; now: () => never; newId: (prefix: string) => string };

  beforeEach(() => {
    const db = openDatabase({ path: ":memory:" });
    migrate(db);
    let counter = 0;
    deps = { db, nodeId: "node_test", now: () => AT, newId: (prefix: string) => `${prefix}_${counter++}` };
  });

  it("records what was done, from where, and never the words that were said", () => {
    recordAppIntentEvent(deps, { intent: { kind: "settings.tab", tab: "tools" }, source: "voice", confirmed: false });

    const row = deps.db
      .prepare("SELECT kind, document, conversation_id FROM events WHERE kind = ?")
      .get("app.intent") as { kind: string; document: string; conversation_id: string | null };

    expect(JSON.parse(row.document)).toEqual({
      kind: "settings.tab",
      tab: "tools",
      source: "voice",
      confirmed: false,
    });
    // Closed shape: the record answers "what was done", so there is no field a spoken sentence could
    // have been parked in.
    expect(Object.keys(JSON.parse(row.document)).sort()).toEqual(["confirmed", "kind", "source", "tab"]);
    expect(row.conversation_id).toBeNull();
  });
});
