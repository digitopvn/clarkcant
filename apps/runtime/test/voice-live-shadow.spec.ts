import { describe, expect, it } from "vitest";

import { LiveShadow } from "../src/voice-live-shadow.ts";

function shadowAt(): { shadow: LiveShadow; advance: (ms: number) => void } {
  let now = 0;
  return { shadow: new LiveShadow({ nowMs: () => now }), advance: (ms) => (now += ms) };
}

describe("the live reading kept while a recognizer is the source", () => {
  it("does not answer again a sentence the live session read in two bursts", () => {
    const { shadow, advance } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "sửa lỗi stale", isFinal: false });
    advance(900);
    shadow.hear({ utteranceId: "s:u1", text: " closure trong useEffect", isFinal: false });
    shadow.delivered("sửa lỗi stale closure trong useEffect");
    shadow.hear({ utteranceId: "s:u1", text: " mở file", isFinal: false });
    expect(shadow.take()).toBe("mở file");
  });

  it("does not take a different sentence that shares common words for one already delivered", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "xem cái này không", isFinal: false });
    shadow.delivered("sửa cái này không");
    expect(shadow.take()).toBe("xem cái này không");
  });

  it("keeps the rest of a live utterance that holds two of the recognizer's sentences", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "chạy test đi rồi mở file voice session", isFinal: false });
    shadow.delivered("chạy test đi");
    expect(shadow.take()).toBe("rồi mở file voice session");
  });

  it("does not let a final whose live reading never came cover a later sentence", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("cái này là gì");
    advance(6000);
    shadow.hear({ utteranceId: "s:u1", text: "cái này sao vậy", isFinal: false });
    expect(shadow.take()).toBe("cái này sao vậy");
  });

  it("forgets a waiting final once the live session has moved two sentences on", () => {
    const { shadow } = shadowAt();
    shadow.delivered("cái này là gì vậy");
    shadow.hear({ utteranceId: "s:u1", text: "mở settings giúp tui", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "cái này là gì vậy", isFinal: false });
    expect(shadow.take()).toBe("cái này là gì vậy");
  });

  it("covers a live reading that arrives after the recognizer delivered it", () => {
    const { shadow } = shadowAt();
    shadow.delivered("sửa lỗi stale closure trong useEffect");
    shadow.hear({ utteranceId: "s:u1", text: "sửa lỗi stale closer trong use effect", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "rồi chạy test", isFinal: false });
    expect(shadow.take()).toBe("rồi chạy test");
  });

  it("does not answer a live sentence still catching up with what was delivered", () => {
    const { shadow } = shadowAt();
    shadow.delivered("sửa lỗi stale closure trong useEffect");
    shadow.hear({ utteranceId: "s:u1", text: "sửa lỗi stale", isFinal: false });
    expect(shadow.take()).toBe("");
  });

  it("settles the sentences a later match passes over, and answers only what comes after it", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "hôm qua trời mưa to", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "mở file voice session giúp tui", isFinal: true });
    shadow.hear({ utteranceId: "s:u3", text: "rồi chạy test", isFinal: false });
    shadow.delivered("hôm nay trời đẹp quá");
    shadow.delivered("mở file voice session giúp tui");
    expect(shadow.take()).toBe("rồi chạy test");
  });

  it("answers every undelivered sentence when nothing is unclear, and starts empty afterwards", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "mở file voice session", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "rồi chạy test", isFinal: false });
    expect(shadow.take()).toBe("mở file voice session rồi chạy test");
    expect(shadow.take()).toBe("");
  });
});
