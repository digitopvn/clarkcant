import type { HistorySource } from "@clarkcant/storage";
import { historyEntry, searchEmbedding } from "@clarkcant/storage";

import type {
  SessionSearchDeps,
  SessionSearchHit,
  SessionSearchOutcome,
  SessionSearchRequest,
} from "./session-search.ts";

/**
 * Hybrid ranking (Phase 10).
 *
 * Two retrievers with nothing in common but their output: BM25 over text, and exact KNN over vectors.
 * Reciprocal Rank Fusion is what combines them, and it combines *ranks*, not scores — which is the
 * whole point, because a BM25 score and a cosine distance are not on the same scale and any attempt
 * to normalise them against each other would be a tuning problem that never ends.
 *
 * The lexical result is never replaced. A fused list that dropped rows only the text index found
 * would be a semantic search wearing a hybrid label.
 */

/** The standard RRF constant. Larger means later ranks matter less. */
export const RRF_K = 60;

/**
 * How far a vector may be and still count as a match.
 *
 * A KNN query always returns its k nearest rows, however far away they are: "hoá đơn điện tử" has no
 * neighbour in this history, and the index still hands back the least-bad five. Fusing those is how a
 * hybrid search invents results for a query whose honest answer is nothing.
 *
 * The value is the *measured* one, not a guess. Sweeping it over the Phase 8 corpus with E5-small: 0.2
 * and above invented a result for every query whose labelled answer is nothing and dropped top-1 from
 * 31/34 to 25/34; 0.1 invented none and left top-1 at 31/34. Since nothing above 0.1 helps and
 * everything above 0.2 hurts, the conservative end is the default — see the Phase 10 report.
 */
export const SEMANTIC_DISTANCE_CEILING = 0.1;

export interface FusedCandidate {
  source: HistorySource;
  ref: string;
  /** Reciprocal rank fusion score. Higher is better. */
  score: number;
  /** 1-based position in the lexical list, when the text index found it. */
  lexicalRank?: number;
  /** 1-based position in the semantic list, when the vector index found it. */
  semanticRank?: number;
  /** Cosine distance from the vector search. Lower is closer. */
  distance?: number;
  /** Which retrievers found it. A row both found is the strongest signal RRF has. */
  how: "both" | "lexical" | "semantic";
}

/**
 * Fuse two ranked lists.
 *
 * Ties are broken by lexical position and then by ref, so the output is deterministic: two runs over
 * the same index must produce the same order, or the measurement in the report would be measuring
 * the sort.
 */
export function rrfFuse(input: {
  lexical: readonly { source: HistorySource; ref: string }[];
  semantic: readonly { source: HistorySource; ref: string; distance?: number }[];
  k?: number;
  limit?: number;
}): FusedCandidate[] {
  const k = input.k ?? RRF_K;
  const fused = new Map<string, FusedCandidate>();

  const key = (item: { source: HistorySource; ref: string }): string => `${item.source}:${item.ref}`;

  input.lexical.forEach((item, index) => {
    const candidate = fused.get(key(item)) ?? {
      source: item.source,
      ref: item.ref,
      score: 0,
      how: "lexical" as const,
    };
    candidate.score += 1 / (k + index + 1);
    candidate.lexicalRank = index + 1;
    candidate.how = candidate.semanticRank === undefined ? "lexical" : "both";
    fused.set(key(item), candidate);
  });

  input.semantic.forEach((item, index) => {
    const candidate = fused.get(key(item)) ?? {
      source: item.source,
      ref: item.ref,
      score: 0,
      how: "semantic" as const,
    };
    candidate.score += 1 / (k + index + 1);
    candidate.semanticRank = index + 1;
    if (item.distance !== undefined) candidate.distance = item.distance;
    candidate.how = candidate.lexicalRank === undefined ? "semantic" : "both";
    fused.set(key(item), candidate);
  });

  const ordered = [...fused.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftRank = left.lexicalRank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.lexicalRank ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.ref.localeCompare(right.ref);
  });

  return input.limit === undefined ? ordered : ordered.slice(0, input.limit);
}

/** What the semantic side did, including why it did nothing. */
export interface SemanticStatus {
  enabled: boolean;
  /** The distance ceiling that was applied, so a measurement can state it. */
  distanceCeiling?: number;
  /** Always set when semantic search did not contribute. */
  reason?: string;
  model?: string;
  digest?: string;
  /** How many candidates the vector side contributed before fusion. */
  semanticCandidates: number;
  /** How many results in the answer both retrievers found. */
  agreed: number;
  k: number;
}

/**
 * The wiring the fusion reads.
 *
 * The same field `SessionSearchDeps` carries, rather than a parallel set of flags: two places to say
 * "semantic search is on" is one place for them to disagree, and the disagreement would look like a
 * search that silently skipped half its retrievers.
 */
export type HybridDeps = SessionSearchDeps;

export interface HybridOutcome {
  outcome: SessionSearchOutcome;
  semantic: SemanticStatus;
}

const OFF_REASON = "semantic search is off (set CLARKCANT_SEARCH_SEMANTIC=1 to enable it)";

/**
 * Fuse the already-ranked lexical answer with a vector search.
 *
 * The lexical answer is passed in rather than recomputed: it is the same query, and running BM25
 * twice for one request would be paying twice for the same ranks.
 */
export async function applySemanticFusion(
  deps: HybridDeps,
  request: SessionSearchRequest,
  lexical: SessionSearchOutcome,
  options: { distanceCeiling?: number } = {},
): Promise<HybridOutcome> {
  const status: SemanticStatus = { enabled: false, semanticCandidates: 0, agreed: 0, k: RRF_K };

  if (deps.semantic?.enabled !== true) {
    return {
      outcome: lexical,
      semantic: { ...status, distanceCeiling: options.distanceCeiling ?? SEMANTIC_DISTANCE_CEILING, reason: OFF_REASON },
    };
  }
  const embedder = deps.semantic.provider;
  if (embedder === undefined) {
    return {
      outcome: lexical,
      semantic: {
        ...status,
        reason: deps.semantic.reason ?? "this node has no local embedding model",
      },
    };
  }
  if (lexical.searched.trim() === "") {
    // A time-only query has no terms to embed, and embedding an empty string would return the
    // arbitrarily nearest history row — the opposite of what "what happened yesterday" asked for.
    return {
      outcome: lexical,
      semantic: { ...status, reason: "the query had no terms left to embed" },
    };
  }

  const limit = request.limit ?? 10;
  let vector: number[];
  try {
    const embedded = await embedder.embed([lexical.searched], "query");
    const first = embedded[0];
    if (first === undefined) {
      return { outcome: lexical, semantic: { ...status, reason: "the embedder returned no vector" } };
    }
    vector = first;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] ?? "" : String(cause);
    return {
      outcome: lexical,
      semantic: { ...status, reason: `embedding the query failed: ${detail.slice(0, 160)}` },
    };
  }

  const nearest = searchEmbedding(deps.db, {
    values: vector,
    limit: limit * 2,
    principalId: deps.principalId,
  });
  // Dropped before fusion rather than after: a distant neighbour that RRF ranked low is still a
  // result the lexical side has to outrank, and it changes the fused order even when it loses.
  const ceiling = options.distanceCeiling ?? SEMANTIC_DISTANCE_CEILING;
  const semanticHits = nearest.filter((hit) => hit.distance <= ceiling);

  const fused = rrfFuse({
    lexical: lexical.results.map((hit) => ({ source: hit.source, ref: hit.ref })),
    semantic: semanticHits.map((hit) => ({ source: hit.source, ref: hit.ref, distance: hit.distance })),
    limit,
  });

  const byRef = new Map(lexical.results.map((hit) => [`${hit.source}:${hit.ref}`, hit]));
  const results: SessionSearchHit[] = [];
  for (const candidate of fused) {
    const existing = byRef.get(`${candidate.source}:${candidate.ref}`);
    if (existing !== undefined) {
      results.push({ ...existing, score: candidate.score });
      continue;
    }
    // Only the vector side found this row, so its text has to be read back: a result without a
    // snippet is a result the user cannot judge.
    const entry = historyEntry(deps.db, {
      principalId: deps.principalId,
      source: candidate.source,
      ref: candidate.ref,
    });
    if (entry === undefined) continue;
    results.push({
      source: candidate.source,
      ref: candidate.ref,
      score: candidate.score,
      snippet: entry.text.slice(0, 240),
      provenance: {
        ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
        ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
        createdAt: entry.createdAt,
      },
    });
  }

  return {
    outcome: {
      ...lexical,
      results,
      // One convention for the field: an RRF score is higher-is-better, and BM25 is lower-is-better,
      // so the caller is told which one it is holding rather than left to guess.
      rankedBy: "rrf",
    },
    semantic: {
      enabled: true,
      model: embedder.model,
      digest: embedder.digest,
      distanceCeiling: ceiling,
      semanticCandidates: semanticHits.length,
      agreed: fused.filter((candidate) => candidate.how === "both").length,
      k: RRF_K,
    },
  };
}
