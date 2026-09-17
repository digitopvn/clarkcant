import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Instant, MessageRecord } from "@clarkcant/contracts";
import { appendMessage, migrate, openDatabase, type Database } from "@clarkcant/storage";

import { decideRuntimeTarget, decideSearchResult, searchDeciderFromEnv } from "../src/jev-decider.ts";
import { createJevBudget, jevConfigFromEnv } from "../src/jev-selector.ts";
import {
  ROUTING_CALIBRATION,
  ROUTING_CALIBRATION_CANDIDATES,
  SEARCH_CALIBRATION,
  SEARCH_CALIBRATION_SEEDS,
} from "./calibration-corpus.ts";
import { type SessionSearchDeps, indexMessages, rankSessions } from "../src/session-search.ts";
import type { RuntimeCandidate } from "../src/runtime-candidates.ts";

/**
 * The calibration run (Phase 9), opt-in.
 *
 * Two labelled corpora — thirty-four search queries and sixteen routing situations — scored twice:
 * once with the deterministic ranking (the measured baseline) and once with the selector. The point
 * is the *comparison*: the default in `searchDeciderFromEnv` is set from this number, and a selector
 * that does not beat the ranking should not be on for search.
 *
 * It is opt-in twice over, like the live smoke: `CLARKCANT_JEV_LIVE=1` **and** a real key. Without
 * both it reports BLOCKED and asserts nothing, because a calibration that silently passes without
 * measuring would be worse than no calibration at all.
 *
 * What it may claim: agreement with human labels on these corpora. What it may not: accuracy in
 * general, latency, or cost — the corpora are small and written in this repository.
 */

const LIVE = process.env.CLARKCANT_JEV_LIVE === "1";
const config = jevConfigFromEnv(process.env);
const canRun = LIVE && config.apiKey !== undefined && !config.localOnly;

interface Score {
  correct: number;
  total: number;
  rate: number;
}

function summarise(correct: number, total: number): Score {
  return { correct, total, rate: total === 0 ? 0 : correct / total };
}

let dir: string;
let db: Database;
let search: SessionSearchDeps;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-calibration-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES ('conv_cal', NULL, 'node_local', ?, ?)",
  ).run("2026-09-17T05:00:00.000Z", "2026-09-17T05:00:00.000Z");

  for (const seed of SEARCH_CALIBRATION_SEEDS) {
    const message: MessageRecord = {
      messageId: seed.id as never,
      conversationId: "conv_cal" as never,
      role: "user",
      blocks: [{ type: "text", format: "plain", content: seed.text, streaming: false }],
      authorNodeId: "node_local" as never,
      createdAt: seed.at as never,
      delivery: "accepted",
    };
    appendMessage(db, message, 0);
    indexMessages(
      { db, nodeId: "node_local", principalId: "prin_owner", timezone: "Asia/Saigon", now: () => seed.at as never },
      { conversationId: "conv_cal", messages: [message], at: seed.at as never },
    );
  }

  search = {
    db,
    nodeId: "node_local",
    principalId: "prin_owner",
    timezone: "Asia/Saigon",
    now: () => "2026-09-17T05:00:00.000Z" as Instant,
    decider: { jev: { config }, budget: () => createJevBudget(config) },
    deciderMode: "jev",
  };
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!canRun)("live calibration (opt-in)", () => {
  it("compares the selector against the ranking on the search corpus", async () => {
    let rankCorrect = 0;
    let jevCorrect = 0;

    for (const entry of SEARCH_CALIBRATION) {
      const ranked = rankSessions(search, { text: entry.query, limit: 3 });
      const refs = ranked.results.map((hit) => hit.ref);
      const rankOk = entry.expected === undefined ? refs.length === 0 : refs.includes(entry.expected);
      if (rankOk) rankCorrect += 1;

      // The decision is applied to the same ranked list, which is what makes the comparison fair.
      const decision = await decideSearchResult(
        { jev: { config }, budget: () => createJevBudget(config) },
        {
          query: entry.query,
          results: ranked.results.map((hit) => ({ ref: hit.ref, snippet: hit.snippet, score: hit.score, source: hit.source })),
        },
      );

      // A choice that names the expected ref counts; a clarification counts as correct only when the
      // ranking was wrong too, because asking is better than answering wrongly.
      const jevOk =
        decision.status === "chosen"
          ? decision.ref === entry.expected
          : decision.status === "clarify"
            ? !rankOk
            : rankOk;

      if (jevOk) jevCorrect += 1;

      // Per-case visibility, because a corpus total does not say *which* case a selector broke.
      process.stderr.write(
        `[calibration] search "${entry.query}" rank=${rankOk ? "ok" : "miss"} jev=${decision.status} ${jevOk ? "ok" : "miss"}\n`,
      );
    }

    const rankScore = summarise(rankCorrect, SEARCH_CALIBRATION.length);
    const jevScore = summarise(jevCorrect, SEARCH_CALIBRATION.length);
    process.stderr.write(
      `[calibration] search: rank ${rankScore.correct}/${rankScore.total} (${(rankScore.rate * 100).toFixed(1)}%) ` +
        `vs jev ${jevScore.correct}/${jevScore.total} (${(jevScore.rate * 100).toFixed(1)}%); ` +
        `default stays "${searchDeciderFromEnv({})}" unless jev is clearly better\n`,
    );

    expect(SEARCH_CALIBRATION.length).toBeGreaterThanOrEqual(30);
    // No assertion that jev wins: the measurement decides, and a corpus this size cannot settle it.
    expect(rankScore.total).toBe(SEARCH_CALIBRATION.length);
  }, 600_000);

  it("compares the selector against the ranking on the routing corpus", async () => {
    const candidates: RuntimeCandidate[] = ROUTING_CALIBRATION_CANDIDATES.map((entry) => ({
      id: entry.id,
      kind: entry.kind as RuntimeCandidate["kind"],
      label: entry.label,
      capabilities: [],
      live: true,
      load: 1,
    }));

    let correct = 0;
    for (const entry of ROUTING_CALIBRATION) {
      const decision = await decideRuntimeTarget(
        { jev: { config }, budget: () => createJevBudget(config) },
        { intent: entry.intent, candidates },
      );
      // The deterministic order is the comparison, and for routing it is the lease that ranks first.
      const rankGuess = candidates[0]?.id;
      const rankOk = rankGuess === entry.expectedId;
      const jevOk =
        decision.status === "selected"
          ? decision.id === entry.expectedId
          : decision.status === "none"
            ? entry.expectedId === undefined
            : rankOk;

      if (jevOk) correct += 1;
      process.stderr.write(
        `[calibration] routing "${entry.intent}" rank=${rankOk ? "ok" : "miss"} jev=${decision.status} ${jevOk ? "ok" : "miss"}\n`,
      );
    }

    const score = summarise(correct, ROUTING_CALIBRATION.length);
    process.stderr.write(
      `[calibration] routing: jev ${score.correct}/${score.total} (${(score.rate * 100).toFixed(1)}%)\n`,
    );
    expect(ROUTING_CALIBRATION.length).toBeGreaterThanOrEqual(15);
  }, 600_000);
});

describe.skipIf(canRun)("live calibration (skipped)", () => {
  it("names what it is waiting for", () => {
    const missing = [
      LIVE ? undefined : "CLARKCANT_JEV_LIVE=1",
      config.apiKey === undefined ? "TYPESAFE_API_KEY" : undefined,
      config.localOnly ? "a non-local-only configuration" : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    expect(missing.length).toBeGreaterThan(0);
    process.stderr.write(
      `[calibration] BLOCKED: jev-vs-rank calibration was not produced. Set ${missing.join(" and ")} to run it. ` +
        `The default is "${searchDeciderFromEnv({})}" until it is measured.\n`,
    );
  });
});
