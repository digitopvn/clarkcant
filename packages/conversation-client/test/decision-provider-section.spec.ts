import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DECISION_REASON_CODES, type DecisionProviderView } from "@clarkcant/contracts";

import { GatewayClient, GatewayError } from "../src/api.ts";

import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import {
  DecisionProviderCard,
  type DecisionProviderCardProps,
  decisionHint,
  decisionReasonText,
  decisionWriteFailure,
  isPinnedOpenrouterSlug,
  keyLivesInCredentials,
  keySourceBadge,
  lastCallLine,
  selectionFor,
} from "../src/settings/controls/decision-provider-section.tsx";
import {
  CREDENTIALS_SECTION_SELECTOR,
  credentialFieldSelector,
  credentialRowSelector,
  focusCredential,
} from "../src/settings/controls/vault-list-focus.ts";

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
  reasonCode: "no-credential",
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
      lastCall: {
        event: "error",
        status: "unavailable",
        model: "clef-flash",
        durationMs: 4000,
        reason: "the call exceeded its 1500 ms deadline",
        reasonCode: "deadline",
      },
    };
    expect(lastCallLine(failed, english)).toBe("Last call got no answer (clef-flash): the call took longer than this decision's deadline.");
    // The node's English sentence never reaches the line, in either language.
    expect(lastCallLine(failed, vietnamese)).toBe("Lần gọi gần nhất không có câu trả lời (clef-flash): lần gọi kéo dài quá thời hạn của quyết định này.");
    expect(lastCallLine(failed, vietnamese)).not.toContain("deadline");
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
    expect(html.match(/type="password"/g)).toHaveLength(2);
    for (const field of html.match(/<input[^>]*type="password"[^>]*>/g) ?? []) expect(field).toContain('value=""');
  });

  it("gives the TypeSafe key one control: its card points to the Credentials list instead of holding a second field", () => {
    // TypeSafe's key is the plain `typesafe` credential the Credentials list edits; the other two are host-owned names
    // only their own cards can write, so they keep their fields.
    expect(keyLivesInCredentials("typesafe")).toBe(true);
    expect(keyLivesInCredentials("cloudflare")).toBe(false);
    expect(keyLivesInCredentials("openrouter")).toBe(false);

    for (const [t, messages] of [
      [english, MESSAGES_EN],
      [vietnamese, MESSAGES_VI],
    ] as const) {
      const html = draw({}, t);
      const typesafe = card(html, "typesafe");
      expect(typesafe).not.toContain("data-decision-key-input");
      expect(typesafe).not.toContain("data-decision-key-save");
      expect(typesafe).not.toContain('type="password"');
      expect(typesafe).toContain('data-decision-key-in-credentials="typesafe"');
      expect(typesafe).toContain('data-decision-key-go-to-credentials="typesafe"');
      expect(typesafe).toContain(messages["settings.decision.key.goToCredentials"]);
      expect(typesafe).toContain(messages["settings.decision.key.inCredentials"].replace("{provider}", "TypeSafe Jev"));
      for (const provider of ["cloudflare", "openrouter"]) {
        expect(card(html, provider)).toContain(`data-decision-key-input="${provider}"`);
        expect(card(html, provider)).not.toContain("data-decision-key-go-to-credentials");
      }
    }
    // With no TypeSafe key, the hint sends the person to Credentials rather than to a card with no field.
    expect(decisionHint(DEFAULT_NO_KEY, english)).toBe(
      "There is no key for TypeSafe Jev. Save one in Credentials below; until then Clark uses its built-in rules.",
    );
    expect(decisionHint(DEFAULT_NO_KEY, vietnamese)).toContain("danh sách Thông tin xác thực");
    expect(decisionHint({ ...DEFAULT_NO_KEY, provider: "openrouter" }, english)).toContain("Save one in its card below");
    // A TypeSafe key from the environment is replaced in Credentials, not "here".
    const fromEnvironment = draw({
      listing: {
        status: "ready",
        view: { ...READY, providers: [{ id: "typesafe", models: null, credential: { name: "typesafe", source: "environment" } }, ...PROVIDERS.slice(1)] },
      },
    });
    expect(card(fromEnvironment, "typesafe")).toContain("Save one in Credentials to replace it.");
    expect(card(fromEnvironment, "openrouter")).toContain("Save one here to replace it.");
  });

  it("draws every state with its reason and what to do about it", () => {
    const states: DecisionProviderView[] = [
      DEFAULT_NO_KEY,
      { ...READY, status: "local-only", localOnly: true, reason: "this node is configured local-only, so no intent is sent to a provider", reasonCode: "local-only" },
      { ...READY, status: "disabled", reason: "the selector is disabled on this node", reasonCode: "disabled" },
      {
        ...READY,
        selection: { provider: "cloudflare", model: "clef" },
        account: { source: "none" },
        status: "misconfigured",
        reason: "the Cloudflare decision provider needs CLOUDFLARE_ACCOUNT_ID",
        reasonCode: "cloudflare-account-missing",
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
      "This configuration can't be used: Cloudflare needs an account id (CLOUDFLARE_ACCOUNT_ID). Enter the Cloudflare account id below (or set CLOUDFLARE_ACCOUNT_ID on the node); until then Clark uses its built-in rules.",
    );
    expect(decisionHint(states[3]!, vietnamese)).toBe(
      "Cấu hình này chưa dùng được: Cloudflare cần một account id (CLOUDFLARE_ACCOUNT_ID). Nhập account id Cloudflare bên dưới (hoặc đặt CLOUDFLARE_ACCOUNT_ID trên node); trong lúc đó Clark dùng quy tắc có sẵn.",
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

  it("words every reason the node can give in both languages, and never inserts the node's English", () => {
    for (const code of DECISION_REASON_CODES) {
      expect(MESSAGES_EN[`settings.decision.reason.${code}`]).toBeTruthy();
      expect(MESSAGES_VI[`settings.decision.reason.${code}`]).toBeTruthy();
      expect(MESSAGES_VI[`settings.decision.reason.${code}`]).not.toBe(MESSAGES_EN[`settings.decision.reason.${code}`]);
    }
    const misconfigured: DecisionProviderView = {
      ...READY,
      provider: "openrouter",
      selection: { provider: "openrouter", model: "openrouter/auto" },
      model: "openrouter/auto",
      status: "misconfigured",
      reason: "the OpenRouter decision model is an OpenRouter router",
      reasonCode: "openrouter-model-router",
    };
    const hint = decisionHint(misconfigured, vietnamese);
    expect(hint).not.toContain(misconfigured.reason);
    expect(hint).toContain("router của OpenRouter");
    // A node too old to send a code gets the generic wording, still in the person's language.
    const { reasonCode: _dropped, ...withoutCode } = misconfigured;
    expect(decisionHint(withoutCode, vietnamese)).not.toContain(misconfigured.reason);
    expect(decisionReasonText(undefined, vietnamese)).toBe(MESSAGES_VI["settings.decision.reason.unknown"]);
  });

  it("words a reason code from a newer node that this client does not know with the generic reason, never a raw key", () => {
    // A newer node can send a code this client was built without; the wire value is not narrowed to the known codes.
    const newer = "provider-quota-paused";
    expect((DECISION_REASON_CODES as readonly string[]).includes(newer)).toBe(false);
    expect(decisionReasonText(newer, english)).toBe(MESSAGES_EN["settings.decision.reason.unknown"]);
    expect(decisionReasonText(newer, vietnamese)).toBe(MESSAGES_VI["settings.decision.reason.unknown"]);
    const view = {
      ...READY,
      status: "misconfigured",
      reason: "a reason only a newer node words",
      reasonCode: newer,
      lastCall: { event: "error", status: "unavailable", model: "clef-flash", durationMs: 12, reason: "a newer failure", reasonCode: newer },
    } as unknown as DecisionProviderView;
    for (const t of [english, vietnamese]) {
      const hint = decisionHint(view, t);
      const line = lastCallLine(view, t);
      expect(hint).toContain(t("settings.decision.reason.unknown"));
      expect(line).toContain(t("settings.decision.reason.unknown"));
      for (const text of [hint, line]) {
        expect(text).not.toContain("settings.decision.reason.");
        expect(text).not.toContain("undefined");
        expect(text).not.toContain(newer);
      }
    }
  });

  it("words a refused write in the person's language, not the node's English", () => {
    const refusedSlug = new GatewayError(400, "INVALID_SCHEMA", "model: is an OpenRouter router, not a pinned model");
    const selection = decisionWriteFailure("selection", refusedSlug, vietnamese);
    expect(selection).toBe(
      "Không lưu được; cấu hình trước đó vẫn giữ nguyên. Node không nhận lựa chọn này; hãy kiểm tra model hoặc account id.",
    );
    expect(selection).not.toContain("OpenRouter router");
    expect(decisionWriteFailure("key:typesafe", new GatewayError(400, "INVALID_SCHEMA", "value: too long"), english)).toContain(
      "a key is 1 to 4096 characters",
    );
    expect(decisionWriteFailure("selection", new Error("fetch failed"), vietnamese)).not.toContain("fetch failed");
  });

  it("reads in Vietnamese with full diacritics", () => {
    const html = draw({}, vietnamese);
    expect(html).toContain("Nhà cung cấp quyết định");
    expect(html).toContain("Áp dụng từ quyết định tiếp theo");
    expect(html).toContain("Theo môi trường");
    expect(Object.keys(MESSAGES_VI).filter((key) => key.startsWith("settings.decision.")).length).toBeGreaterThan(40);
  });
});

/** Just enough of an element for `focusCredential`: the selectors it asks for, answered from a table. */
class FakeElement {
  tabIndex = 0;
  focused = false;
  readonly #attributes: Set<string>;
  readonly #children: Record<string, FakeElement>;
  constructor(children: Record<string, FakeElement> = {}, attributes: string[] = []) {
    this.#children = children;
    this.#attributes = new Set(attributes);
  }
  querySelector(selector: string): FakeElement | null {
    return this.#children[selector] ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.#attributes.has(name);
  }
  scrollIntoView(): void {}
  focus(): void {
    this.focused = true;
  }
}

function focusIn(root: FakeElement): ReturnType<typeof focusCredential> {
  return focusCredential("typesafe", root as unknown as ParentNode);
}

describe("pointing at a credential in the Credentials list", () => {
  const FIELD = `${credentialFieldSelector("typesafe")}:not([disabled])`;

  it("focuses the key field, never a button in the row", () => {
    const field = new FakeElement();
    const row = new FakeElement({ [FIELD]: field });
    const heading = new FakeElement();
    const section = new FakeElement({ [credentialRowSelector("typesafe")]: row, "h2, h3, h4": heading });
    expect(focusIn(new FakeElement({ [CREDENTIALS_SECTION_SELECTOR]: section }))).toBe("field");
    expect(field.focused).toBe(true);
    expect(row.focused).toBe(false);
  });

  it("focuses the row itself, out of the Tab order, when it has no field to type in", () => {
    const row = new FakeElement();
    const section = new FakeElement({ [credentialRowSelector("typesafe")]: row, "h2, h3, h4": new FakeElement() });
    expect(focusIn(new FakeElement({ [CREDENTIALS_SECTION_SELECTOR]: section }))).toBe("row");
    expect(row.focused).toBe(true);
    expect(row.tabIndex).toBe(-1);
  });

  it("falls back to the Credentials heading when the row is missing, so the press is never silent", () => {
    const heading = new FakeElement();
    const section = new FakeElement({ "h2, h3, h4": heading });
    expect(focusIn(new FakeElement({ [CREDENTIALS_SECTION_SELECTOR]: section }))).toBe("heading");
    expect(heading.focused).toBe(true);
    expect(heading.tabIndex).toBe(-1);
    // With no list at all, the caller is told so and says it on the card.
    expect(focusIn(new FakeElement())).toBe("none");
    expect(MESSAGES_EN["settings.decision.key.credentialsMissing"]).toContain("AI & Routing");
    expect(MESSAGES_VI["settings.decision.key.credentialsMissing"]).toContain("AI & Định tuyến");
  });

  it("names the selectors the Credentials list renders", () => {
    expect(CREDENTIALS_SECTION_SELECTOR).toBe("[data-credentials-section='true']");
    expect(credentialRowSelector("typesafe")).toBe('[data-credential-row="typesafe"]');
    expect(credentialFieldSelector("typesafe")).toBe('[data-credential-field="typesafe"]');
  });
});

describe("the TypeSafe key's badge", () => {
  it("says a saved TypeSafe key is in Credentials, not on the card, and keeps 'saved here' for the cards that save", () => {
    expect(keySourceBadge("typesafe", "vault")).toBe("settings.decision.key.source.vault.credentials");
    expect(keySourceBadge("cloudflare", "vault")).toBe("settings.decision.key.source.vault");
    expect(keySourceBadge("typesafe", "none")).toBe("settings.decision.key.source.none");
    const saved: DecisionProviderView = {
      ...READY,
      providers: PROVIDERS.map((entry) => (entry.id === "typesafe" ? { ...entry, credential: { ...entry.credential, source: "vault" } } : entry)),
    };
    for (const [t, messages] of [
      [english, MESSAGES_EN],
      [vietnamese, MESSAGES_VI],
    ] as const) {
      const html = draw({ listing: { status: "ready", view: saved } }, t);
      expect(card(html, "typesafe")).toContain(messages["settings.decision.key.source.vault.credentials"]);
      expect(card(html, "typesafe")).not.toContain(`>${messages["settings.decision.key.source.vault"]}<`);
      expect(card(html, "cloudflare")).toContain(messages["settings.decision.key.source.vault"]);
    }
    expect(MESSAGES_EN["settings.decision.key.source.vault.credentials"]).toBe("Saved in Credentials");
    expect(MESSAGES_VI["settings.decision.key.source.vault.credentials"]).toBe("Đã lưu trong Thông tin xác thực");
  });
});

describe("the client's credential change notice", () => {
  const client = (status: number): GatewayClient =>
    new GatewayClient({
      baseUrl: "http://node.test",
      token: "t",
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(status === 200 ? { ok: true, names: ["typesafe"] } : { code: "X" }), { status })),
    });

  it("tells listeners after a credential is saved or removed, and not after a refusal or once they stop listening", async () => {
    const ok = client(200);
    let heard = 0;
    const stop = ok.onCredentialsChange(() => {
      heard += 1;
    });
    await ok.putCredential({ fields: [{ name: "typesafe", value: "v" }] });
    expect(heard).toBe(1);
    await ok.deleteCredential("typesafe");
    expect(heard).toBe(2);
    stop();
    await ok.deleteCredential("typesafe");
    expect(heard).toBe(2);

    const refused = client(400);
    let refusedHeard = 0;
    refused.onCredentialsChange(() => {
      refusedHeard += 1;
    });
    await expect(refused.putCredential({ fields: [{ name: "typesafe", value: "v" }] })).rejects.toBeInstanceOf(GatewayError);
    await expect(refused.deleteCredential("typesafe")).rejects.toBeInstanceOf(GatewayError);
    expect(refusedHeard).toBe(0);
  });
});
