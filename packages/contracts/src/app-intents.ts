/**
 * Application control intents.
 *
 * One shape for the things a person can ask the application to do to itself, shared by the three
 * ways they can ask: typing it in the composer, clicking a control, and saying it out loud. The
 * point of a single shape is that there is then a single executor, so "open Settings by voice" and
 * "open Settings by clicking" cannot drift apart into two behaviours that happen to look alike.
 *
 * ## Why the confirmation token is in the contract
 *
 * Quitting the application is the one intent that can lose someone's work, so it is never
 * executable on the strength of a single request. The decision that comes back for it carries a
 * token instead of an executable intent, and only the confirm route turns that token into
 * permission. Putting the token in the shared schema is what stops a source from being able to skip
 * the gate: a caller that wants to act on a quit has to hold a token that some node minted, and the
 * token is single-use.
 *
 * ## What an intent is not
 *
 * An intent does not carry free text to run, a path, or a command. Every kind below is a fixed
 * capability of the shell itself, and the parameter space is one enumerated tab. That is deliberate:
 * this is the vocabulary of a control channel, not a scripting surface, and nothing here can be
 * widened from the outside by putting more words into a sentence.
 */

import { z } from "zod";

import { capabilityRefSchema } from "./grants.ts";

/**
 * The kinds.
 *
 * Issue #17 says "all 8 command groups" and then lists nine things to do. Nine kinds implement the
 * list; the count in the prose is the thing that is wrong, and it is named here rather than quietly
 * matched to whichever number was easier. The two widget kinds bring it to eleven.
 *
 * A widget target is not a scripting surface. `definitionId` reuses the capability-ref grammar
 * (`namespace.name@major`) and `family` is a bare catalog family word, so the parameter space stays
 * a pair of enumerated-looking identifiers rather than free text: opening the library is a view
 * action, and nothing in it can be widened by saying more words.
 */
export const APP_INTENT_KINDS = [
  "voice.end",
  "voice.open",
  "window.expand",
  "window.minimise",
  "window.minimal",
  "window.fullscreen",
  "window.windowed",
  "settings.open",
  "settings.tab",
  "nav.home",
  "nav.conversation",
  "composer.attach",
  "app.quit",
  "widgets.open",
  "widgets.show",
  "model.cycle",
  "model.select",
  "inbox.open",
] as const;

export const appIntentKindSchema = z.enum(APP_INTENT_KINDS);
export type AppIntentKind = z.infer<typeof appIntentKindSchema>;

/**
 * The tabs Settings can be opened at.
 *
 * `memory` is deliberately **not** here yet. The plan's contract listed it in anticipation of the Memory tab, but
 * listing a tab that does not exist would let "open the Memory tab" be understood, read back and then show nothing
 * - which is worse than being told the command cannot be done. Stage C adds the tab and this list together, so the
 * two cannot disagree.
 */
export const SETTINGS_TABS = ["experience", "ai", "control", "extensions", "devices", "memory", "developer"] as const;
export const settingsTabSchema = z.enum(SETTINGS_TABS);
export type SettingsTab = z.infer<typeof settingsTabSchema>;

/**
 * Where a request came from.
 *
 * Recorded on every audit event. It is the field that answers "did a person click this or did the
 * microphone hear something that sounded like it", which is the first question anyone asks after an
 * application does something surprising.
 */
/**
 * `"agent"` marks a request the main or voice model made through a tool call rather than one a
 * person typed, clicked or said. Kept in the same enum as the others rather than a separate
 * `origin` field, because every caller of this schema already switches on `source` and a second
 * field would let the two disagree - an "agent" request whose `source` still said "chat" would be
 * audited as if a person had asked for it.
 */
export const appIntentSourceSchema = z.enum(["chat", "click", "voice", "agent"]);
export type AppIntentSource = z.infer<typeof appIntentSourceSchema>;

/** A configured model-pool profile alias, as `@clarkcant/core`'s model pool names it. */
export const modelAliasSchema = z.string().min(1).max(80);
export type ModelAlias = z.infer<typeof modelAliasSchema>;

/** A catalog family word, as `widget-catalog` names it. */
export const widgetFamilySchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, { error: "must be a catalog family name" });
export type WidgetFamily = z.infer<typeof widgetFamilySchema>;

/**
 * The two widget kinds.
 *
 * `widgets.open` opens the library on the catalogue; `widgets.show` opens it on a particular widget
 * or family. Neither carries anything executable, which is why neither needs confirmation: the worst
 * an unwanted one can do is show a catalogue the person can close.
 */
export const appIntentSchema = z
  .strictObject({
    kind: appIntentKindSchema,
    tab: settingsTabSchema.optional(),
    definitionId: capabilityRefSchema.optional(),
    family: widgetFamilySchema.optional(),
    /** Carried only by `model.select`, naming a profile from the configured pool - never a bare provider/model string. */
    modelAlias: modelAliasSchema.optional(),
  })
  .refine((intent) => intent.kind !== "settings.tab" || intent.tab !== undefined, {
    message: "settings.tab must name the tab to change to",
    path: ["tab"],
  })
  .refine(
    (intent) =>
      intent.kind === "widgets.show" || (intent.definitionId === undefined && intent.family === undefined),
    {
      message: "only widgets.show may name a widget or a family",
      path: ["definitionId"],
    },
  )
  .refine((intent) => intent.kind !== "model.select" || intent.modelAlias !== undefined, {
    message: "model.select must name the configured profile to switch to",
    path: ["modelAlias"],
  })
  .refine((intent) => intent.kind === "model.select" || intent.modelAlias === undefined, {
    message: "only model.select may name a model alias",
    path: ["modelAlias"],
  });
export type AppIntent = z.infer<typeof appIntentSchema>;

/** The one intent that is never executable from a single request. */
export const CONFIRMATION_REQUIRED_KINDS: readonly AppIntentKind[] = ["app.quit"];

export function intentRequiresConfirmation(kind: AppIntentKind): boolean {
  return CONFIRMATION_REQUIRED_KINDS.includes(kind);
}

/** A single-use token, minted by the node, that turns a confirmed request into permission. */
export const confirmationTokenSchema = z.uuid();
export type ConfirmationToken = z.infer<typeof confirmationTokenSchema>;

export const confirmationDecisionSchema = z.enum(["granted", "denied"]);
export type ConfirmationDecision = z.infer<typeof confirmationDecisionSchema>;

/**
 * The UI language an app-intent read-back or refusal is said in.
 *
 * A bare `"vi" | "en"` rather than an import of `LocaleChoice` from `@clarkcant/conversation-client`:
 * `contracts` sits below the UI package in the dependency graph, and this schema has no business
 * depending on a React package's i18n catalog. The two types are kept in sync by the shared literal
 * values, not by an import.
 */
export type AppIntentLocale = "vi" | "en";

/** What the person is told when a command-shaped sentence matched nothing, in Vietnamese - kept for callers that have not adopted `appIntentNotUnderstood`. */
export const APP_INTENT_NOT_UNDERSTOOD =
  "Tôi chưa hiểu câu lệnh đó, nên tôi chưa làm gì cả. Bạn nói lại rõ hơn giúp tôi nhé.";

const APP_INTENT_NOT_UNDERSTOOD_EN =
  "I did not understand that command, so I have not done anything. Please say it again more clearly.";

/** Locale-aware form of `APP_INTENT_NOT_UNDERSTOOD`. Defaults to Vietnamese, the product's own language. */
export function appIntentNotUnderstood(locale: AppIntentLocale = "vi"): string {
  return locale === "en" ? APP_INTENT_NOT_UNDERSTOOD_EN : APP_INTENT_NOT_UNDERSTOOD;
}

/**
 * What each tab is called, matching the panel rather than translating it.
 *
 * A spoken command names a tab the person is looking at, so the words here are the words on screen. Reading back
 * a Vietnamese name for a tab labelled in English would make the read-back a second vocabulary to learn.
 */
const TAB_LABELS: Record<SettingsTab, string> = {
  experience: "Experience",
  ai: "AI & Routing",
  control: "Control",
  extensions: "Extensions",
  devices: "Devices & Voice",
  memory: "Memory",
  developer: "Developer",
};

/**
 * The sentence read back before the application acts, in Vietnamese.
 *
 * Said out loud for a spoken command and shown for a typed one, which is why it is a property of the
 * intent rather than of the voice path. A read-back is the whole confirmation mechanism for the eight
 * intents that do not ask: hearing "I am closing the window" is what lets someone stop it.
 */
function describeAppIntentVi(intent: AppIntent): string {
  switch (intent.kind) {
    case "voice.end":
      return "Tôi kết thúc phiên thoại nhé.";
    case "voice.open":
      return "Tôi mở phiên thoại nhé.";
    case "nav.conversation":
      return "Tôi quay lại cuộc trò chuyện hiện tại nhé.";
    case "model.cycle":
      return "Tôi chuyển sang model tiếp theo trong pool nhé. Thay đổi áp dụng từ lượt tiếp theo.";
    case "model.select":
      return `Tôi chuyển sang model "${intent.modelAlias ?? ""}" nhé. Thay đổi áp dụng từ lượt tiếp theo.`;
    case "window.expand":
      return "Tôi mở rộng cửa sổ nhé.";
    case "window.minimise":
      return "Tôi thu nhỏ cửa sổ xuống thanh tác vụ nhé.";
    case "window.minimal":
      return "Tôi thu cửa sổ về thanh voice nhé.";
    case "window.fullscreen":
      return "Tôi phóng to cửa sổ ra toàn màn hình nhé.";
    case "window.windowed":
      return "Tôi thoát toàn màn hình, trả cửa sổ về kích thước cũ nhé.";
    case "settings.open":
      return "Tôi mở Settings nhé.";
    case "settings.tab":
      return `Tôi mở Settings ở tab ${TAB_LABELS[intent.tab ?? "experience"]} nhé.`;
    case "nav.home":
      return "Tôi về màn hình bắt đầu nhé.";
    case "composer.attach":
      return "Tôi mở hộp thoại chọn tệp nhé.";
    case "app.quit":
      return "Tôi hiểu là bạn muốn thoát ứng dụng. Bạn xác nhận chứ?";
    case "widgets.open":
      return "Tôi mở thư viện widget nhé.";
    case "widgets.show": {
      if (intent.definitionId !== undefined) return `Tôi mở widget ${intent.definitionId} nhé.`;
      if (intent.family !== undefined) return `Tôi mở thư viện widget ở nhóm ${intent.family} nhé.`;
      // Distinct from `widgets.open` on purpose: the existing suite asserts that every kind reads back
      // differently, and a person who asked for a widget and got "I am opening the library" should be
      // able to tell that the widget itself was not named.
      return "Tôi mở thư viện widget để bạn chọn nhé.";
    }
    case "inbox.open":
      return "Tôi mở hộp thư nhé.";
    default: {
      // Every kind above returns, so this is unreachable today. It exists so that adding a tenth kind
      // without a sentence is a loud failure in a test rather than `undefined` read aloud by a voice.
      const unreachable: never = intent.kind;
      throw new Error(`no read-back sentence for app intent ${String(unreachable)}`);
    }
  }
}

/** The English translation of `describeAppIntentVi`, kind for kind, same structure. */
function describeAppIntentEn(intent: AppIntent): string {
  switch (intent.kind) {
    case "voice.end":
      return "Ending the voice session.";
    case "voice.open":
      return "Opening a voice session.";
    case "nav.conversation":
      return "Going back to the current conversation.";
    case "model.cycle":
      return "Switching to the next model in the pool. The change applies from the next turn.";
    case "model.select":
      return `Switching to model "${intent.modelAlias ?? ""}". The change applies from the next turn.`;
    case "window.expand":
      return "Expanding the window.";
    case "window.minimise":
      return "Minimising the window to the taskbar.";
    case "window.minimal":
      return "Shrinking the window to the voice bar.";
    case "window.fullscreen":
      return "Making the window full screen.";
    case "window.windowed":
      return "Leaving full screen and restoring the previous window size.";
    case "settings.open":
      return "Opening Settings.";
    case "settings.tab":
      return `Opening Settings on the ${TAB_LABELS[intent.tab ?? "experience"]} tab.`;
    case "nav.home":
      return "Going back to the start screen.";
    case "composer.attach":
      return "Opening the file picker.";
    case "app.quit":
      return "I understand you want to quit the app. Do you confirm?";
    case "widgets.open":
      return "Opening the widget library.";
    case "widgets.show": {
      if (intent.definitionId !== undefined) return `Opening the ${intent.definitionId} widget.`;
      if (intent.family !== undefined) return `Opening the widget library on the ${intent.family} group.`;
      return "Opening the widget library for you to choose.";
    }
    case "inbox.open":
      return "Opening your inbox.";
    default: {
      const unreachable: never = intent.kind;
      throw new Error(`no read-back sentence for app intent ${String(unreachable)}`);
    }
  }
}

/**
 * The sentence read back before the application acts.
 *
 * Locale-aware, defaulting to Vietnamese: an existing caller that has not been touched to pass a
 * locale keeps behaving exactly as before, while a caller that knows the UI language can now get the
 * matching sentence.
 */
export function describeAppIntent(intent: AppIntent, locale: AppIntentLocale = "vi"): string {
  return locale === "en" ? describeAppIntentEn(intent) : describeAppIntentVi(intent);
}

/**
 * What a node answers a request with.
 *
 * `intent` is the only member that may be acted on, and the client's executor accepts nothing else -
 * so the gate is in the type, not in a comment telling callers to be careful.
 */
export const appIntentDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("intent"),
    intent: appIntentSchema,
    requiresConfirmation: z.literal(false),
    readBack: z.string(),
  }),
  z.strictObject({
    kind: z.literal("needs-confirmation"),
    intent: appIntentSchema,
    readBack: z.string(),
    confirmationToken: confirmationTokenSchema,
  }),
  z.strictObject({
    kind: z.literal("refused"),
    say: z.string(),
  }),
]);
export type AppIntentDecision = z.infer<typeof appIntentDecisionSchema>;

/**
 * The answer to "does this sentence map to an application intent at all".
 *
 * Distinct from `refused`, and the distinction is the point: `none` means "not my business, carry on
 * as before", while `refused` means "this was shaped like a command and I will not guess". A caller
 * that collapsed the two would either block real questions or act on guesses.
 */
export const appIntentNoneSchema = z.strictObject({ kind: z.literal("none") });
export type AppIntentNone = z.infer<typeof appIntentNoneSchema>;

export const appIntentResolutionSchema = z.union([appIntentDecisionSchema, appIntentNoneSchema]);
export type AppIntentResolution = z.infer<typeof appIntentResolutionSchema>;

/** Why a confirmation was not honoured. Kept separate from the decision so a route can pick a status. */export const APP_INTENT_CONFIRMATION_FAILURES = [
  "CONFIRMATION_NOT_FOUND",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_ALREADY_USED",
] as const;
export const appIntentConfirmationFailureSchema = z.enum(APP_INTENT_CONFIRMATION_FAILURES);
export type AppIntentConfirmationFailure = z.infer<typeof appIntentConfirmationFailureSchema>;

/** The request body for `POST /app-intents`. Either free text to match, or an intent a click already knows. */
export const appIntentRequestSchema = z
  .strictObject({
    text: z.string().min(1).optional(),
    kind: appIntentKindSchema.optional(),
    tab: settingsTabSchema.optional(),
    /** Carried so a click can name a widget; a spoken sentence gets its target from the matcher. */
    definitionId: capabilityRefSchema.optional(),
    family: widgetFamilySchema.optional(),
    /** Carried so a click or an agent tool call can name a configured model-pool profile directly. */
    modelAlias: modelAliasSchema.optional(),
    conversationId: z.string().min(1).max(128).optional(),
    source: appIntentSourceSchema,
  })
  .refine((body) => body.text !== undefined || body.kind !== undefined, {
    message: "a request needs either text to match or a kind already decided",
  });
export type AppIntentRequest = z.infer<typeof appIntentRequestSchema>;

/** The request body for `POST /app-intents/confirm`. */
export const appIntentConfirmRequestSchema = z.strictObject({
  confirmationToken: confirmationTokenSchema,
  decision: confirmationDecisionSchema,
  conversationId: z.string().min(1).max(128).optional(),
});
export type AppIntentConfirmRequest = z.infer<typeof appIntentConfirmRequestSchema>;

/** The audit document appended for every intent that was acted on. */
export const appIntentEventDocumentSchema = z.strictObject({
  kind: appIntentKindSchema,
  tab: settingsTabSchema.optional(),
  /** Recorded so the audit can answer *which* widget was shown, not only that the library opened. */
  definitionId: capabilityRefSchema.optional(),
  family: widgetFamilySchema.optional(),
  /** Recorded so the audit can answer which profile a `model.select` switched to. */
  modelAlias: modelAliasSchema.optional(),
  source: appIntentSourceSchema,
  confirmed: z.boolean(),
});
export type AppIntentEventDocument = z.infer<typeof appIntentEventDocumentSchema>;
