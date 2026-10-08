import { describe, expect, it } from "vitest";

import { decisionConfigFromEnv } from "../src/decision-config.ts";
import type { DecisionTransport } from "../src/decision-transport.ts";
import {
  type DecideDeps,
  decideContextFocus,
  decideModelRoute,
  decideProject,
  decideRuntimeTarget,
  decideSearchResult,
  decideSessionRebuild,
  decideToolFamily,
  decideTurnAction,
  guardOperation,
} from "../src/jev-decider.ts";
import { createJevBudget, selectTemplate } from "../src/jev-selector.ts";
import type { MiniAppCandidateSet } from "../src/mini-app-candidates.ts";

/**
 * Changing the provider changes who answers, and nothing else.
 *
 * Each decision consumer is run with the same System One answer from each provider - TypeSafe bare, Cloudflare in its
 * envelope, OpenRouter with its own extra fields and a dated snapshot id - and once more with each provider failing. The outcomes must match apart from the model id they name,
 * and the request each provider received must carry the same redacted state and the same offered options. That is
 * the property that keeps a second provider from widening authority or skipping a redaction step: the policy and the
 * payload are built once, before any adapter sees them.
 */

const TYPESAFE_ENV: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "sk-test-not-a-real-key" };
const CLOUDFLARE_ENV: NodeJS.ProcessEnv = {
  CLARKCANT_DECISION_PROVIDER: "cloudflare",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_API_TOKEN: "cf-test-token-not-a-real-one",
  CLARKCANT_DECISION_MODEL: "clef-flash",
};
const OPENROUTER_ENV: NodeJS.ProcessEnv = {
  CLARKCANT_DECISION_PROVIDER: "openrouter",
  CLARKCANT_DECISION_MODEL: "typesafe/jev-1.13",
  OPENROUTER_API_KEY: "or-test-key-not-a-real-one",
};

type Provider = "typesafe" | "cloudflare" | "openrouter";

interface Seen {
  state: unknown;
  questions: unknown;
}

/**
 * Answers whatever it is asked, decisively, for the first option that is not `none`, and says the middle of the Noul
 * band. Wrapped the way each provider wraps it.
 */
function answering(provider: Provider, model: string, seen: Seen[], status = 200): DecisionTransport {
  return async (request) => {
    const body = request.body as { state: unknown; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
    seen.push({ state: body.state, questions: body.questions });
    if (status !== 200) return { status, body: undefined };
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === "noul") {
        answers[id] = { type: "noul", noul: 0.5 };
        continue;
      }
      const options = Object.keys(question.criteria ?? {});
      const chosen = options.find((option) => option !== "none") ?? options[0]!;
      const rest = options.filter((option) => option !== chosen);
      const probabilities = Object.fromEntries([[chosen, 0.95], ...rest.map((option) => [option, 0.05 / rest.length])]);
      answers[id] = { type: "choice", choice: chosen, probabilities, confidence: 0.95 };
    }
    // OpenRouter answers an unversioned slug with the dated snapshot that served it, and adds fields of its own.
    const result =
      provider === "openrouter"
        ? { id: "gen-dec-test", model: `${model}-20260917`, provider: "TypeSafe", answers, usage: { input_tokens: 10, output_tokens: 2, cost: 0 } }
        : { model, answers, usage: { input_tokens: 10, output_tokens: 2 } };
    return { status: 200, body: provider === "cloudflare" ? { success: true, errors: [], messages: [], result } : result };
  };
}

function depsFor(provider: Provider, seen: Seen[], status?: number): DecideDeps {
  const config = decisionConfigFromEnv(
    provider === "cloudflare" ? CLOUDFLARE_ENV : provider === "openrouter" ? OPENROUTER_ENV : TYPESAFE_ENV,
  );
  return { jev: { config, transport: answering(provider, config.model, seen, status) }, budget: () => createJevBudget(config) };
}

const TEMPLATES: MiniAppCandidateSet = {
  locale: "vi-VN",
  templates: [
    { templateId: "overview", templateVersion: "1", label: "Work overview", slots: ["trend"] },
    { templateId: "focused", templateVersion: "1", label: "One chart only", slots: ["trend"] },
  ],
  definitions: [{ id: "canvas.line@1", version: "1.0.0", family: "trend", fields: ["datasetRef:string!"] }],
  data: [{ ref: "ds_tasks", kind: "tasks", label: "Tasks", scale: "small", freshness: "live" }],
};

/** Free text with secret-shaped content, so the payload comparison also proves both saw it redacted. */
const SECRETISH = "dùng key sk-live-abcdef1234567890 và mail an.nguyen@example.com";

const CONSUMERS: Record<string, (deps: DecideDeps) => Promise<unknown>> = {
  "mini-app composition": (deps) =>
    selectTemplate(deps.jev, { intent: SECRETISH, candidateSet: TEMPLATES, budget: deps.budget() }),
  "runtime target": (deps) =>
    decideRuntimeTarget(deps, {
      intent: SECRETISH,
      candidates: [
        { id: "rt_a", kind: "task", label: "build", capabilities: [], live: true, load: 1 },
        { id: "rt_b", kind: "task", label: "tests", capabilities: [], live: true, load: 0 },
      ],
    }),
  "project resolver": (deps) =>
    decideProject(deps, {
      intent: SECRETISH,
      candidates: [
        { id: "p1", name: "clarkcant", relPath: "www/clarkcant", kind: "node", markers: ["package.json"] },
        { id: "p2", name: "clarkcant-web", relPath: "www/clarkcant-web", kind: "node", markers: ["package.json"] },
      ],
    }),
  "operation guard": (deps) =>
    guardOperation(deps, {
      intent: SECRETISH,
      operation: "xoá thư mục build",
      state: { effect: "delete", commandClass: "filesystem" },
      instructions: "",
      constraints: [{ id: "dry-run", description: "chỉ liệt kê" }],
    }),
  "model routing": (deps) =>
    decideModelRoute(deps, {
      task: SECRETISH,
      role: "worker",
      candidates: [
        { alias: "fast", description: "nhanh" },
        { alias: "deep", description: "kỹ" },
      ],
    }),
  "turn action": (deps) => decideTurnAction(deps, { text: SECRETISH, runningMs: 12_000 }),
  "context planner": (deps) =>
    decideContextFocus(deps, {
      query: SECRETISH,
      candidates: [
        { id: "m1", text: "ghi chú một" },
        { id: "m2", text: "ghi chú hai" },
      ],
    }),
  "tool disclosure": (deps) => decideToolFamily(deps, { text: SECRETISH, families: { files: "đọc file", web: "tìm trên web" } }),
  "session rebuild": (deps) => decideSessionRebuild(deps, { idleSeconds: 900, contextTokens: 80_000, topicShift: 0.5, turns: 12 }),
  "search decision": (deps) =>
    decideSearchResult(deps, {
      query: SECRETISH,
      results: [
        { ref: "r1", snippet: "kết quả một", score: 1, source: "messages" },
        { ref: "r2", snippet: "kết quả hai", score: 0.97, source: "messages" },
      ],
    }),
};

/** The outcome without the model id, which is the one field that is supposed to differ. */
function withoutModel(outcome: unknown): unknown {
  if (outcome === null || typeof outcome !== "object") return outcome;
  const { model: _model, probedAt: _probedAt, ...rest } = outcome as Record<string, unknown>;
  return rest;
}

describe("decision consumers behave the same whichever provider answers", () => {
  for (const [name, run] of Object.entries(CONSUMERS)) {
    it(`${name}: same outcome and same redacted payload`, async () => {
      const typesafeSeen: Seen[] = [];
      const cloudflareSeen: Seen[] = [];
      const openrouterSeen: Seen[] = [];
      const typesafe = await run(depsFor("typesafe", typesafeSeen));
      const cloudflare = await run(depsFor("cloudflare", cloudflareSeen));
      const openrouter = await run(depsFor("openrouter", openrouterSeen));

      expect(typesafeSeen.length).toBeGreaterThan(0);
      expect(withoutModel(cloudflare)).toEqual(withoutModel(typesafe));
      expect(withoutModel(openrouter)).toEqual(withoutModel(typesafe));
      expect(cloudflareSeen).toEqual(typesafeSeen);
      expect(openrouterSeen).toEqual(typesafeSeen);
      for (const seen of [cloudflareSeen, openrouterSeen]) {
        expect(JSON.stringify(seen)).not.toContain("sk-live-abcdef1234567890");
        expect(JSON.stringify(seen)).not.toContain("an.nguyen@example.com");
      }
    });

    it(`${name}: same fallback when the provider fails`, async () => {
      const typesafe = await run(depsFor("typesafe", [], 503));
      const cloudflare = await run(depsFor("cloudflare", [], 503));
      const openrouter = await run(depsFor("openrouter", [], 503));
      expect(withoutModel(cloudflare)).toEqual(withoutModel(typesafe));
      expect(withoutModel(openrouter)).toEqual(withoutModel(typesafe));
    });
  }
});
