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

/**
 * The nine kinds.
 *
 * Issue #17 says "all 8 command groups" and then lists nine things to do. Nine kinds implement the
 * list; the count in the prose is the thing that is wrong, and it is named here rather than quietly
 * matched to whichever number was easier.
 */
export const APP_INTENT_KINDS = [
  "voice.end",
  "window.expand",
  "window.minimise",
  "window.minimal",
  "settings.open",
  "settings.tab",
  "nav.home",
  "composer.attach",
  "app.quit",
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
export const SETTINGS_TABS = ["general", "models", "tools", "devices"] as const;
export const settingsTabSchema = z.enum(SETTINGS_TABS);
export type SettingsTab = z.infer<typeof settingsTabSchema>;

/**
 * Where a request came from.
 *
 * Recorded on every audit event. It is the field that answers "did a person click this or did the
 * microphone hear something that sounded like it", which is the first question anyone asks after an
 * application does something surprising.
 */
export const appIntentSourceSchema = z.enum(["chat", "click", "voice"]);
export type AppIntentSource = z.infer<typeof appIntentSourceSchema>;

export const appIntentSchema = z
  .strictObject({
    kind: appIntentKindSchema,
    tab: settingsTabSchema.optional(),
  })
  .refine((intent) => intent.kind !== "settings.tab" || intent.tab !== undefined, {
    message: "settings.tab must name the tab to change to",
    path: ["tab"],
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

/** What the person is told when a command-shaped sentence matched nothing. */
export const APP_INTENT_NOT_UNDERSTOOD =
  "Tôi chưa hiểu câu lệnh đó, nên tôi chưa làm gì cả. Bạn nói lại rõ hơn giúp tôi nhé.";

const TAB_LABELS: Record<SettingsTab, string> = {
  general: "Chung",
  models: "Model",
  tools: "Công cụ",
  devices: "Thiết bị",
};

/**
 * The sentence read back before the application acts.
 *
 * Said out loud for a spoken command and shown for a typed one, which is why it is a property of the
 * intent rather than of the voice path. A read-back is the whole confirmation mechanism for the eight
 * intents that do not ask: hearing "I am closing the window" is what lets someone stop it.
 */
export function describeAppIntent(intent: AppIntent): string {
  switch (intent.kind) {
    case "voice.end":
      return "Tôi kết thúc phiên thoại nhé.";
    case "window.expand":
      return "Tôi mở rộng cửa sổ nhé.";
    case "window.minimise":
      return "Tôi thu nhỏ cửa sổ xuống thanh tác vụ nhé.";
    case "window.minimal":
      return "Tôi thu cửa sổ về thanh voice nhé.";
    case "settings.open":
      return "Tôi mở Settings nhé.";
    case "settings.tab":
      return `Tôi mở Settings ở tab ${TAB_LABELS[intent.tab ?? "general"]} nhé.`;
    case "nav.home":
      return "Tôi về màn hình bắt đầu nhé.";
    case "composer.attach":
      return "Tôi mở hộp thoại chọn tệp nhé.";
    case "app.quit":
      return "Tôi hiểu là bạn muốn thoát ứng dụng. Bạn xác nhận chứ?";
    default: {
      // Every kind above returns, so this is unreachable today. It exists so that adding a tenth kind
      // without a sentence is a loud failure in a test rather than `undefined` read aloud by a voice.
      const unreachable: never = intent.kind;
      throw new Error(`no read-back sentence for app intent ${String(unreachable)}`);
    }
  }
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
  source: appIntentSourceSchema,
  confirmed: z.boolean(),
});
export type AppIntentEventDocument = z.infer<typeof appIntentEventDocumentSchema>;
