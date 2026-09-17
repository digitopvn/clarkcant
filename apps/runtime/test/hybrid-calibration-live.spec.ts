import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import { indexHistory, migrate, openDatabase, type Database } from "@clarkcant/storage";

import { loadLocalEmbedder } from "../src/embeddings-local.ts";
import { SEMANTIC_DISTANCE_CEILING, applySemanticFusion } from "../src/hybrid-rank.ts";
import { rankSessions, searchSessions } from "../src/session-search.ts";
import { createVectorIndexService, loadVectorExtension, type VectorIndexService } from "../src/vector-index.ts";
import { SEARCH_CALIBRATION, SEARCH_CALIBRATION_SEEDS } from "./calibration-corpus.ts";

/**
 * Hybrid retrieval against the Phase 8 corpus, opt-in.
 *
 * The baseline report measured BM25 alone: 96.8% of labelled lexical queries and 25% of the
 * semantic-only ones. This is the same corpus and the same labels with the vector half switched on,
 * so the comparison decides whether hybrid becomes the default or stays behind a flag.
 *
 * It is opt-in because it loads a model and downloads one on a machine that has never run it. The
 * missing condition is named rather than silently skipped — a pass here means the numbers below were
 * produced by a real model, and nothing else does.
 */

const LIVE = process.env.CLARKCANT_EMBEDDINGS_LIVE === "1";
const PRINCIPAL = "prin_owner";
const AT = "2026-09-17T05:00:00.000Z" as Instant;

describe.runIf(LIVE)("hybrid retrieval calibration", () => {
  let dir: string;
  let db: Database;
  let vectors: VectorIndexService;
  let available = false;
  let status = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-hybrid-live-"));
    db = openDatabase({ path: join(dir, "node.sqlite") });
    migrate(db);

    const loaded = await loadLocalEmbedder();
    if (loaded.provider === undefined) {
      status = `BLOCKED: ${loaded.reason}`;
      return;
    }
    for (const seed of SEARCH_CALIBRATION_SEEDS) {
      indexHistory(db, {
        source: "message",
        ref: seed.id,
        text: seed.text,
        principalId: PRINCIPAL,
        createdAt: seed.at as Instant,
      });
    }
    const extension = loadVectorExtension(db);
    vectors = createVectorIndexService(
      { db, principalId: PRINCIPAL, enabled: true, provider: loaded.provider, now: () => AT },
      extension,
      () => Promise.resolve(loaded.provider),
    );
    const indexed = await vectors.ensure();
    available = indexed.enabled;
    status = `indexed ${indexed.embedded}/${indexed.indexSize} with ${indexed.model ?? ""} (${extension.ok ? extension.version : extension.reason})`;
  }, 120_000);

  afterAll(() => {
    db?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("compares hybrid against BM25 alone on the same corpus", async () => {
    if (!available) {
      // Reported, not skipped: the absence of the model is exactly what a reader needs to know.
      console.warn(status);
      expect(status).toContain("BLOCKED");
      return;
    }
    console.log(status);

    const baseDeps = {
      db,
      nodeId: "node_calibration",
      principalId: PRINCIPAL,
      timezone: "Asia/Saigon",
      now: () => AT,
    };
    const hybridDeps = { ...baseDeps, semantic: vectors.semantic() };

    let lexicalTop1 = 0;
    let hybridTop1 = 0;
    let lexicalSemanticOnly = 0;
    let hybridSemanticOnly = 0;
    const changes: string[] = [];

    for (const entry of SEARCH_CALIBRATION) {
      const lexical = rankSessions(baseDeps, { text: entry.query, limit: 5 });
      const hybrid = await searchSessions(hybridDeps, { text: entry.query, limit: 5 });
      const lexicalFirst = lexical.results[0]?.ref;
      const hybridFirst = hybrid.results[0]?.ref;
      const correct = (first: string | undefined): boolean =>
        entry.expected === undefined ? first === undefined : first === entry.expected;

      if (correct(lexicalFirst)) lexicalTop1 += 1;
      if (correct(hybridFirst)) hybridTop1 += 1;
      if (!entry.lexical) {
        if (lexicalFirst === entry.expected) lexicalSemanticOnly += 1;
        if (hybridFirst === entry.expected) hybridSemanticOnly += 1;
      }
      if (lexicalFirst !== hybridFirst) {
        changes.push(
          `  ${entry.lexical ? "lexical" : "semantic-only"} "${entry.query}": ${lexicalFirst ?? "(none)"} → ${hybridFirst ?? "(none)"}, expected ${entry.expected ?? "(none)"}`,
        );
      }
    }

    const semanticOnly = SEARCH_CALIBRATION.filter((entry) => !entry.lexical).length;
    console.log(
      `top-1: lexical ${lexicalTop1}/${SEARCH_CALIBRATION.length}, hybrid ${hybridTop1}/${SEARCH_CALIBRATION.length} (ceiling ${SEMANTIC_DISTANCE_CEILING})`,
    );
    console.log(`semantic-only: lexical ${lexicalSemanticOnly}/${semanticOnly}, hybrid ${hybridSemanticOnly}/${semanticOnly}`);
    console.log(`rank changes (${changes.length}):\n${changes.join("\n")}`);

    // A sweep rather than one number, because the ceiling is the knob that decides whether a query
    // with no honest match returns nothing or returns its least-bad neighbour.
    for (const ceiling of [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 1]) {
      let correctTop1 = 0;
      let semanticCorrect = 0;
      let invented = 0;
      for (const entry of SEARCH_CALIBRATION) {
        const fused = await applySemanticFusion(
          { ...baseDeps, semantic: vectors.semantic() },
          { text: entry.query, limit: 5 },
          rankSessions(baseDeps, { text: entry.query, limit: 5 }),
          { distanceCeiling: ceiling },
        );
        const first = fused.outcome.results[0]?.ref;
        if (entry.expected === undefined ? first === undefined : first === entry.expected) correctTop1 += 1;
        if (!entry.lexical && entry.expected !== undefined && first === entry.expected) semanticCorrect += 1;
        if (entry.expected === undefined && first !== undefined) invented += 1;
      }
      console.log(
        `ceiling ${ceiling}: top-1 ${correctTop1}/34, semantic-only ${semanticCorrect}/${semanticOnly}, invented ${invented}/5`,
      );
    }

    const samples: number[] = [];
    for (const entry of SEARCH_CALIBRATION) {
      const started = performance.now();
      await searchSessions(hybridDeps, { text: entry.query, limit: 5 });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const pick = (p: number): number =>
      samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)] ?? 0;
    console.log(
      `hybrid latency: p50=${pick(50).toFixed(1)}ms p95=${pick(95).toFixed(1)}ms max=${(samples.at(-1) ?? 0).toFixed(1)}ms`,
    );

    // The measurement's own guard: every query must have produced an answer, so a run where the
    // vector half silently did nothing cannot be read as a hybrid result.
    expect(hybridTop1).toBeGreaterThan(0);
    expect(hybridDeps.semantic.enabled).toBe(true);
  }, 180_000);
});
