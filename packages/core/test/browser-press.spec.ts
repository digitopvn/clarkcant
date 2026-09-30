import { describe, expect, it } from "vitest";

import type { EffectRecord } from "@clarkcant/contracts";

import {
  BROWSER_PRESS_LABEL_MAX,
  BROWSER_PRESS_PAGE_MAX,
  browserPress,
  browserPressIntent,
  browserPressOfIntent,
  describeBrowserPress,
  quotedEffectIntent,
} from "../src/index.ts";

function effectWith(intent: string): EffectRecord {
  return {
    effectId: "eff_1",
    taskId: "task_1",
    executorNodeId: "node_a",
    category: "external-write",
    capabilityRef: "browser.playwright@1",
    externalSupportsDedup: false,
    state: "unknown",
    intent,
    operationDigest: "sha256:0",
    preparedAt: "2026-09-30T00:00:00.000Z",
    submitAttempts: 1,
  } as EffectRecord;
}

describe("a press on a page, recorded as data", () => {
  it("reads back from the ledger's intent exactly the press that was written", () => {
    const press = browserPress("Send application", "shop.example/apply");
    const intent = browserPressIntent(press, "tgt_1");

    expect(intent).toBe("browser click “Send application” on shop.example/apply — tgt_1");
    expect(browserPressOfIntent(intent)).toEqual({ verb: "click", label: "Send application", page: "shop.example/apply" });
  });

  it("keeps a label with its own curly quotes, a line break or a dash readable as the same press", () => {
    const press = browserPress("Say “yes”\n now — or never", "shop.example/a — b");
    const read = browserPressOfIntent(browserPressIntent(press, "tgt_1"));

    expect(read).toEqual(press);
    expect(press.label).toBe('Say "yes" now — or never');
    expect(press.page).toBe("shop.example/a - b");
  });

  it("bounds the label and the page", () => {
    const press = browserPress("x".repeat(500), `shop.example/${"p".repeat(500)}`);

    expect(press.label).toHaveLength(BROWSER_PRESS_LABEL_MAX);
    expect(press.page).toHaveLength(BROWSER_PRESS_PAGE_MAX);
    expect(browserPressOfIntent(browserPressIntent(press, "tgt_1"))).toEqual(press);
  });

  it("does not read any other intent as a press", () => {
    expect(browserPressOfIntent("git push origin HEAD — /repo")).toBeUndefined();
    expect(browserPressOfIntent("browser click ref_1 https://shop.example — tgt_1")).toBeUndefined();
    expect(browserPressOfIntent("bấm “Send” trên shop.example/apply — tgt_1")).toBeUndefined();
  });

  it("is worded in the person's language only when it is shown", () => {
    const press = browserPress("Send application", "shop.example/apply");

    expect(describeBrowserPress(press, "en")).toBe("click “Send application” on shop.example/apply");
    expect(describeBrowserPress(press, "vi")).toBe("bấm “Send application” trên shop.example/apply");
  });

  it("names a press in the effect's answers in either language, with no quotes around its own quotes", () => {
    const pressed = effectWith(browserPressIntent(browserPress("Send", "shop.example/apply"), "tgt_1"));

    expect(quotedEffectIntent(pressed, "en")).toBe("the action click “Send” on shop.example/apply");
    expect(quotedEffectIntent(pressed, "vi")).toBe("thao tác bấm “Send” trên shop.example/apply");
    expect(quotedEffectIntent(pressed)).toBe("thao tác bấm “Send” trên shop.example/apply");
    // A command is quoted as it ran, the same in every language.
    expect(quotedEffectIntent(effectWith("git push origin HEAD — /repo"), "en")).toBe("“git push origin HEAD”");
  });
});
