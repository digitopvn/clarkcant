import { describe, expect, it } from "vitest";

import { accumulateAnswerText } from "../src/voice-answer.ts";

/**
 * The producer's half of the answer contract.
 *
 * The consumer's half lives in `voice-gateway.spec.ts`, and it passed while this was broken: that test's `answer`
 * hands over the text so far itself, which is the promise rather than the producer. Measured on a real voice session
 * before this function existed, the frames carried "M", "ình", " ch", "ư" — one fragment each — and the surface
 * replaces what it shows, so the reply appeared not to stream at all. The caller here is the node's entry point, which
 * no test drives, which is why the accumulation is a function with a test rather than three lines inside it.
 */
describe("the answer of a spoken turn", () => {
  it("hands over the text so far, not the fragment that just arrived", () => {
    const seen: string[] = [];
    const emit = accumulateAnswerText((text) => seen.push(text));

    for (const fragment of ["Vâng", ", em", " đang", " trả lời"]) {
      emit({ type: "text-delta", text: fragment });
    }

    expect(seen).toEqual(["Vâng", "Vâng, em", "Vâng, em đang", "Vâng, em đang trả lời"]);
  });

  it("ignores everything that is not text, because those events belong to the conversation", () => {
    const seen: string[] = [];
    const emit = accumulateAnswerText((text) => seen.push(text));

    emit({ type: "reasoning-delta", text: "nghĩ" });
    emit({ type: "tool-start" });
    // A text event with no text is not a fragment of an answer, so it must not report an unchanged update either:
    // a surface that redraws on those spends a frame per event to show what is already there.
    emit({ type: "text-delta" });
    emit({ type: "text-delta", text: "xin chào" });

    expect(seen).toEqual(["xin chào"]);
  });
});
