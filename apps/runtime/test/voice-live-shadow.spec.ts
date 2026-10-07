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
    // The first live sentence was never delivered. The second is the late reading of the expired final, so it is not.
    expect(shadow.take()).toBe("mở settings giúp tui");
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

  it("answers the newest sentence whole when a final matched it only after passing over another", () => {
    const { shadow } = shadowAt();
    // The live reading of the delivered sentence is too far off to match, and the next one looks like it.
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "chạy lại test đi nhé bạn", isFinal: false });
    shadow.delivered("chạy lại test đi nha");
    expect(shadow.take()).toBe("chạy lại test đi nhé bạn");
  });

  it("answers every part of a sentence the live session split in two when the alignment is unclear", () => {
    const { shadow, advance } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "mở file voice session giúp tui", isFinal: true });
    shadow.delivered("mở file voice session giúp tui");
    // A final whose live reading never arrives leaves the alignment unclear.
    shadow.delivered("hôm nay trời đẹp quá");
    advance(6000);
    // The live session cuts the sentence in progress into two utterances, and the recognizer fails.
    shadow.hear({ utteranceId: "s:u2", text: "rồi chạy test", isFinal: false });
    shadow.hear({ utteranceId: "s:u3", text: " cho voice session nhé", isFinal: false });
    expect(shadow.take()).toBe("rồi chạy test cho voice session nhé");
  });

  it("does not answer again a sentence fully delivered before the unclear stretch", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "chạy lại test đi nha", isFinal: true });
    // Matched only after passing over the first sentence, so the alignment is unclear, but this one is fully covered.
    shadow.delivered("chạy lại test đi nha");
    shadow.hear({ utteranceId: "s:u3", text: "rồi mở file", isFinal: false });
    shadow.hear({ utteranceId: "s:u4", text: "voice session", isFinal: false });
    expect(shadow.take()).toBe("rồi mở file voice session");
  });

  for (const [lag, stepMs] of [[1, 500], [1, 3000], [2, 500], [3, 3000]] as const) {
    it(`does not answer again sentences whose live reading lags the recognizer by ${lag} (${stepMs} ms apart)`, () => {
      const { shadow, advance } = shadowAt();
      const said = [
        "mở file voice session giúp tui",
        "rồi chạy lại test cho nó",
        "xem log lỗi hôm qua đi",
        "sửa cái hàm đọc cấu hình",
        "thêm một test cho trường hợp này",
        "đẩy nhánh này lên github nhé",
        "tạo pull request cho issue đó",
        "nhờ người khác review giúp tui",
        "cập nhật tài liệu tiếng việt luôn",
        "đóng issue cũ luôn nhé",
      ];
      const hear = (index: number): void => shadow.hear({ utteranceId: `s:u${index}`, text: said[index]!, isFinal: true });
      // Each live reading arrives only after the recognizer delivered the sentences `lag` places after it.
      said.forEach((sentence, index) => {
        shadow.delivered(sentence);
        advance(stepMs);
        if (index >= lag) hear(index - lag);
      });
      for (let index = said.length - lag; index < said.length; index += 1) hear(index);
      expect(shadow.take()).toBe("");
    });
  }

  it("does not answer again finals whose live reading arrives after they stopped waiting", () => {
    const { shadow, advance } = shadowAt();
    const said = ["mở file voice session giúp tui", "rồi chạy lại test cho nó", "xem log lỗi hôm qua đi"];
    for (const sentence of said) shadow.delivered(sentence);
    advance(6000);
    said.forEach((sentence, index) => shadow.hear({ utteranceId: `s:u${index}`, text: sentence, isFinal: true }));
    expect(shadow.take()).toBe("");
  });

  it("still answers a new sentence that only looks like a final which stopped waiting", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("mở file voice session giúp tui");
    advance(6000);
    shadow.hear({ utteranceId: "s:u1", text: "mở file voice session giúp tui", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "mở file voice session của bạn đi", isFinal: false });
    expect(shadow.take()).toBe("mở file voice session của bạn đi");
  });

  it("answers a sentence said again after a final that stopped waiting excused its first reading", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("chạy lại test cho tui");
    advance(6000);
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại test cho tui", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "chạy lại test cho tui", isFinal: false });
    expect(shadow.take()).toBe("chạy lại test cho tui");
  });

  it("answers a live sentence heard long after a final that stopped waiting, even if it reads the same", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("chạy lại test cho tui");
    advance(60_000);
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại test cho tui", isFinal: false });
    expect(shadow.take()).toBe("chạy lại test cho tui");
  });

  it("answers again a sentence too short to tell apart, rather than risk losing it", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "đồng ý", isFinal: true });
    shadow.delivered("đồng ý");
    expect(shadow.take()).toBe("đồng ý");
  });

  it("answers every undelivered sentence when nothing is unclear, and starts empty afterwards", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "mở file voice session", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "rồi chạy test", isFinal: false });
    expect(shadow.take()).toBe("mở file voice session rồi chạy test");
    expect(shadow.take()).toBe("");
  });
});
