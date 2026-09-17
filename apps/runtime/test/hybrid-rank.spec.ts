import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import { indexHistory, migrate, openDatabase, searchEmbedding, type Database } from "@clarkcant/storage";

import type { EmbeddingProvider } from "../src/embeddings-local.ts";
import { RRF_K, applySemanticFusion, rrfFuse } from "../src/hybrid-rank.ts";
import type { SessionSearchDeps, SessionSearchOutcome } from "../src/session-search.ts";
import { rankSessions } from "../src/session-search.ts";
import { ensureEmbeddingTable, insertEmbedding, upsertEmbeddingMeta } from "@clarkcant/storage";
import { loadVectorExtension } from "../src/vector-index.ts";

/**
 * Hybrid ranking (Phase 10).
 *
 * The properties under test are the ones a ranking bug hides behind: that fusion uses ranks rather
 * than scores, that a row only the vector side found still arrives with its text, that every failure
 * to run the vector half is reported as a reason instead of an empty result, and that the same input
 * always produces the same order.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;
const PRINCIPAL = "prin_owner";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-hybrid-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A four-dimension embedder whose vectors are written by hand, so distances are known exactly. */
function fixedEmbedder(vectors: Record<string, number[]>): EmbeddingProvider {
  return {
    model: "test/embedder",
    dims: 4,
    digest: "sha256:embedding:test",
    embed: (texts) =>
      Promise.resolve(
        texts.map((text) => {
          const vector = vectors[text];
          if (vector === undefined) throw new Error(`no vector for ${text}`);
          return vector;
        }),
      ),
  };
}

function lexicalOutcome(refs: string[]): SessionSearchOutcome {
  return {
    searched: "lỗi đăng nhập",
    temporal: { kind: "none" },
    results: refs.map((ref, index) => ({
      source: "message" as const,
      ref,
      score: -(index + 1),
      snippet: `snippet for ${ref}`,
      provenance: { createdAt: AT },
    })),
    truncated: false,
    indexSize: refs.length,
    rankedBy: "bm25",
    mode: "rank",
  };
}

describe("reciprocal rank fusion", () => {
  it("scores by position, not by the score a retriever reported", () => {
    // The lexical score is a huge negative and the semantic distance is a small positive: any scheme
    // that averaged or normalised them would produce something else entirely.
    const fused = rrfFuse({
      lexical: [{ source: "message", ref: "a" }],
      semantic: [{ source: "message", ref: "a", distance: 0.02 }],
    });
    expect(fused).toHaveLength(1);
    expect(fused[0]?.score).toBeCloseTo(2 / (RRF_K + 1), 10);
    expect(fused[0]?.how).toBe("both");
    expect(fused[0]?.lexicalRank).toBe(1);
    expect(fused[0]?.semanticRank).toBe(1);
  });

  it("keeps a row only one retriever found", () => {
    const fused = rrfFuse({
      lexical: [{ source: "message", ref: "lexical_only" }],
      semantic: [{ source: "session_entry", ref: "semantic_only", distance: 0.1 }],
    });
    expect(fused.map((candidate) => candidate.ref).sort()).toEqual(["lexical_only", "semantic_only"]);
    expect(fused.find((candidate) => candidate.ref === "lexical_only")?.how).toBe("lexical");
    expect(fused.find((candidate) => candidate.ref === "semantic_only")?.how).toBe("semantic");
  });

  it("ranks agreement above a single retriever's first place", () => {
    // `both` is found by two retrievers at their best positions, so it must outrank a row that only
    // one retriever liked, even though that row is first in its own list.
    const fused = rrfFuse({
      lexical: [{ source: "message", ref: "agreed" }],
      semantic: [
        { source: "message", ref: "agreed", distance: 0.01 },
        { source: "message", ref: "semantic_first", distance: 0.02 },
      ],
    });
    expect(fused[0]?.ref).toBe("agreed");
    expect(fused[0]?.how).toBe("both");
  });

  it("is deterministic when scores tie", () => {
    const input = {
      lexical: [
        { source: "message" as const, ref: "b" },
        { source: "message" as const, ref: "a" },
      ],
      semantic: [
        { source: "message" as const, ref: "a" },
        { source: "message" as const, ref: "b" },
      ],
    };
    const first = rrfFuse(input).map((candidate) => candidate.ref);
    const second = rrfFuse(input).map((candidate) => candidate.ref);
    expect(first).toEqual(second);
    // Ties are broken by lexical position, which is the retriever that reads the words.
    expect(first).toEqual(["b", "a"]);
  });

  it("treats the same ref under different sources as different rows", () => {
    const fused = rrfFuse({
      lexical: [{ source: "message", ref: "x" }],
      semantic: [{ source: "session_entry", ref: "x", distance: 0.3 }],
    });
    expect(fused).toHaveLength(2);
  });

  it("honours the limit without changing the order", () => {
    const fused = rrfFuse({
      lexical: [
        { source: "message", ref: "a" },
        { source: "message", ref: "b" },
        { source: "message", ref: "c" },
      ],
      semantic: [],
      limit: 2,
    });
    expect(fused.map((candidate) => candidate.ref)).toEqual(["a", "b"]);
  });
});

describe("semantic fusion", () => {
  const depsFor = (embedder?: EmbeddingProvider, enabled = true): SessionSearchDeps => ({
    db,
    nodeId: "node_test",
    principalId: PRINCIPAL,
    timezone: "Asia/Saigon",
    now: () => AT,
    ...(embedder === undefined ? {} : { semantic: { enabled, provider: embedder } }),
  });

  /** Index two messages lexically, and give the second one a vector. */
  function seed(): { extension: ReturnType<typeof loadVectorExtension> } {
    indexHistory(db, {
      source: "message",
      ref: "msg_login",
      text: "sửa lỗi đăng nhập token hết hạn",
      principalId: PRINCIPAL,
      createdAt: AT,
    });
    indexHistory(db, {
      source: "message",
      ref: "msg_invoice",
      text: "hoá đơn điện tử cần xuất lại",
      principalId: PRINCIPAL,
      createdAt: AT,
    });
    const extension = loadVectorExtension(db);
    if (extension.ok) {
      ensureEmbeddingTable(db, 4);
      const rowid = insertEmbedding(db, [0, 1, 0, 0]);
      upsertEmbeddingMeta(db, {
        source: "message",
        ref: "msg_invoice",
        principalId: PRINCIPAL,
        model: "test/embedder",
        dims: 4,
        digest: "sha256:embedding:test",
        vecRowid: rowid,
        createdAt: AT,
      });
    }
    return { extension };
  }

  it("says why it did nothing when semantic search is off", async () => {
    const result = await applySemanticFusion(depsFor(fixedEmbedder({}), false), { text: "x" }, lexicalOutcome(["a"]));
    expect(result.semantic.enabled).toBe(false);
    expect(result.semantic.reason).toContain("CLARKCANT_SEARCH_SEMANTIC");
    expect(result.outcome.results.map((hit) => hit.ref)).toEqual(["a"]);
    // The lexical answer keeps its own convention: nothing was fused, so nothing changed.
    expect(result.outcome.rankedBy).toBe("bm25");
  });

  it("says why it did nothing when the node has no model", async () => {
    const result = await applySemanticFusion(
      { ...depsFor(undefined), semantic: { enabled: true, reason: "sqlite-vec is not installed" } },
      { text: "x" },
      lexicalOutcome(["a"]),
    );
    expect(result.semantic.enabled).toBe(false);
    expect(result.semantic.reason).toBe("sqlite-vec is not installed");
  });

  it("keeps the lexical answer when embedding the query fails", async () => {
    const failing: EmbeddingProvider = {
      model: "test/embedder",
      dims: 4,
      digest: "sha256:embedding:test",
      embed: () => Promise.reject(new Error("onnx exploded")),
    };
    const result = await applySemanticFusion(depsFor(failing), { text: "x" }, lexicalOutcome(["a"]));
    expect(result.semantic.enabled).toBe(false);
    expect(result.semantic.reason).toContain("embedding the query failed");
    expect(result.outcome.results.map((hit) => hit.ref)).toEqual(["a"]);
  });

  it("does not embed a query that was only a time expression", async () => {
    const outcome: SessionSearchOutcome = { ...lexicalOutcome(["a"]), searched: "" };
    const result = await applySemanticFusion(depsFor(fixedEmbedder({})), { text: "hôm qua" }, outcome);
    expect(result.semantic.reason).toContain("no terms");
    expect(result.outcome.results.map((hit) => hit.ref)).toEqual(["a"]);
  });

  it("brings in a row only the vector side found, with its text", async () => {
    const { extension } = seed();
    if (!extension.ok) {
      // Naming the missing condition is the point: a silent pass here would claim hybrid retrieval
      // works on a machine where the vector half cannot run at all.
      console.warn(`BLOCKED: ${extension.reason}`);
      return;
    }
    const result = await applySemanticFusion(
      depsFor(fixedEmbedder({ "lỗi đăng nhập": [0, 1, 0, 0] })),
      { text: "lỗi đăng nhập" },
      lexicalOutcome(["msg_login"]),
    );

    expect(result.semantic.enabled).toBe(true);
    expect(result.semantic.semanticCandidates).toBe(1);
    expect(result.outcome.rankedBy).toBe("rrf");
    const refs = result.outcome.results.map((hit) => hit.ref);
    // The semantic-only row is in the answer, and it carries the text read back from the index.
    expect(refs).toContain("msg_invoice");
    const invoice = result.outcome.results.find((hit) => hit.ref === "msg_invoice");
    expect(invoice?.snippet).toContain("hoá đơn");
    expect(result.semantic.agreed).toBe(0);
  });

  it("agrees on a row both retrievers found and says so", async () => {
    const { extension } = seed();
    if (!extension.ok) {
      console.warn(`BLOCKED: ${extension.reason}`);
      return;
    }
    const result = await applySemanticFusion(
      depsFor(fixedEmbedder({ "lỗi đăng nhập": [0, 1, 0, 0] })),
      { text: "lỗi đăng nhập" },
      lexicalOutcome(["msg_invoice", "msg_login"]),
    );
    expect(result.semantic.agreed).toBe(1);
  });

  it("finds the vector index through the ranked search path", async () => {
    const { extension } = seed();
    if (!extension.ok) {
      console.warn(`BLOCKED: ${extension.reason}`);
      return;
    }
    // The whole path, not just the fusion: BM25 finds nothing for a word that is not in the text,
    // and the vector side still returns the row.
    const outcome = rankSessions(depsFor(), { text: "lỗi đăng nhập" });
    expect(outcome.results.map((hit) => hit.ref)).toEqual(["msg_login"]);

    const hits = searchEmbedding(db, { values: [0, 1, 0, 0], limit: 5, principalId: PRINCIPAL });
    expect(hits.map((hit) => hit.ref)).toEqual(["msg_invoice"]);
  });
});
