import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DecisionProviderView } from "@clarkcant/contracts";

import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import {
  DecisionProviderCard,
  type DecisionProviderCardProps,
  decisionHint,
  isPinnedOpenrouterSlug,
  lastCallLine,
  selectionFor,
} from "../src/settings/controls/decision-provider-section.tsx";

/**
 * Settings → AI & Routing → Decision provider, drawn from what the node said.
 *
 * The repo has no DOM test environment, so choosing, typing and saving are asserted in the browser journey
 * (`apps/web/e2e/decision-provider-settings.spec.ts`). What is asserted here is what each state draws: what chose the
 * provider, the decider's state with what to do about it, where each key comes from, the last call, and never a key.
 */

const english = (key: MessageKey): string => MESSAGES_EN[key];
const vietnamese = (key: MessageKey): string => MESSAGES_VI[key];

const PROVIDERS: DecisionProviderView["providers"] = [
  { id: "typesafe", models: null, credential: { name: "typesafe", source: "none" } },
  { id: "cloudflare", models: ["clef", "clef-flash"], credential: { name: "decision:cloudflare", source: "vault" } },
  { id: "openrouter", models: null, credential: { name: "decision:openrouter", source: "environment" } },
];

const READY: DecisionProviderView = {
  provider: "cloudflare",
  selectedBy: "settings",
  selection: { provider: "cloudflare", model: "clef-flash", accountId: "0123456789abcdef0123456789abcdef" },
  model: "clef-flash",
  endpointHost: "api.cloudflare.com",
  status: "ready",
  localOnly: false,
  credential: { name: "decision:cloudflare", source: "vault" },
  account: { source: "settings" },
  applies: "next-decision",
  fallback: "deterministic",
  lastCall: { event: "call", status: "answered", model: "clef-flash", durationMs: 412 },
  providers: PROVIDERS,
};

const DEFAULT_NO_KEY: DecisionProviderView = {
  provider: "typesafe",
  selectedBy: "default",
  selection: null,
  model: "jev-1.13.0",
  endpointHost: "api.typesafe.ai",
  status: "no-credential",
  reason: "no provider credential is configured on this node",
  localOnly: false,
  credential: { name: "typesafe", source: "none" },
  applies: "next-decision",
  fallback: "deterministic",
  providers: PROVIDERS,
};

const noop = (): void => undefined;
const stored = (): Promise<boolean> => Promise.resolve(true);
function draw(props: Partial<DecisionProviderCardProps>, t = english): string {
  return renderToStaticMarkup(
    createElement(DecisionProviderCard, {
      t,
      listing: { status: "ready", view: READY },
      outcomes: {},
      onRetry: noop,
      onChoose: noop,
      onSelect: stored,
      onSaveKey: stored,
      onRemoveKey: noop,
      ...props,
    }),
  );
}

/** The markup of one key card. */
function card(html: string, provider: string): string {
  const start = html.indexOf(`data-decision-key-card="${provider}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</li>", start);
  return html.slice(start, end);
}

describe("the decision provider section", () => {
  it("says which provider decides, with which model, what chose it and that it is ready", () => {
    const html = draw({});
    expect(html).toContain('data-decision-status="ready"');
    expect(html).toContain('data-decision-selected-by="settings"');
    expect(html).toContain("Cloudflare Clef · clef-flash");
    expect(html).toContain(MESSAGES_EN["settings.decision.selectedBy.settings"]);
    expect(html).toContain(MESSAGES_EN["settings.decision.status.ready"]);
    expect(html).toContain("Decisions are sent to api.cloudflare.com.");
    // The selector marks the stored choice, and "Follow environment" is one of its options.
    expect(html).toContain('data-segment="environment"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-segment="cloudflare"/);
  });

  it("says a change applies from the next decision and never asks for a restart", () => {
    const html = draw({});
    expect(html).toContain(MESSAGES_EN["settings.decision.applies"]);
    expect(html.toLowerCase()).not.toContain("restart the");
    expect(html.toLowerCase()).not.toContain("restart required");
  });

  it("shows the last call, and says so when there has been none", () => {
    expect(draw({})).toContain("Last call: clef-flash answered in 412 ms.");
    expect(draw({ listing: { status: "ready", view: DEFAULT_NO_KEY } })).toContain(MESSAGES_EN["settings.decision.lastCall.none"]);
    const failed: DecisionProviderView = {
      ...READY,
      lastCall: { event: "error", status: "unavailable", model: "clef-flash", durationMs: 4000, reason: "the provider timed out" },
    };
    expect(lastCallLine(failed, english)).toBe("Last call got no answer (clef-flash): the provider timed out");
  });

  it("names where each provider's key comes from, offers Remove only for a key saved here, and never echoes a key", () => {
    const html = draw({});
    const cloudflare = card(html, "cloudflare");
    expect(cloudflare).toContain('data-decision-key-source="vault"');
    expect(cloudflare).toContain('data-decision-key-remove="cloudflare"');
    expect(cloudflare).toContain(MESSAGES_EN["settings.decision.key.replace"]);
    const openrouter = card(html, "openrouter");
    expect(openrouter).toContain('data-decision-key-source="environment"');
    expect(openrouter).toContain("OPENROUTER_API_KEY");
    expect(openrouter).not.toContain("data-decision-key-remove");
    const typesafe = card(html, "typesafe");
    expect(typesafe).toContain('data-decision-key-source="none"');
    expect(typesafe).not.toContain("data-decision-key-remove");
    // Every key field is a password field that starts empty: the card has no key to show, and never renders one.
    expect(html.match(/type="password"/g)).toHaveLength(3);
    for (const field of html.match(/<input[^>]*type="password"[^>]*>/g) ?? []) expect(field).toContain('value=""');
  });

  it("draws every state with its reason and what to do about it", () => {
    const states: DecisionProviderView[] = [
      DEFAULT_NO_KEY,
      { ...READY, status: "local-only", localOnly: true, reason: "this node is configured local-only, so no intent is sent to a provider" },
      { ...READY, status: "disabled", reason: "the selector is disabled on this node" },
      {
        ...READY,
        selection: { provider: "cloudflare", model: "clef" },
        account: { source: "none" },
        status: "misconfigured",
        reason: "the Cloudflare decision provider needs CLOUDFLARE_ACCOUNT_ID",
      },
    ];
    for (const view of states) {
      const html = draw({ listing: { status: "ready", view } });
      expect(html).toContain(`data-decision-status="${view.status}"`);
      expect(html).toContain('data-tone="warn"');
      expect(html).toContain('role="alert"');
    }
    expect(decisionHint(DEFAULT_NO_KEY, english)).toContain("There is no key for TypeSafe Jev");
    expect(decisionHint(states[3]!, english)).toBe(
      "the Cloudflare decision provider needs CLOUDFLARE_ACCOUNT_ID. Enter the Cloudflare account id below (or set CLOUDFLARE_ACCOUNT_ID on the node); until then Clark uses its built-in rules.",
    );
    expect(decisionHint(states[1]!, english)).toContain("CLARKCANT_JEV_LOCAL_ONLY");
    expect(decisionHint(states[2]!, english)).toContain("CLARKCANT_JEV_ENABLED");
  });

  it("offers Cloudflare's models and its account id, and OpenRouter a slug field", () => {
    const cloudflare = draw({});
    expect(cloudflare).toContain('data-segmented="decision-cloudflare-model"');
    expect(cloudflare).toContain('data-decision-account-input="true"');
    expect(cloudflare).toContain('data-decision-account-source="settings"');
    expect(cloudflare).toContain('data-decision-account-clear="true"');
    expect(cloudflare).not.toContain("data-decision-openrouter-model");

    const openrouter = draw({
      listing: {
        status: "ready",
        view: { ...READY, provider: "openrouter", selection: { provider: "openrouter", model: "typesafe/jev-1.13" }, model: "typesafe/jev-1.13" },
      },
    });
    expect(openrouter).toContain('data-decision-openrouter-model="true"');
    expect(openrouter).toContain('value="typesafe/jev-1.13"');
    expect(openrouter).not.toContain("data-decision-account-input");
  });

  it("asks for an OpenRouter slug before saving a choice that has none", () => {
    expect(selectionFor("openrouter", DEFAULT_NO_KEY)).toBeUndefined();
    const html = draw({ listing: { status: "ready", view: DEFAULT_NO_KEY }, picked: "openrouter" });
    expect(html).toContain('data-decision-model-needed="true"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-segment="openrouter"/);
  });

  it("maps each choice to the selection the node stores", () => {
    expect(selectionFor("environment", READY)).toBeNull();
    expect(selectionFor("typesafe", READY)).toEqual({ provider: "typesafe" });
    // The model and account id already chosen are kept; a fresh choice takes the first Clef model.
    expect(selectionFor("cloudflare", READY)).toEqual(READY.selection);
    expect(selectionFor("cloudflare", DEFAULT_NO_KEY)).toEqual({ provider: "cloudflare", model: "clef" });
    expect(selectionFor("openrouter", { ...DEFAULT_NO_KEY, provider: "openrouter", model: "typesafe/jev-1.13" })).toEqual({
      provider: "openrouter",
      model: "typesafe/jev-1.13",
    });
  });

  it("does not treat OpenRouter's routers or aliases as a pinned model", () => {
    expect(isPinnedOpenrouterSlug("typesafe/jev-1.13")).toBe(true);
    expect(isPinnedOpenrouterSlug("openrouter/auto")).toBe(false);
    expect(isPinnedOpenrouterSlug("~typesafe/jev-latest")).toBe(false);
    expect(selectionFor("openrouter", { ...DEFAULT_NO_KEY, provider: "openrouter", model: "unconfigured" })).toBeUndefined();
  });

  it("shows a write's outcome beside the control that made it, and a refused read with a retry", () => {
    const html = draw({
      outcomes: {
        selection: { status: "failed", message: "Couldn't save; the previous configuration still applies. model: is an OpenRouter router" },
        "key:cloudflare": { status: "done", message: "Cloudflare Clef key saved. Applies from the next decision." },
      },
    });
    expect(html).toContain('data-decision-outcome="selection"');
    expect(card(html, "cloudflare")).toContain("Cloudflare Clef key saved.");
    const refused = draw({ listing: { status: "failed", reason: "the node is unreachable" } });
    expect(refused).toContain('data-decision-state="failed"');
    expect(refused).toContain(MESSAGES_EN["settings.decision.retry"]);
  });

  it("reads in Vietnamese with full diacritics", () => {
    const html = draw({}, vietnamese);
    expect(html).toContain("Nhà cung cấp quyết định");
    expect(html).toContain("Áp dụng từ quyết định tiếp theo");
    expect(html).toContain("Theo môi trường");
    expect(Object.keys(MESSAGES_VI).filter((key) => key.startsWith("settings.decision.")).length).toBeGreaterThan(40);
  });
});
