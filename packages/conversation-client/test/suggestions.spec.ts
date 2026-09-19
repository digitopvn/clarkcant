import { describe, expect, it } from "vitest";

import { type Suggestion } from "@clarkcant/contracts";

import { type GatewayClient } from "../src/api.ts";
import { fetchSuggestions } from "../src/suggestions.ts";

/**
 * Asking the node what to offer, and what happens when it cannot say.
 *
 * The tests are mostly about failure, because that is the interesting half: a suggestion list is a convenience,
 * and a convenience that can stop the app from opening is not one. Every way of failing to ask ends the same way
 * here - nothing - which is what lets the caller draw its own chips without a second failure mode.
 */

function clientWhose(answer: () => Promise<Suggestion[]>): GatewayClient {
  return { suggestions: answer } as unknown as GatewayClient;
}

const SUGGESTION: Suggestion = {
  suggestionId: "sug_conversation_convone",
  label: "Mở lại phiên gần nhất",
  text: "Cho tui xem lại phiên làm việc gần nhất",
  source: "conversation",
  sourceLabel: "phiên gần nhất",
  at: "2026-09-19T12:00:00.000Z",
} as Suggestion;

describe("a node that cannot answer", () => {
  it("a node that cannot answer leaves the screen alone", async () => {
    const client = clientWhose(async () => {
      throw new Error("the node is not there");
    });

    expect(await fetchSuggestions(client)).toEqual([]);
  });

  it("a node that answers with nothing gets nothing, and that is not an error", async () => {
    expect(await fetchSuggestions(clientWhose(async () => []))).toEqual([]);
  });
});

describe("a node that answers", () => {
  it("what the node offers is passed through unchanged", async () => {
    const offered = await fetchSuggestions(clientWhose(async () => [SUGGESTION]));
    expect(offered).toEqual([SUGGESTION]);
  });

  it("the source label travels with the suggestion, because a chip shows why it is there", async () => {
    const offered = await fetchSuggestions(clientWhose(async () => [SUGGESTION]));
    expect(offered[0]?.sourceLabel).toBe("phiên gần nhất");
    // And the text is the sentence pressing it sends, not a title for something else.
    expect(offered[0]?.text).toContain("phiên làm việc gần nhất");
  });
});
