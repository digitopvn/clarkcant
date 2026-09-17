import { createHash } from "node:crypto";

/**
 * Local embeddings (Phase 10).
 *
 * The vector side of Memory & Search: an E5-small ONNX model, run on this machine, with the model id
 * and artifact identity recorded so a silent model swap is detectable. Three boundaries matter here.
 *
 * - **It is optional, and absence is a state, not an error.** A node without the runtime installed
 *   must still search lexically. Every failure returns a *reason* rather than throwing, because the
 *   caller has to be able to say why semantic search is off instead of pretending it ran.
 * - **Nothing here is allowed to reach the network at query time.** The first call downloads the
 *   model into the library's cache; after that the vectors are computed locally. A node that cannot
 *   download simply reports that it has no embedder.
 * - **Query and passage are different inputs.** E5 is trained with prefixes, and embedding a query
 *   the way a passage is embedded measurably degrades retrieval — so the prefix is applied here,
 *   where it cannot be forgotten by a caller.
 */

/** E5-small, multilingual: the plan's choice, and the smallest model that handles Vietnamese. */
export const E5_MODEL_ID = "Xenova/multilingual-e5-small";

/** E5-small's output width. Recorded in the index so a different model cannot be mixed in silently. */
export const E5_DIMS = 384;

export type EmbeddingKind = "query" | "passage";

export interface EmbeddingProvider {
  model: string;
  dims: number;
  /** Identity of the artifact the vectors came from, recorded with every vector. */
  digest: string;
  embed(texts: readonly string[], kind: EmbeddingKind): Promise<number[][]>;
}

export interface EmbeddingLoad {
  provider?: EmbeddingProvider;
  /** Why there is no provider. Always set when `provider` is absent. */
  reason?: string;
}

/** The identity recorded in the index. Declared, not derived from the bytes: see the note below. */
export function modelDigest(input: { modelId: string; dtype: string }): string {
  return `sha256:embedding:${createHash("sha256")
    .update(`${input.modelId}@${input.dtype}`)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * Load the model, or explain why it could not be loaded.
 *
 * The digest identifies the *declared* artifact — id, dtype and so on — and not a hash of the ONNX
 * bytes. Hashing the file would be stronger, but the bytes live inside the library's own cache under
 * a name the library chooses, and a digest computed from a path we do not control would be a promise
 * the code cannot keep. What it does buy is the property that matters at query time: vectors from a
 * different declared model are refused rather than silently mixed.
 */
export async function loadLocalEmbedder(
  options: { modelId?: string; dtype?: string } = {},
): Promise<EmbeddingLoad> {
  const modelId = options.modelId ?? E5_MODEL_ID;
  const dtype = options.dtype ?? "q8";

  let pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<unknown>;
  try {
    // Optional dependency: the install path succeeds without it, and this is the only place that
    // finds out whether it is here.
    // SAFETY: the module is only reachable through the dynamic import, so its shape is unknown to
    // the compiler. The invariant checked immediately below is the only thing this code relies on —
    // that `pipeline` exists and is callable — and anything else is treated as an absent runtime.
    const transformers = (await import("@huggingface/transformers")) as unknown as {
      pipeline?: unknown;
    };
    if (typeof transformers.pipeline !== "function") {
      return { reason: "the embedding runtime is installed but exposes no pipeline" };
    }
    pipeline = transformers.pipeline as typeof pipeline;
  } catch {
    return {
      reason:
        "the local embedding runtime is not installed (optional dependency @huggingface/transformers)",
    };
  }

  let extractor: (texts: string[], options: Record<string, unknown>) => Promise<unknown>;
  try {
    extractor = (await pipeline("feature-extraction", modelId, { dtype })) as typeof extractor;
  } catch (cause) {
    // A model that cannot be fetched or loaded is a supported state: the node searches lexically and
    // says why. The message is kept short because it ends up in a log line, not in a stack trace.
    const detail = cause instanceof Error ? cause.message.split("\n")[0] ?? "" : String(cause);
    return { reason: `the embedding model ${modelId} could not be loaded: ${detail.slice(0, 160)}` };
  }

  const digest = modelDigest({ modelId, dtype });

  return {
    provider: {
      model: modelId,
      dims: E5_DIMS,
      digest,
      async embed(texts: readonly string[], kind: EmbeddingKind): Promise<number[][]> {
        if (texts.length === 0) return [];
        const prefixed = texts.map((text) => `${kind}: ${text}`);
        const output = (await extractor(prefixed as string[], {
          pooling: "mean",
          normalize: true,
        })) as { tolist?: () => number[][] };
        if (typeof output.tolist !== "function") {
          throw new Error("the embedding runtime returned no tensor");
        }
        return output.tolist();
      },
    },
  };
}
