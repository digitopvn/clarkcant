import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DECISION_PROVIDER_PREFERENCE,
  type DecisionProviderSelection,
  type Instant,
  PERSON_ONLY_REFUSAL,
  isPersonOnlyRoute,
} from "@clarkcant/contracts";
import { type Database, credentialNames, getSecretMetadata, migrate, openDatabase, readCredential } from "@clarkcant/storage";

import { decisionProviderView } from "../src/application/decision-provider-settings.ts";
import { storeCredentialFields } from "../src/application/credential-vault.ts";
import { decisionConfigFromEnv, liveDecisionConfig, readDecisionSelection } from "../src/decision-config.ts";
import type { DecisionTransport } from "../src/decision-transport.ts";
import { createJevBudget, selectTemplate } from "../src/jev-selector.ts";
import type { MiniAppCandidateSet } from "../src/mini-app-candidates.ts";
import { handleDecisionProviderRoutes } from "../src/routes/decision-provider.ts";
import type { GatewayRequest } from "../src/routes/http.ts";
import type { NodeServices } from "../src/services.ts";

/**
 * Choosing the decision provider in Settings, and where its key comes from.
 *
 * The decision model is a role separate from the conversation model; these tests hold the rules the Settings card
 * rests on: the person's choice wins over the environment but never over local-only, it applies from the next decision
 * without a restart, one call never mixes two providers' key and endpoint, and nothing the API answers carries a key.
 */

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OWNER = "owner_1";
const AT = "2026-10-08T09:00:00.000Z";

describe("the person's choice laid over the environment", () => {
  it("wins over CLARKCANT_DECISION_PROVIDER and says so", () => {
    const env = { CLARKCANT_DECISION_PROVIDER: "typesafe", TYPESAFE_API_KEY: "ts", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "cf" };
    const fromEnv = decisionConfigFromEnv(env);
    expect(fromEnv).toMatchObject({ provider: "typesafe", selectedBy: "environment" });
    const chosen = decisionConfigFromEnv(env, undefined, { provider: "cloudflare", model: "clef-flash" });
    expect(chosen).toMatchObject({ provider: "cloudflare", selectedBy: "settings", model: "clef-flash", apiKey: "cf" });
    expect(chosen.endpoint).toContain(`/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef-flash`);
  });

  it("reports the default when nothing names a provider", () => {
    expect(decisionConfigFromEnv({}).selectedBy).toBe("default");
    expect(decisionConfigFromEnv({}, undefined, null).selectedBy).toBe("default");
  });

  it("uses the account id chosen in Settings over the environment's", () => {
    const other = "fedcba9876543210fedcba9876543210";
    const config = decisionConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "cf" }, undefined, {
      provider: "cloudflare",
      model: "clef",
      accountId: other,
    });
    expect(config.endpoint).toContain(`/accounts/${other}/`);
  });

  it("never sends from a local-only node, whatever is chosen", () => {
    for (const selection of [
      { provider: "typesafe" },
      { provider: "cloudflare", model: "clef", accountId: ACCOUNT },
      { provider: "openrouter", model: "typesafe/jev-1.13" },
    ] as DecisionProviderSelection[]) {
      const config = decisionConfigFromEnv(
        { CLARKCANT_JEV_LOCAL_ONLY: "1", TYPESAFE_API_KEY: "ts", CLOUDFLARE_API_TOKEN: "cf", OPENROUTER_API_KEY: "or" },
        undefined,
        selection,
      );
      expect(config.localOnly).toBe(true);
      expect(config.enabled).toBe(false);
    }
  });

  it("does not carry another provider's model into a TypeSafe choice", () => {
    const config = decisionConfigFromEnv(
      { CLARKCANT_DECISION_PROVIDER: "cloudflare", CLARKCANT_DECISION_MODEL: "clef", TYPESAFE_API_KEY: "ts" },
      undefined,
      { provider: "typesafe" },
    );
    expect(config).toMatchObject({ provider: "typesafe", model: "jev-1.13.0", endpointRefusal: undefined, enabled: true });
  });
});

describe("a running node", () => {
  const candidates: MiniAppCandidateSet = {
    locale: "en-US",
    templates: [
      { templateId: "overview", templateVersion: "1", label: "Work overview", slots: ["trend"] },
      { templateId: "focused", templateVersion: "1", label: "One chart only", slots: ["trend"] },
    ],
    definitions: [],
    data: [],
  };
  const choice = { type: "choice", choice: "overview@1", probabilities: { "overview@1": 0.95, "focused@1": 0.04, none: 0.01 }, confidence: 0.93 };

  it("switches provider from the next decision, without a restart", async () => {
    let selection: DecisionProviderSelection | null = null;
    const env = { TYPESAFE_API_KEY: "ts-key", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "cf-key" };
    const config = liveDecisionConfig(env, undefined, {}, () => selection);
    const seen: { url: string; apiKey: string; model: string }[] = [];
    const transport: DecisionTransport = async (request) => {
      const model = (request.body as { model: string }).model;
      seen.push({ url: request.url, apiKey: request.apiKey, model });
      const answer = { model, answers: { template: choice } };
      return { status: 200, body: request.url.includes("cloudflare") ? { success: true, result: answer } : answer };
    };
    const decide = () =>
      selectTemplate({ config, transport }, { intent: "overview", candidateSet: candidates, budget: createJevBudget(config) });

    expect((await decide()).status).toBe("selected");
    selection = { provider: "cloudflare", model: "clef" };
    expect((await decide()).status).toBe("selected");
    selection = null;
    expect((await decide()).status).toBe("selected");

    expect(seen.map((call) => [new URL(call.url).host, call.apiKey, call.model])).toEqual([
      ["api.typesafe.ai", "ts-key", "jev-1.13.0"],
      ["api.cloudflare.com", "cf-key", "clef"],
      ["api.typesafe.ai", "ts-key", "jev-1.13.0"],
    ]);
  });

  it("never pairs one provider's key with another's endpoint when the choice changes mid-call", async () => {
    let reads = 0;
    // The choice flips on every read: a call that resolved each field separately would mix the two providers.
    const flipping = (): DecisionProviderSelection =>
      reads++ % 2 === 0 ? { provider: "typesafe" } : { provider: "cloudflare", model: "clef", accountId: ACCOUNT };
    const config = liveDecisionConfig({ TYPESAFE_API_KEY: "ts-key", CLOUDFLARE_API_TOKEN: "cf-key" }, undefined, {}, flipping);
    const seen: { url: string; apiKey: string; model: string }[] = [];
    const transport: DecisionTransport = async (request) => {
      seen.push({ url: request.url, apiKey: request.apiKey, model: (request.body as { model: string }).model });
      return { status: 503, body: undefined };
    };
    for (let index = 0; index < 6; index += 1) {
      await selectTemplate({ config, transport }, { intent: "overview", candidateSet: candidates, budget: createJevBudget(config) });
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      const cloudflare = new URL(call.url).host === "api.cloudflare.com";
      expect(call.apiKey).toBe(cloudflare ? "cf-key" : "ts-key");
      expect(call.model).toBe(cloudflare ? "clef" : "jev-1.13.0");
    }
  });
});

describe("the decision provider API", () => {
  let dir: string;
  let db: Database;
  let ids = 0;
  const envOf = new WeakMap<object, NodeJS.ProcessEnv>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-decision-"));
    db = openDatabase({ path: join(dir, "node.sqlite") });
    migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function services(env: NodeJS.ProcessEnv): Pick<NodeServices, "runtime" | "conductor" | "jev"> {
    const now = () => AT as Instant;
    const config = liveDecisionConfig(
      env,
      (provider) => readCredential(db, OWNER, { typesafe: "typesafe", cloudflare: "decision:cloudflare", openrouter: "decision:openrouter" }[provider]),
      {},
      () => readDecisionSelection({ db, now }, OWNER),
    );
    const svc = {
      runtime: { db, identity: { ownerPrincipalId: OWNER, nodeId: "node_1" } } as unknown as NodeServices["runtime"],
      conductor: { newId: (prefix: string) => `${prefix}_${String(++ids)}` } as unknown as NodeServices["conductor"],
      jev: { config, deps: { config }, providerCallCount: () => 0, telemetry: () => [] },
    };
    envOf.set(svc, env);
    return svc;
  }

  function call(svc: ReturnType<typeof services>, method: string, path: string, body?: unknown) {
    const segments = path.split("/").filter((segment) => segment !== "");
    const request: GatewayRequest = { method, path, query: {}, headers: {}, body: body === undefined ? "" : JSON.stringify(body) };
    const response = handleDecisionProviderRoutes({ services: svc, request, segments, at: () => AT, env: envOf.get(svc) ?? {} });
    expect(response).toBeDefined();
    return response!;
  }

  function bodyOf(response: { body: unknown }): Record<string, unknown> {
    return response.body as Record<string, unknown>;
  }

  it("reports the effective provider, model, credential source and status, and no value", () => {
    const svc = services({ TYPESAFE_API_KEY: "env-secret-value" });
    const response = call(svc, "GET", "/decision-provider");
    expect(response.status).toBe(200);
    const view = bodyOf(response).decisionProvider as Record<string, unknown>;
    expect(view).toMatchObject({
      provider: "typesafe",
      selectedBy: "default",
      selection: null,
      model: "jev-1.13.0",
      endpointHost: "api.typesafe.ai",
      status: "ready",
      credential: { name: "typesafe", source: "environment" },
      applies: "next-decision",
      fallback: "deterministic",
    });
    expect((view.providers as { id: string }[]).map((provider) => provider.id)).toEqual(["typesafe", "cloudflare", "openrouter"]);
    expect(JSON.stringify(view)).not.toContain("env-secret-value");
  });

  it("stores a choice, refuses one outside the bounds without echoing it, and applies it at once", () => {
    const svc = services({ TYPESAFE_API_KEY: "ts", CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    const refused = call(svc, "PUT", "/decision-provider", { selection: { provider: "cloudflare", model: "llama", accountId: "../evil" } });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(bodyOf(refused))).not.toContain("../evil");

    const chosen = call(svc, "PUT", "/decision-provider", { selection: { provider: "cloudflare", model: "clef" } });
    expect(chosen.status).toBe(200);
    expect(bodyOf(chosen).decisionProvider).toMatchObject({
      provider: "cloudflare",
      selectedBy: "settings",
      model: "clef",
      status: "no-credential",
      credential: { name: "decision:cloudflare", source: "none" },
      account: { source: "environment" },
    });
    expect(svc.jev.config.provider).toBe("cloudflare");

    // A router picks a different model per request, so it could never answer as the pinned slug: refused when saved.
    for (const router of ["openrouter/auto", "openrouter/free"]) {
      const routed = call(svc, "PUT", "/decision-provider", { selection: { provider: "openrouter", model: router } });
      expect(routed.status).toBe(400);
      expect(JSON.stringify(bodyOf(routed))).not.toContain(router);
    }
    expect(call(svc, "PUT", "/decision-provider", { selection: { provider: "openrouter", model: "cloudflare/clef" } }).status).toBe(200);

    const followEnv = call(svc, "PUT", "/decision-provider", { selection: null });
    expect(bodyOf(followEnv).decisionProvider).toMatchObject({ provider: "typesafe", selectedBy: "default" });
  });

  it("stores a key under the provider's own name with its one consumer, and removes it", () => {
    const svc = services({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    call(svc, "PUT", "/decision-provider", { selection: { provider: "cloudflare", model: "clef" } });
    const stored = call(svc, "PUT", "/decision-provider/credential", { provider: "cloudflare", value: "cf-card-secret" });
    expect(stored.status).toBe(200);
    expect(JSON.stringify(bodyOf(stored))).not.toContain("cf-card-secret");
    expect(bodyOf(stored).decisionProvider).toMatchObject({ status: "ready", credential: { source: "vault" } });
    expect(svc.jev.config.apiKey).toBe("cf-card-secret");
    expect(getSecretMetadata(db, OWNER, "decision:cloudflare")?.allowedConsumers).toEqual(["decision:cloudflare"]);

    expect(call(svc, "DELETE", "/decision-provider/credential/cloudflare").status).toBe(200);
    expect(credentialNames(db, OWNER)).not.toContain("decision:cloudflare");
    expect(svc.jev.config.apiKey).toBeUndefined();
    expect(call(svc, "DELETE", "/decision-provider/credential/cloudflare").status).toBe(404);
    expect(call(svc, "PUT", "/decision-provider/credential", { provider: "elsewhere", value: "x" }).status).toBe(400);
  });

  it("keeps the generic credential store from writing a decision provider's host-owned name", () => {
    for (const name of ["decision:cloudflare", "decision:openrouter"]) {
      const outcome = storeCredentialFields(
        { db, ownerPrincipalId: OWNER, nodeId: "node_1", newId: (prefix) => `${prefix}_${String(++ids)}` },
        [{ name, value: "planted" }],
      );
      expect(outcome).toMatchObject({ ok: false, code: "DECISION_KEY_IN_SETTINGS" });
    }
    expect(credentialNames(db, OWNER)).toEqual([]);
  });
});

describe("who may change it", () => {
  it("is the person only: no machine surface may choose the provider or its key", () => {
    expect(isPersonOnlyRoute("PUT", "/decision-provider")).toBe(true);
    expect(isPersonOnlyRoute("PUT", "/decision-provider/credential")).toBe(true);
    expect(isPersonOnlyRoute("DELETE", "/decision-provider/credential/cloudflare")).toBe(true);
    expect(isPersonOnlyRoute("PUT", `/preferences/${DECISION_PROVIDER_PREFERENCE}`)).toBe(true);
    expect(isPersonOnlyRoute("POST", `/preferences/${DECISION_PROVIDER_PREFERENCE}/undo`)).toBe(true);
    expect(isPersonOnlyRoute("GET", "/decision-provider")).toBe(false);
    // A machine client refused here is told what it was refused.
    expect(PERSON_ONLY_REFUSAL.message).toContain("decision provider");
  });
});

describe("the view", () => {
  it("names the last call without its body", () => {
    const config = decisionConfigFromEnv({ TYPESAFE_API_KEY: "ts" });
    const view = decisionProviderView({
      config,
      selection: null,
      env: {},
      vault: ["typesafe"],
      telemetry: [
        { requestId: "r1", event: "error", model: "jev-1.13.0", policyVersion: "p", durationMs: 12, status: "unavailable", questionCount: 1, reason: "the provider is rate limiting this node" },
      ],
    });
    expect(view.lastCall).toEqual({ event: "error", status: "unavailable", model: "jev-1.13.0", durationMs: 12, reason: "the provider is rate limiting this node" });
    expect(view.credential).toEqual({ name: "typesafe", source: "vault" });
  });
});
