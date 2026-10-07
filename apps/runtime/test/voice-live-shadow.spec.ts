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
    // The first live sentence may be the final's misread reading or a sentence never delivered, and the second its late
    // reading or the same words said again: neither can be proven delivered, so both are answered.
    expect(shadow.take()).toBe("mở settings giúp tui cái này là gì vậy");
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

  it("answers the sentence a final matched, whole, and the one it passed over on the way", () => {
    const { shadow } = shadowAt();
    // The live reading of the delivered sentence is too far off to match, and the next one looks like it.
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "chạy lại test đi nhé bạn", isFinal: false });
    shadow.delivered("chạy lại test đi nha");
    // Two live sentences against one final: one of them was never delivered, and which one cannot be told.
    expect(shadow.take()).toBe("chạy lại tét đi mà chạy lại test đi nhé bạn");
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

  it("answers both command sentences one final faced before the unclear stretch, and the stretch", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "chạy lại test đi nha", isFinal: true });
    // Matched only after passing over the first sentence. Two command sentences against one final means one of them
    // was never delivered: the first may be its misread reading and the second the command said again, or the second
    // its reading and the first never delivered. Answering both costs one duplicate and never loses the other.
    shadow.delivered("chạy lại test đi nha");
    shadow.hear({ utteranceId: "s:u3", text: "rồi mở file", isFinal: false });
    shadow.hear({ utteranceId: "s:u4", text: "voice session", isFinal: false });
    expect(shadow.take()).toBe("chạy lại tét đi mà chạy lại test đi nha rồi mở file voice session");
  });

  it("answers a command said again after its misread reading when the final arrives after both", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "chạy lại test đi nha", isFinal: true });
    // The recognizer delivers one final, which matches the repeat, then fails.
    shadow.delivered("chạy lại test đi nha");
    expect(shadow.take()).toBe("chạy lại tét đi mà chạy lại test đi nha");
  });

  it("answers a command said again after a misread reading the live session split in two", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u3", text: "chạy lại test đi nha", isFinal: true });
    shadow.delivered("chạy lại test đi nha");
    expect(shadow.take()).toBe("chạy lại tét đi mà chạy lại test đi nha");
  });

  it("answers a command said again after its misread reading while an expired final's late reading is kept", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("mở file voice session giúp tui");
    advance(6000);
    // The expired final's late reading accounts for itself, not for the misread sentence after it.
    shadow.hear({ utteranceId: "s:u1", text: "mở file voice session giúp tui", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "chạy lại tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u3", text: "chạy lại test đi nha", isFinal: true });
    shadow.delivered("chạy lại test đi nha");
    expect(shadow.take()).toBe("chạy lại tét đi mà chạy lại test đi nha");
  });

  it("still answers a command said again after its misread reading once a later final matched cleanly", () => {
    const { shadow } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "chạy lại test đi nha", isFinal: true });
    shadow.delivered("chạy lại test đi nha");
    // A clean match afterwards clears the unclear stretch, but not the sentence the first match owes.
    shadow.hear({ utteranceId: "s:u3", text: "mở file voice session giúp tui", isFinal: true });
    shadow.delivered("mở file voice session giúp tui");
    expect(shadow.take()).toBe("chạy lại tét đi mà chạy lại test đi nha");
  });

  it("does not let an expired final take a sentence heard more than 30 s after it as its misread reading", () => {
    const { shadow, advance } = shadowAt();
    // Its live reading never arrives.
    shadow.delivered("sửa lỗi stale closure trong useEffect");
    advance(33_000);
    shadow.delivered("sửa cái hàm đọc cấu hình");
    advance(1000);
    shadow.hear({ utteranceId: "s:u1", text: "xử cài ham độc câu hinh", isFinal: true });
    advance(5000);
    // The person says the command again; its final's live reading arrived, misread.
    shadow.hear({ utteranceId: "s:u2", text: "sửa cái hàm đọc cấu hình", isFinal: false });
    expect(shadow.take()).toBe("xử cài ham độc câu hinh sửa cái hàm đọc cấu hình");
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

  it("answers a command said again after its final was passed over by a later match", () => {
    const { shadow, advance } = shadowAt();
    // The first live reading is too far off to match, so the next final's match passes over it: it was delivered.
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "mở file voice session giúp tui", isFinal: true });
    shadow.delivered("chạy lại test đi nha");
    shadow.delivered("mở file voice session giúp tui");
    advance(20_000);
    shadow.hear({ utteranceId: "s:u3", text: "chạy lại test đi nha", isFinal: false });
    expect(shadow.take()).toBe("chạy lại test đi nha");
  });

  it("does not let a final that was passed over cover a later sentence while it would still be waiting", () => {
    const { shadow, advance } = shadowAt();
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "mở file voice session giúp tui", isFinal: true });
    shadow.delivered("chạy lại test đi nha");
    shadow.delivered("mở file voice session giúp tui");
    advance(2000);
    shadow.hear({ utteranceId: "s:u3", text: "chạy lại test đi nha", isFinal: false });
    expect(shadow.take()).toBe("chạy lại test đi nha");
  });

  it("answers a command said again after a lagging stretch the recognizer caught up with", () => {
    const { shadow, advance } = shadowAt();
    const said = [
      "chạy lại test đi nha",
      "mở file voice session giúp tui",
      "xem log lỗi hôm qua đi",
      "sửa cái hàm đọc cấu hình",
    ];
    // The first live reading is misread; each arrives one sentence after its final.
    const heardAs = ["chạy lại tét đi mà", ...said.slice(1)];
    const hear = (index: number): void =>
      shadow.hear({ utteranceId: `s:u${index}`, text: heardAs[index]!, isFinal: true });
    said.forEach((sentence, index) => {
      shadow.delivered(sentence);
      advance(1000);
      if (index >= 1) hear(index - 1);
    });
    hear(said.length - 1);
    // The next sentence's live reading arrives before its final, so the recognizer catches up past the lagging stretch.
    shadow.hear({ utteranceId: "s:u4", text: "thêm một test cho trường hợp này", isFinal: true });
    shadow.delivered("thêm một test cho trường hợp này");
    advance(15_000);
    shadow.hear({ utteranceId: "s:u5", text: "chạy lại test đi nha", isFinal: false });
    expect(shadow.take()).toBe("chạy lại test đi nha");
  });

  it("answers a command said again after a final whose live reading was misread, and the misreading too", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("chạy lại test đi nha");
    // Its live reading arrives, too far off to match.
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
    advance(20_000);
    shadow.hear({ utteranceId: "s:u2", text: "chạy lại test đi nha", isFinal: false });
    // Whether the first live sentence is the final's reading cannot be proven, so it is answered again.
    expect(shadow.take()).toBe("chạy lại tét đi mà chạy lại test đi nha");
  });

  it("answers whole a new sentence the live session split, whose first part reads as the beginning of an expired final", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("chạy lại test đi");
    advance(6000);
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại test", isFinal: false });
    shadow.hear({ utteranceId: "s:u2", text: " cho voice session nhé", isFinal: false });
    expect(shadow.take()).toBe("chạy lại test cho voice session nhé");
  });

  it("does not answer the late live reading of an expired final while it is still in progress", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("sửa lỗi stale closure trong useEffect");
    advance(6000);
    shadow.hear({ utteranceId: "s:u1", text: "sửa lỗi stale closure", isFinal: false });
    expect(shadow.take()).toBe("");
  });

  it("accepts losing a sentence said again within 30 s when the first live reading never arrived", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("chạy lại test đi");
    advance(20_000);
    // Indistinguishable from the late live reading of that final, which must not be answered again.
    shadow.hear({ utteranceId: "s:u1", text: "chạy lại test đi", isFinal: false });
    expect(shadow.take()).toBe("");
  });

  it("accepts losing a sentence said again within 30 s while more finals lack their live reading than new sentences came", () => {
    const { shadow, advance } = shadowAt();
    // The same command delivered twice, and neither live reading arrives.
    shadow.delivered("sửa cái hàm đọc cấu hình");
    shadow.delivered("sửa cái hàm đọc cấu hình");
    advance(6000);
    // One new sentence uses up only the first of the two finals, so the repeat is taken for the second one's reading.
    shadow.hear({ utteranceId: "s:u1", text: "ừ", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "sửa cái hàm đọc cấu hình", isFinal: false });
    expect(shadow.take()).toBe("ừ");
  });

  it("answers a sentence said again once a new sentence came for each final whose live reading never arrived", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("sửa cái hàm đọc cấu hình");
    shadow.delivered("sửa cái hàm đọc cấu hình");
    advance(6000);
    shadow.hear({ utteranceId: "s:u1", text: "ừ", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "được", isFinal: true });
    shadow.hear({ utteranceId: "s:u3", text: "sửa cái hàm đọc cấu hình", isFinal: false });
    expect(shadow.take()).toBe("ừ được sửa cái hàm đọc cấu hình");
  });

  for (const gapMs of [1500, 3000, 4500]) {
    it(`answers a command said again ${gapMs} ms after a misread reading, which its waiting final then matched`, () => {
      const { shadow, advance } = shadowAt();
      shadow.hear({ utteranceId: "s:u1", text: "chạy lại tét đi mà", isFinal: true });
      // Too far off to match its misread reading, so the final waits.
      shadow.delivered("chạy lại test đi nha");
      advance(gapMs);
      // The person says it again, the waiting final matches the repeat, and the recognizer fails before delivering it.
      shadow.hear({ utteranceId: "s:u2", text: "chạy lại test đi nha", isFinal: true });
      // Two live sentences against one final: both are answered, since which one was never delivered cannot be told.
      expect(shadow.take()).toBe("chạy lại tét đi mà chạy lại test đi nha");
    });
  }

  it("keeps the order of a new sentence and a late reading when an earlier final's reading never arrived", () => {
    const { shadow, advance } = shadowAt();
    shadow.delivered("xem log lỗi hôm qua đi");
    shadow.delivered("mở file voice session giúp tui");
    advance(6000);
    // Only the second final's live reading arrives, late; then a new sentence, then the second command said again.
    shadow.hear({ utteranceId: "s:u1", text: "mở file voice session giúp tui", isFinal: true });
    shadow.hear({ utteranceId: "s:u2", text: "rồi chạy lại test cho nó", isFinal: true });
    shadow.hear({ utteranceId: "s:u3", text: "mở file voice session giúp tui", isFinal: false });
    expect(shadow.take()).toBe("rồi chạy lại test cho nó mở file voice session giúp tui");
  });

  it("answers a command said again when a later final matched past the misread reading an earlier final took", () => {
    const { shadow, advance } = shadowAt();
    // The first final's live reading never arrives; the second's arrives misread, after the final stopped waiting.
    shadow.delivered("xem log lỗi hôm qua đi");
    advance(6000);
    shadow.delivered("mở file voice session giúp tui");
    advance(6000);
    shadow.hear({ utteranceId: "s:u1", text: "mở phai vồi xe giúp lun", isFinal: true });
    // The next final matches its own reading, passing over the misread one.
    advance(2000);
    shadow.hear({ utteranceId: "s:u2", text: "sửa cái hàm đọc cấu hình", isFinal: true });
    shadow.delivered("sửa cái hàm đọc cấu hình");
    // The person says the second command again, and the recognizer fails before delivering it. The second final's
    // reading came before the third final's, so this cannot be its late reading.
    advance(5000);
    shadow.hear({ utteranceId: "s:u3", text: "mở file voice session giúp tui", isFinal: false });
    expect(shadow.take()).toBe("mở file voice session giúp tui");
  });

  it("answers a command said again when earlier finals could only have taken its split reading past later matches", () => {
    const { shadow, advance } = shadowAt();
    // Two finals whose live readings never arrive.
    shadow.delivered("xem log lỗi hôm qua đi");
    shadow.delivered("sửa cái hàm đọc cấu hình");
    advance(6000);
    shadow.hear({ utteranceId: "s:u1", text: "mở file voice session giúp tui", isFinal: true });
    shadow.delivered("mở file voice session giúp tui");
    advance(2000);
    shadow.hear({ utteranceId: "s:u2", text: "đẩy nhánh này lên github nhé", isFinal: true });
    shadow.delivered("đẩy nhánh này lên github nhé");
    advance(2000);
    // This final's live reading arrives misread and split in two, after it stopped waiting.
    shadow.delivered("chạy lại test đi nha");
    advance(6000);
    shadow.hear({ utteranceId: "s:u3", text: "chuy lại", isFinal: true });
    advance(500);
    shadow.hear({ utteranceId: "s:u4", text: "test đi nha", isFinal: true });
    // The person says it again, and the recognizer fails. The two earlier finals' readings would have come before the
    // matched sentences, so the split reading is the last final's and the repeat is not its late reading.
    advance(8000);
    shadow.hear({ utteranceId: "s:u5", text: "chạy lại test đi nha", isFinal: false });
    expect(shadow.take()).toBe("chuy lại test đi nha chạy lại test đi nha");
  });

  it("stays quick with a full backlog of long finals that never found their live reading", () => {
    const { shadow, advance } = shadowAt();
    const syllables = ["chạy", "lại", "test", "mở", "file", "voice", "session", "sửa", "hàm", "đọc", "cấu", "hình", "log"];
    let seed = 1;
    const sentence = (): string =>
      Array.from({ length: 250 }, () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return syllables[seed % syllables.length]!;
      }).join(" ");
    for (let index = 0; index < 16; index += 1) shadow.delivered(sentence());
    advance(6000);
    for (let index = 0; index < 16; index += 1) {
      shadow.hear({ utteranceId: `s:u${index}`, text: sentence(), isFinal: true });
    }
    const started = performance.now();
    shadow.take();
    expect(performance.now() - started).toBeLessThan(500);
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
