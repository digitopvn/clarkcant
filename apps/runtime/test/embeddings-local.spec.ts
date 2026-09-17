import { describe, expect, it } from "vitest";

import { E5_DIMS, E5_MODEL_ID, loadLocalEmbedder, modelDigest } from "../src/embeddings-local.ts";

/**
 * The local embedder (Phase 10).
 *
 * The unit-level property is that absence is a *state with a reason* rather than a crash: a machine
 * without the optional runtime, or with a model that cannot be fetched, must leave the node
 * searching lexically and able to say why.
 *
 * Whether the model is *good* is not a unit test. It is measured against the Phase 8 corpus by
 * `plans/reports/verification-260917-1750-semantic-retrieval-hybrid.md`, which is where the numbers
 * that decide the default live. The live block below is opt-in for the same reason the Jev live tests
 * are: it downloads a model and takes seconds, so it does not belong in the definition of done.
 */

const LIVE = process.env.CLARKCANT_EMBEDDINGS_LIVE === "1";

describe("model identity", () => {
  it("names the artifact, stably", () => {
    const first = modelDigest({ modelId: E5_MODEL_ID, dtype: "q8" });
    const second = modelDigest({ modelId: E5_MODEL_ID, dtype: "q8" });
    expect(first).toBe(second);
    expect(first.startsWith("sha256:embedding:")).toBe(true);
    // The dtype is part of the identity: a quantized artifact produces different vectors.
    expect(modelDigest({ modelId: E5_MODEL_ID, dtype: "fp32" })).not.toBe(first);
  });
});

describe("loading", () => {
  it("returns a reason, not an exception, when the model cannot be used", async () => {
    const loaded = await loadLocalEmbedder({ modelId: "clarkcant/this-model-does-not-exist" });
    expect(loaded.provider).toBeUndefined();
    expect(loaded.reason).toBeTruthy();
    // One of the two honest outcomes: no runtime installed, or the model could not be loaded.
    expect(loaded.reason).toMatch(/not installed|could not be loaded|not a valid model/);
  });

  it("declares E5-small's width", () => {
    expect(E5_DIMS).toBe(384);
    expect(E5_MODEL_ID).toContain("e5-small");
  });
});

describe.runIf(LIVE)("live embeddings", () => {
  it("embeds related text closer than unrelated text", async () => {
    const loaded = await loadLocalEmbedder();
    if (loaded.provider === undefined) {
      throw new Error(`BLOCKED: ${loaded.reason}`);
    }
    const provider = loaded.provider;
    const [query] = await provider.embed(["sửa lỗi không đăng nhập được"], "query");
    const passages = await provider.embed(
      [
        "Sửa lỗi đăng nhập: token hết hạn không được làm mới",
        "Chạy migration thêm cột owner_principal_id vào datasets",
      ],
      "passage",
    );
    const related = passages[0];
    const unrelated = passages[1];
    if (query === undefined || related === undefined || unrelated === undefined) {
      throw new Error("the embedder returned fewer vectors than inputs");
    }
    const cosine = (a: readonly number[], b: readonly number[]): number =>
      a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
    expect(query).toHaveLength(E5_DIMS);
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });
});
