import { describe, expect, it } from "vitest";

import { formatTokenCount, latestTurnMetrics, statuslineParts } from "../src/statusline.ts";

const card = (metrics: Record<string, unknown>): { blocks: unknown[] } => ({
  blocks: [{ type: "system-card", owner: "host", metrics }],
});

describe("the statusline under the composer", () => {
  it("reads the numbers off the newest turn that reported any", () => {
    const messages = [card({ contextTokens: 1000, contextWindow: 2000 }), { blocks: [{ type: "text" }] }, card({ costUsd: 1 })];
    expect(latestTurnMetrics(messages)).toEqual({ costUsd: 1 });
  });

  it("ignores blocks that are not a status card that carried numbers", () => {
    // A card without metrics, a card that is not a card, and a block that is not an object at all.
    expect(latestTurnMetrics([{ blocks: [] }, { blocks: [null, 7, { type: "system-card" }] }])).toBeUndefined();
  });

  it("says how full the context is, first, because it is the number with a ceiling", () => {
    expect(statuslineParts({ metrics: { contextTokens: 12_300, contextWindow: 1_000_000 } })).toEqual(["12k/1.00M (1%)"]);
  });

  it("states the cache hit rate against the input that could have been cached", () => {
    // 750 read of 1000 total input. Counting it against output would report a rate for a quantity that was
    // never in the cache in the first place.
    expect(statuslineParts({ metrics: { cacheReadTokens: 750, inputTokens: 250 } })).toEqual(["cache 75%"]);
  });

  it("leaves out what was never reported rather than printing it as zero", () => {
    // "cache 0%" and "the provider said nothing about a cache" are different facts, and only one of them is
    // true when the field is absent.
    expect(statuslineParts({ metrics: { outputTokens: 10 } })).toEqual([]);
    expect(statuslineParts({})).toEqual([]);
  });

  it("counts background work by state, and stays quiet when there is none", () => {
    expect(statuslineParts({ background: { running: 2, done: 1, failed: 0 } })).toEqual(["nền: 2 đang chạy, 1 xong"]);
    expect(statuslineParts({ background: { running: 0, done: 0, failed: 0 } })).toEqual([]);
  });

  it("passes a provider's quota line through verbatim", () => {
    expect(statuslineParts({ quota: "zen 0% r 100% w 62% m" })).toEqual(["zen 0% r 100% w 62% m"]);
    expect(statuslineParts({ quota: "" })).toEqual([]);
  });

  it("formats token counts so a reader can compare them at a glance", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(4_200)).toBe("4.2k");
    expect(formatTokenCount(120_000)).toBe("120k");
    expect(formatTokenCount(1_250_000)).toBe("1.25M");
  });
});
