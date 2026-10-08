import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type CommandCard, type ProviderAuthEntryView, type ProviderSignInView, instantSchema } from "@clarkcant/contracts";

import { CommandCardBlock } from "../src/command-card.tsx";
import { fillMessage } from "../src/i18n/fill-message.ts";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import {
  AfterSignInPanelView,
  MODEL_PICKER_LIMIT,
  type ModelChoices,
  ModelPickerView,
  type ModelPickerViewProps,
  afterSignInReadiness,
  filterModels,
  orderedProviders,
  providerStatus,
} from "../src/model-picker.tsx";

/**
 * The model picker (`/model`) and the step a `/login` card offers once a provider signs in: drawn from what they are
 * given, in both languages. Opening either changes nothing; only a confirmed choice reaches the node.
 */

const en = (key: MessageKey): string => MESSAGES_EN[key];
const vi = (key: MessageKey): string => MESSAGES_VI[key];
/** As the markup escapes it. */
const esc = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

const auth = (providerId: string, configured: boolean): ProviderAuthEntryView => ({ providerId, name: providerId, apiKey: true, configured });

const CHOICES: ModelChoices = {
  current: { provider: "fake", id: "fake-model" },
  catalogue: [
    { id: "other", models: [{ provider: "other", id: "other-model", current: false }] },
    {
      id: "fake",
      models: [
        { provider: "fake", id: "fake-model", current: true, contextWindow: 128_000 },
        { provider: "fake", id: "fake-model-large", current: false },
      ],
    },
  ],
  auth: [auth("fake", true), auth("other", false)],
};

const props = (change: Partial<ModelPickerViewProps> = {}): ModelPickerViewProps => ({
  t: en,
  idPrefix: "p",
  data: { status: "ready", choices: CHOICES },
  query: "",
  provider: "",
  selected: undefined,
  confirming: false,
  outcome: undefined,
  onQuery: () => undefined,
  onProvider: () => undefined,
  onSelect: () => undefined,
  onChoose: () => undefined,
  onConfirm: () => undefined,
  onCancel: () => undefined,
  onRetry: () => undefined,
  ...change,
});

const draw = (change: Partial<ModelPickerViewProps> = {}): string => renderToStaticMarkup(createElement(ModelPickerView, props(change)));

describe("what the picker offers", () => {
  it("reads each provider's sign-in, and does not guess one it was not told", () => {
    expect(providerStatus(CHOICES.auth, "fake")).toBe("signed-in");
    expect(providerStatus(CHOICES.auth, "other")).toBe("signed-out");
    expect(providerStatus(CHOICES.auth, "local")).toBe("unknown");
    expect(providerStatus(undefined, "fake")).toBe("unknown");
  });

  it("lists signed-in providers first, and matches every word of the search", () => {
    expect(orderedProviders(CHOICES)).toEqual(["fake", "other"]);
    expect(filterModels(CHOICES, { query: "", provider: "" }).map((model) => model.id)).toEqual(["fake-model", "fake-model-large", "other-model"]);
    expect(filterModels(CHOICES, { query: "FAKE large", provider: "" }).map((model) => model.id)).toEqual(["fake-model-large"]);
    expect(filterModels(CHOICES, { query: "", provider: "other" }).map((model) => model.id)).toEqual(["other-model"]);
    expect(filterModels(CHOICES, { query: "nothing", provider: "" })).toEqual([]);
  });

  it("never takes a sign-in to mean its provider has models", () => {
    expect(afterSignInReadiness(CHOICES, "fake")).toEqual({ status: "ready", count: 2 });
    expect(afterSignInReadiness(CHOICES, "other")).toEqual({ status: "not-yet" });
    expect(afterSignInReadiness({ ...CHOICES, auth: [...(CHOICES.auth ?? []), auth("empty", true)], catalogue: [...CHOICES.catalogue, { id: "empty", models: [] }] }, "empty")).toEqual({
      status: "no-models",
    });
    // A provider the catalogue does not know at all: nothing to choose, said rather than assumed.
    expect(afterSignInReadiness({ ...CHOICES, auth: [auth("unsupported", true)] }, "unsupported")).toEqual({ status: "no-models" });
  });
});

describe("the model picker", () => {
  it("marks the model in use, each provider's sign-in, and offers nothing to apply until one is chosen", () => {
    const html = draw();
    expect(html).toContain(esc(fillMessage(en("modelPicker.current"), { model: "fake/fake-model" })));
    expect(html).toContain('data-model="fake/fake-model" data-current="true"');
    expect(html).toContain(en("modelPicker.status.signedIn"));
    expect(html).toContain(en("modelPicker.status.signedOut"));
    expect(html).toContain(esc(fillMessage(en("modelPicker.context"), { tokens: 128 })));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use this model<\/button>/u);
    expect(html).not.toContain(en("modelPicker.confirm"));
  });

  it("asks before switching, and switches nothing on the choose press alone", () => {
    const chosen = draw({ selected: { provider: "fake", id: "fake-model-large" } });
    expect(chosen).toMatch(/<button[^>]*>Use this model<\/button>/u);
    expect(chosen).not.toMatch(/<button[^>]*disabled=""[^>]*>Use this model<\/button>/u);
    const confirming = draw({ selected: { provider: "fake", id: "fake-model-large" }, confirming: true });
    expect(confirming).toContain(esc(fillMessage(en("modelPicker.confirmQuestion"), { model: "fake/fake-model-large" })));
    expect(confirming).toContain(en("modelPicker.confirm"));
    expect(confirming).toContain(en("modelPicker.cancel"));
  });

  it("will not apply a signed-out provider's model, the model in use, or one the node no longer offers", () => {
    const signedOut = draw({ selected: { provider: "other", id: "other-model" }, confirming: true });
    expect(signedOut).toContain(esc(fillMessage(en("modelPicker.signInFirst"), { provider: "other" })));
    expect(signedOut).not.toContain(en("modelPicker.confirm"));
    expect(signedOut).toMatch(/<button[^>]*disabled=""[^>]*>Use this model<\/button>/u);

    const inUse = draw({ selected: { provider: "fake", id: "fake-model" } });
    expect(inUse).toContain(esc(fillMessage(en("modelPicker.alreadyCurrent"), { model: "fake/fake-model" })));

    const gone = draw({ selected: { provider: "fake", id: "retired" }, confirming: true });
    expect(gone).toContain(esc(fillMessage(en("modelPicker.stale"), { model: "fake/retired" })));
    expect(gone).not.toContain(en("modelPicker.confirm"));
  });

  it("says where a choice landed, or why it did not, with the model unchanged", () => {
    expect(draw({ outcome: { status: "pending", model: "fake/fake-model-large" } })).toContain(en("modelPicker.applying"));
    expect(draw({ outcome: { status: "done", model: "fake/fake-model-large", applies: "next-session" } })).toContain(
      esc(fillMessage(en("modelPicker.appliedNextTurn"), { model: "fake/fake-model-large" })),
    );
    expect(draw({ outcome: { status: "done", model: "fake/fake-model-large", applies: "next-start" } })).toContain(
      esc(fillMessage(en("modelPicker.appliedNextStart"), { model: "fake/fake-model-large" })),
    );
    const failed = draw({ outcome: { status: "failed", model: "fake/x", message: "provider \"fake\" does not offer a model \"x\"" } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(esc(fillMessage(en("modelPicker.applyFailed"), { model: "fake/x", reason: "provider \"fake\" does not offer a model \"x\"" })));
  });

  it("disables every choice while one is on its way", () => {
    const html = draw({ selected: { provider: "fake", id: "fake-model-large" }, outcome: { status: "pending", model: "fake/fake-model-large" } });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use this model<\/button>/u);
    expect(html.match(/type="radio"[^>]*disabled=""/gu)?.length).toBe(3);
  });

  it("draws loading, a failed read with a retry, an empty catalogue, no matches, and an unknown sign-in", () => {
    expect(draw({ data: { status: "loading" } })).toContain(en("modelPicker.loading"));
    const failed = draw({ data: { status: "failed", message: "offline" } });
    expect(failed).toContain(esc(fillMessage(en("modelPicker.readFailed"), { reason: "offline" })));
    expect(failed).toContain(en("modelPicker.retry"));
    const empty = draw({ data: { status: "ready", choices: { current: null, catalogue: [], auth: [] } } });
    expect(empty).toContain(en("modelPicker.empty"));
    expect(empty).toContain(en("modelPicker.currentNone"));
    expect(empty).not.toContain("Use this model");
    expect(draw({ query: "zzz" })).toContain(esc(fillMessage(en("modelPicker.noMatches"), { query: "zzz" })));
    const unknown = draw({ data: { status: "ready", choices: { ...CHOICES, auth: undefined } } });
    expect(unknown).toContain(esc(en("modelPicker.authUnknown")));
    expect(unknown).toContain(en("modelPicker.status.unknown"));
  });

  it("draws at most a page of rows from a long catalogue, and says how many it holds", () => {
    const many: ModelChoices = {
      current: null,
      catalogue: [{ id: "big", models: Array.from({ length: MODEL_PICKER_LIMIT + 5 }, (_, index) => ({ provider: "big", id: `m${index}`, current: false })) }],
      auth: [],
    };
    const html = draw({ data: { status: "ready", choices: many } });
    expect(html.match(/type="radio"/gu)?.length).toBe(MODEL_PICKER_LIMIT);
    expect(html).toContain(esc(fillMessage(en("modelPicker.more"), { shown: MODEL_PICKER_LIMIT, total: MODEL_PICKER_LIMIT + 5 })));
  });

  it("speaks Vietnamese", () => {
    const html = draw({ t: vi, selected: { provider: "fake", id: "fake-model-large" }, confirming: true });
    expect(html).toContain(esc(fillMessage(vi("modelPicker.current"), { model: "fake/fake-model" })));
    expect(html).toContain(vi("modelPicker.confirm"));
    expect(html).toContain(vi("modelPicker.status.signedIn"));
  });

  it("has a translation for every message in both languages", () => {
    const keys = Object.keys(MESSAGES_EN).filter((key) => key.startsWith("modelPicker."));
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) expect(MESSAGES_VI[key as MessageKey]).not.toBe("");
  });
});

const PICKER_CARD: CommandCard = {
  type: "command-card",
  owner: "host",
  cardId: "card_model",
  command: "model",
  title: "Choose a model",
  updatedAt: instantSchema.parse("2026-10-08T00:00:00.000Z"),
  rows: [],
  picker: { kind: "model" },
};

describe("the /model card", () => {
  it("draws the live picker only where the page can read the catalogue and apply a choice", () => {
    const live = renderToStaticMarkup(
      createElement(CommandCardBlock, { block: PICKER_CARD, t: en, actions: { onCommandAction: () => undefined, readModelChoices: () => new Promise<ModelChoices>(() => undefined) } }),
    );
    expect(live).toContain("cc-model-picker");
    expect(live).not.toContain(en("commandCard.empty"));
    // A record of the card — a transcript, a search result — draws no picker, because it could not act.
    const record = renderToStaticMarkup(createElement(CommandCardBlock, { block: PICKER_CARD, t: en }));
    expect(record).not.toContain("cc-model-picker");
  });
});

const LOGIN_CARD: CommandCard = {
  type: "command-card",
  owner: "host",
  cardId: "card_login",
  command: "login",
  title: "Sign in",
  updatedAt: instantSchema.parse("2026-10-08T00:00:00.000Z"),
  rows: [{ rowId: "fake-other", label: "Fake Other", actions: [{ actionId: "api_key", label: "Use API key", action: { kind: "provider-sign-in", providerId: "fake-other", method: "api_key" } }] }],
};

const signIn = (state: ProviderSignInView["state"], error?: string): ProviderSignInView =>
  ({ signInId: "signin_1", providerId: "fake-other", method: "api_key", state, events: [], ...(error === undefined ? {} : { error }) }) as ProviderSignInView;

describe("a /login card after the sign-in", () => {
  const loginActions = (view: ProviderSignInView) => ({
    onCommandAction: () => undefined,
    signIns: { "card_login/fake-other": view },
    readModelChoices: () => new Promise<ModelChoices>(() => undefined),
  });

  it("names the provider it signed in to, and checks what it offers before offering anything", () => {
    const html = renderToStaticMarkup(createElement(CommandCardBlock, { block: LOGIN_CARD, t: en, actions: loginActions(signIn("done")) }));
    expect(html).toContain(esc(fillMessage(en("commandCard.signIn.done"), { provider: "Fake Other" })));
    expect(html).toContain(esc(fillMessage(en("modelPicker.after.checking"), { provider: "Fake Other" })));
    expect(html).not.toContain(esc(fillMessage(en("modelPicker.after.choose"), { provider: "Fake Other" })));
    const vietnamese = renderToStaticMarkup(createElement(CommandCardBlock, { block: LOGIN_CARD, t: vi, actions: loginActions(signIn("done")) }));
    expect(vietnamese).toContain(esc(fillMessage(vi("commandCard.signIn.done"), { provider: "Fake Other" })));
  });

  it("offers nothing to choose after a sign-in that failed", () => {
    const html = renderToStaticMarkup(createElement(CommandCardBlock, { block: LOGIN_CARD, t: en, actions: loginActions(signIn("failed", "bad key")) }));
    expect(html).toContain(esc(en("commandCard.signIn.failed")));
    expect(html).not.toContain("cc-after-sign-in");
  });

  const after = (change: Partial<Parameters<typeof AfterSignInPanelView>[0]>) =>
    renderToStaticMarkup(
      createElement(AfterSignInPanelView, {
        t: en,
        providerName: "Fake Other",
        view: { status: "ready", count: 2, current: { provider: "fake", id: "fake-model" } },
        choice: undefined,
        onChoose: () => undefined,
        onKeep: () => undefined,
        onRefresh: () => undefined,
        ...change,
      }),
    );

  it("offers choosing one of the provider's models or keeping the model in use", () => {
    const html = after({});
    expect(html).toContain(esc(fillMessage(en("modelPicker.after.ready"), { provider: "Fake Other", count: 2 })));
    expect(html).toContain(esc(fillMessage(en("modelPicker.after.choose"), { provider: "Fake Other" })));
    expect(html).toContain(en("modelPicker.after.keep"));
    const kept = after({ choice: "kept" });
    expect(kept).toContain(esc(fillMessage(en("modelPicker.after.kept"), { model: "fake/fake-model" })));
    expect(kept).not.toContain(en("modelPicker.after.keep"));
    expect(after({ choice: "kept", view: { status: "ready", count: 2, current: undefined } })).toContain(esc(en("modelPicker.after.keptNone")));
  });

  it("says when the provider is not listed as signed in yet, has no models, or could not be read, with a way to check again", () => {
    for (const [view, key] of [
      [{ status: "not-yet" }, "modelPicker.after.notYet"],
      [{ status: "no-models" }, "modelPicker.after.noModels"],
      [{ status: "failed", message: "offline" }, "modelPicker.after.failed"],
    ] as const) {
      const html = after({ view });
      expect(html).toContain(esc(fillMessage(en(key), { provider: "Fake Other", reason: "offline" })));
      expect(html).toContain(en("modelPicker.after.refresh"));
      expect(html).not.toContain(en("modelPicker.after.keep"));
    }
    expect(after({ t: vi, view: { status: "no-models" } })).toContain(esc(fillMessage(vi("modelPicker.after.noModels"), { provider: "Fake Other" })));
  });
});
