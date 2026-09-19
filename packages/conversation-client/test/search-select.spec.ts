import { describe, expect, it } from "vitest";

import { matchingOptions, SEARCH_SELECT_MAX_OPTIONS } from "../src/search-select.tsx";

const OPTIONS = [
  { value: "google", label: "google", note: "30 model" },
  { value: "deepseek", label: "deepseek", note: "2 model" },
  { value: "amazon-bedrock", label: "amazon-bedrock", note: "120 model" },
];

describe("narrowing the list as somebody types", () => {
  it("shows everything when nothing has been typed", () => {
    expect(matchingOptions(OPTIONS, "")).toHaveLength(3);
    expect(matchingOptions(OPTIONS, "   ")).toHaveLength(3);
  });

  it("matches anywhere in the name, and in what narrows it", () => {
    // Anywhere rather than from the start: nobody types "amazon-bedrock" when "bedrock" is the part they remember.
    expect(matchingOptions(OPTIONS, "bed").map((option) => option.value)).toEqual(["amazon-bedrock"]);
    expect(matchingOptions(OPTIONS, "SEEK").map((option) => option.value)).toEqual(["deepseek"]);
    // The note is searched too, so "30 model" finds the provider it describes.
    expect(matchingOptions(OPTIONS, "120").map((option) => option.value)).toEqual(["amazon-bedrock"]);
  });

  it("says nothing rather than guessing when nothing matches", () => {
    expect(matchingOptions(OPTIONS, "zzz")).toEqual([]);
  });

  it("bounds what it hands a DOM, because this catalogue runs to hundreds", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({ value: `m${index}`, label: `model-${index}` }));
    expect(matchingOptions(many, "").length).toBe(SEARCH_SELECT_MAX_OPTIONS);
    expect(SEARCH_SELECT_MAX_OPTIONS).toBeLessThan(many.length);
  });
});
