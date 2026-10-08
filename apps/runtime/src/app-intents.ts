/**
 * The application-intent registry, node side.
 *
 * ## One place that decides, three places that ask
 *
 * A typed command, a click and a spoken sentence all arrive here and leave with the same decision
 * shape. That is the whole architecture of this file: there is no voice-specific executor and no
 * click-specific one, so "open Settings by voice" cannot drift away from "open Settings by
 * clicking" - there is only one answer to give.
 *
 * ## Why quitting needs a token instead of a confirmation flag
 *
 * The dangerous intent is the one that ends the application, and the danger is not that the person
 * did not mean it; it is that a microphone can hear something that sounds like it. So the node never
 * returns an executable quit from a single request. It returns a token, the token is bound to the
 * principal that asked, it expires in two minutes, and only the confirm route turns it into
 * permission. Nothing in the voice path can skip that, because the voice path only ever receives
 * `needs-confirmation`.
 *
 * ## Why a spent token is remembered instead of deleted
 *
 * The plan said to delete the row on success. That makes a replay indistinguishable from a token
 * that never existed, and the two need different answers: a replay is someone trying the same
 * permission twice and deserves `CONFIRMATION_ALREADY_USED`, while an unknown token is a bad request.
 * So success marks the row spent and the row is left in place; the token still cannot be used again,
 * which is the property that matters.
 */

import { randomUUID } from "node:crypto";

import {
  APP_INTENT_NOT_UNDERSTOOD,
  type AppIntent,
  type AppIntentConfirmationFailure,
  type AppIntentDecision,
  type AppIntentLocale,
  type AppIntentRequest,
  type AppIntentResolution,
  type AppIntentSource,
  type ConfirmationToken,
  type ConversationId,
  type Instant,
  type Notice,
  type NoticeAction,
  type NoticeActionUnavailable,
  type NoticeOperationId,
  type SettingsTab,
  NOTICE_DISMISS_UNDO_WINDOW_MS,
  appIntentSchema,
  askToConfirmNoticeUpdate,
  describeAppIntent,
  describeNoticeAction,
  isPersonOnlyNoticeOperation,
  parseSlashCommand,
  pointToNoticeUpdate,
} from "@clarkcant/contracts";
import {
  answerableUnknownEffects,
  deletePreference,
  getPreference,
  quotedEffectIntent,
  recordAppIntentEvent,
  resolveAppIntent,
  newConversationReadBack,
  setPreference,
  slashCommandAppIntent,
} from "@clarkcant/core";
import type { WidgetTarget } from "@clarkcant/core";
import {
  type Database,
  getNotification,
  latestRestorableNotification,
  listNotifications,
  listSnoozedNotifications,
} from "@clarkcant/storage";

import { noticeActionsFor } from "./notice-actions.ts";

import { checkThemeChoice, themeTargets } from "./application/appearance-intents.ts";
import { decideConversationDeletion, deletionRefusal } from "./application/conversation-delete.ts";
import type { ThemeRegistry } from "./application/themes.ts";

export interface AppIntentDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  runningConversations?: () => readonly string[];
  /**
   * The widgets a spoken or typed sentence may name.
   *
   * Supplied by the runtime from the canonical catalogue rather than imported by the matcher, which
   * is what keeps `@clarkcant/core` free of a dependency on the catalogue (the pack's sample recipe
   * imports `core`, so the other direction would be a cycle).
   */
  widgetTargets?: readonly WidgetTarget[];
  /**
   * The node's theme registry, read when a request is about a theme and only then. Absent, a request to change the
   * theme is refused: a node that cannot check a theme must not store a choice the page would then ignore.
   */
  themes?: () => ThemeRegistry;
}

const PENDING_PREFIX = "app.intent.pending.";

/**
 * Two minutes.
 *
 * Long enough to answer a question that was just asked, short enough that an unanswered token is not
 * a standing permission to quit the application.
 */
const TOKEN_TTL_MS = 120_000;

/** What a pending token holds. `usedAt` is what makes a replay distinguishable from a forgery. */
interface PendingValue {
  kind: string;
  conversationId?: string;
  tab?: SettingsTab;
  /** The effect an answer names, so the yes that confirms it answers that one effect and no other. */
  effectId?: string;
  /** The notice and the action a confirmed notice action names, so the yes installs that one update and no other. */
  noticeId?: string;
  noticeAction?: NoticeOperationId;
  source?: AppIntentSource;
  at: Instant;
  usedAt?: Instant;
}

function preferenceDeps(deps: Pick<AppIntentDeps, "db" | "now">) {
  return { db: deps.db, now: deps.now };
}

/**
 * The UI language a read-back or refusal should be said in, for a given principal.
 *
 * `experience.language` is a `scope: "global"` preference the settings panel writes (see
 * `packages/contracts/src/preferences.ts`), so it is read the same way here: no conversation- or
 * node-scoped override exists for it. A person who switched the UI to English and then asks Clark
 * to "open settings" — by voice or by typed command — should hear the English sentence back, not
 * the Vietnamese default `describeAppIntent` falls back to when nobody names a locale.
 *
 * Falls back to `"vi"` when nothing was ever written, matching the preference's own registry default
 * and `describeAppIntent`'s own default parameter.
 */
export function preferredAppIntentLocale(deps: Pick<AppIntentDeps, "db" | "now">, principalId: string): AppIntentLocale {
  const record = getPreference(preferenceDeps(deps), {
    principalId,
    key: "experience.language",
    scope: "global",
  });
  return record?.value === "en" ? "en" : "vi";
}

function pendingKey(token: string): string {
  return `${PENDING_PREFIX}${token}`;
}

/**
 * Mint a token for an intent that needs confirming.
 *
 * Scoped to the node rather than to a conversation: the thing being confirmed is a property of the
 * application, and it should not stop working because the window navigated somewhere else.
 */
export function mintConfirmation(
  deps: AppIntentDeps,
  input: { principalId: string; intent: AppIntent; source: AppIntentSource },
): ConfirmationToken {
  const token = randomUUID();
  const value: PendingValue = {
    kind: input.intent.kind,
    ...(input.intent.conversationId === undefined ? {} : { conversationId: input.intent.conversationId }),
    ...(input.intent.tab === undefined ? {} : { tab: input.intent.tab }),
    ...(input.intent.effectId === undefined ? {} : { effectId: input.intent.effectId }),
    ...(input.intent.noticeId === undefined ? {} : { noticeId: input.intent.noticeId }),
    ...(input.intent.noticeAction === undefined ? {} : { noticeAction: input.intent.noticeAction }),
    source: input.source,
    at: deps.now(),
  };
  setPreference(preferenceDeps(deps), {
    principalId: input.principalId,
    key: pendingKey(token),
    scope: "node",
    value,
    source: "user",
  });
  return token;
}

export type ConsumeOutcome =
  | { ok: true; intent: AppIntent; source: AppIntentSource }
  | { ok: false; code: AppIntentConfirmationFailure };

/**
 * Turn a token into permission, once.
 *
 * Everything happens in one synchronous pass with no `await` in it, which is what makes the read-then-write
 * safe without an enclosing transaction: this node backs storage with a synchronous engine in a single process,
 * so nothing else can write between the read and the write. Wrapping it in `transaction()` is not possible
 * anyway - `setPreference` opens its own, and the engine refuses a nested one rather than risking a silent
 * commit of the outer scope.
 *
 * A token minted for another principal is not found at all - it is not reported as belonging to someone else,
 * since that would confirm the token exists.
 */
export function consumeConfirmation(
  deps: AppIntentDeps,
  input: { principalId: string; token: string },
): ConsumeOutcome {
  const key = pendingKey(input.token);
  const where = { principalId: input.principalId, key, scope: "node" as const };
  const record = getPreference(preferenceDeps(deps), where);
  if (record === undefined) return { ok: false, code: "CONFIRMATION_NOT_FOUND" };

  const value = record.value as PendingValue;
  if (value.usedAt !== undefined) return { ok: false, code: "CONFIRMATION_ALREADY_USED" };

  const ageMs = Date.parse(deps.now()) - Date.parse(value.at);
  if (!(ageMs >= 0) || ageMs > TOKEN_TTL_MS) {
    deletePreference(preferenceDeps(deps), where);
    return { ok: false, code: "CONFIRMATION_EXPIRED" };
  }

  const parsed = appIntentSchema.safeParse({
    kind: value.kind,
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
    ...(value.tab === undefined ? {} : { tab: value.tab }),
    ...(value.effectId === undefined ? {} : { effectId: value.effectId }),
    ...(value.noticeId === undefined ? {} : { noticeId: value.noticeId }),
    ...(value.noticeAction === undefined ? {} : { noticeAction: value.noticeAction }),
  });
  if (!parsed.success) {
    // A row that is not a shapeable intent is not permission; refusing it is the only safe reading.
    deletePreference(preferenceDeps(deps), where);
    return { ok: false, code: "CONFIRMATION_NOT_FOUND" };
  }

  setPreference(preferenceDeps(deps), { ...where, value: { ...value, usedAt: deps.now() }, source: "user" });
  return { ok: true, intent: parsed.data, source: value.source ?? "click" };
}

export interface DecideInput {
  principalId: string;
  /** Where the request came from, and its text when it is a sentence. Its `kind` fields are not read here. */
  request: AppIntentRequest;
  /**
   * The intent a request named directly, already validated by `requestedIntent` at the boundary that received
   * it. Kept out of this function so a malformed kind is a 400 from the route rather than a throw from in here.
   */
  intent?: AppIntent;
  conversationId?: ConversationId;
}

export type RequestedIntent =
  | { ok: true; intent: AppIntent | undefined }
  | { ok: false; message: string };

/**
 * The intent a request names by kind, validated against the contract.
 *
 * A request that names a kind has to carry what that kind needs (`orb.select` a style, for one) and nothing another
 * kind owns. The contract's refinements say which; this turns their verdict into a value the route can answer with,
 * so a caller that got the shape wrong is told why instead of the node throwing.
 */
export function requestedIntent(request: AppIntentRequest): RequestedIntent {
  if (request.kind === undefined) return { ok: true, intent: undefined };
  const parsed = appIntentSchema.safeParse({
    kind: request.kind,
    ...(request.tab === undefined ? {} : { tab: request.tab }),
    ...(request.definitionId === undefined ? {} : { definitionId: request.definitionId }),
    ...(request.family === undefined ? {} : { family: request.family }),
    ...(request.orbProfile === undefined ? {} : { orbProfile: request.orbProfile }),
    ...(request.noticeId === undefined ? {} : { noticeId: request.noticeId }),
    ...(request.noticeAction === undefined ? {} : { noticeAction: request.noticeAction }),
    ...(request.inboxTarget === undefined ? {} : { inboxTarget: request.inboxTarget }),
    ...(request.themeRef === undefined ? {} : { themeRef: request.themeRef }),
    ...(request.colorScheme === undefined ? {} : { colorScheme: request.colorScheme }),
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }
  return { ok: true, intent: parsed.data };
}

/**
 * Decide what a request means, and record it when it means something.
 *
 * A refusal and a `none` are not audited: nothing was done, so there is nothing to have a record of,
 * and a log of sentences the application declined would be a log of what people said.
 */
export function decideAppIntent(
  deps: AppIntentDeps,
  input: DecideInput,
  mint: (intent: AppIntent) => ConfirmationToken,
): AppIntentResolution {
  // The typed/clicked path: read-backs and refusals follow the UI language the person chose in
  // Settings, the same way the voice path does (see `preferredAppIntentLocale`).
  const locale = preferredAppIntentLocale(deps, input.principalId);
  // Read at most once per decision, and only if the request turns out to be about a theme.
  let registry: { value: ThemeRegistry | undefined } | undefined;
  const themes = (): ThemeRegistry | undefined => {
    if (registry === undefined) {
      try {
        registry = { value: deps.themes?.() };
      } catch (error) {
        // A registry that cannot be read refuses a theme change with a sentence rather than failing the request.
        console.error("the theme registry could not be read for an app intent", error);
        registry = { value: undefined };
      }
    }
    return registry.value;
  };
  // A host slash command that is a pure UI intent (`/settings`, `/settings ai`, `/new`) is decided here like the
  // sentence or click that asks for the same thing, whether it arrived as a message or while a reply was still being
  // written: one reading, one decision, one audit record. Any other command is a message, not an app intent.
  const slash = input.intent === undefined && input.request.text !== undefined ? parseSlashCommand(input.request.text) : undefined;
  const slashIntent = slash === undefined ? undefined : slashCommandAppIntent(slash, locale);
  if (slash !== undefined && slashIntent === undefined) return { kind: "none" };
  if (slashIntent?.kind === "refused") return { kind: "refused", say: slashIntent.say };
  const named = slashIntent?.intent ?? input.intent;
  const text = slash === undefined ? input.request.text : undefined;
  const resolution = resolveAppIntent({
    ...(text === undefined ? {} : { text }),
    ...(named === undefined ? {} : { intent: named }),
    mintConfirmationToken: () => randomUUID() as ConfirmationToken,
    ...(deps.widgetTargets === undefined ? {} : { widgetTargets: deps.widgetTargets }),
    themeTargets: () => {
      const read = themes();
      return read === undefined ? [] : themeTargets(read);
    },
    locale,
  });

  if (resolution.kind === "none" || resolution.kind === "refused") {
    return resolution.kind === "refused" ? resolution : { kind: "none" };
  }

  const themed = checkedTheme(resolution, themes, locale);
  if (themed.kind === "refused") return themed;
  const effectAnswer = answerAboutEffect(deps, input, themed, locale);
  if (effectAnswer.kind === "refused") return effectAnswer;
  const answered = resolveNoticeTarget(deps, input, effectAnswer, locale);
  if (answered.kind === "refused") return answered;
  const intent = answered.intent;
  if (intent.kind === "conversation.delete") {
    if (input.request.source === "agent" || input.request.source === "voice-agent") {
      return {kind: "refused", say: locale === "vi" ? "Chỉ người dùng có thể yêu cầu xoá hội thoại; mọi dữ liệu được giữ lại." : "Only the person may ask to delete a conversation; all data is kept."};
    }
    const id = input.conversationId;
    if (id === undefined) return {kind: "refused", say: deletionRefusal(locale, "missing")};
    const bound: AppIntent = {kind: "conversation.delete", conversationId: id};
    const policy = decideConversationDeletion({...deps, principalId: input.principalId}, id, locale);
    if (policy.kind === "refused") return policy;
    const readBack = describeAppIntent(bound, locale);
    if (policy.kind === "ask") return {kind: "needs-confirmation", intent: bound, confirmationToken: mint(bound), readBack};
    recordAppIntentEvent(deps, {intent: bound, source: input.request.source, confirmed: false, conversationId: id});
    return {kind: "intent", intent: bound, requiresConfirmation: false, readBack};
  }
  if (answered.kind === "needs-confirmation") {
    // The minted token is replaced here by one that is actually stored: the decision function is pure
    // and cannot write, so the write happens in this layer.
    const token = mint(intent);
    return { ...answered, confirmationToken: token };
  }
  recordAppIntentEvent(deps, {
    intent,
    source: input.request.source,
    confirmed: false,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
  });
  if (slash?.command === "new") {
    // `/new` says what it does whichever way it arrived, and, sent while Clark is still answering here, that the reply
    // goes on being written in this conversation rather than being lost or stopped.
    const replying = input.conversationId !== undefined && (deps.runningConversations?.() ?? []).includes(input.conversationId);
    return { ...answered, readBack: newConversationReadBack(locale, replying) };
  }
  return answered;
}

/**
 * A theme change checked against the node's registry, whichever way it was asked for: a sentence names only a theme
 * the registry listed, and a click names a reference that may since have been uninstalled. The read-back names the
 * theme by its display name, filled in here and never taken from the request.
 */
function checkedTheme(
  resolution: Exclude<AppIntentResolution, { kind: "none" | "refused" }>,
  themes: () => ThemeRegistry | undefined,
  locale: AppIntentLocale,
): Exclude<AppIntentResolution, { kind: "none" }> {
  if (resolution.kind !== "intent" || resolution.intent.kind !== "appearance.set-theme") return resolution;
  const checked = checkThemeChoice(themes(), resolution.intent.themeRef ?? "", locale);
  if (!checked.ok) return { kind: "refused", say: checked.say };
  return { ...resolution, intent: checked.intent, readBack: checked.readBack };
}

/**
 * "It took effect", "chưa có hiệu lực": the person's answer to an effect whose outcome nobody observed, as a sentence.
 *
 * A sentence names no effect, so the node names it: exactly one effect waiting for this person is the one the sentence
 * answers, and the read-back says which. None waiting, or several, is refused rather than guessed — with several, the
 * inbox is where each one can be answered by its own buttons. The agent's own sources are refused outright: it is the
 * person's answer (see `PERSON_ONLY_APP_INTENT_KINDS`).
 *
 * An answer cannot be changed once recorded, so a sentence never records one on its own. Spoken, it is asked back and a
 * spoken yes spends a token (`needs-confirmation`, as for quitting). Typed, it opens the inbox, where the notice's own
 * buttons and their warning are the confirmation.
 *
 * Only decided here. Recording is the page's, through the person-only `POST /effects/:effectId/reconcile`, so a
 * message sent through a machine surface can at most be told what would be answered, never answer it.
 */
function answerAboutEffect(
  deps: AppIntentDeps,
  input: DecideInput,
  resolution: Exclude<AppIntentResolution, { kind: "none" | "refused" }>,
  locale: AppIntentLocale,
): Exclude<AppIntentResolution, { kind: "none" }> {
  const kind = resolution.intent.kind;
  if (kind !== "effect.confirmed" && kind !== "effect.failed") return resolution;
  const en = locale === "en";
  if (input.request.source === "agent" || input.request.source === "voice-agent") {
    return {
      kind: "refused",
      say: en
        ? "Only you can say whether that took effect, so I have not recorded anything."
        : "Chỉ bạn mới ghi nhận được việc đó đã có hiệu lực hay chưa, nên tôi chưa ghi gì cả.",
    };
  }
  const waiting = answerableUnknownEffects({ db: deps.db, nodeId: deps.nodeId, principalId: input.principalId });
  const [only] = waiting;
  if (only === undefined) {
    return {
      kind: "refused",
      say: en
        ? "Nothing is waiting for you to say whether it took effect, so I have not recorded anything."
        : "Không có việc nào đang chờ bạn xác nhận kết quả, nên tôi chưa ghi gì cả.",
    };
  }
  if (waiting.length > 1) {
    return {
      kind: "refused",
      say: en
        ? `${waiting.length} actions are waiting for your answer. Open the inbox and answer the one you checked, so nothing is recorded against the wrong one.`
        : `Có ${waiting.length} việc đang chờ bạn xác nhận kết quả. Bạn mở hộp thư và trả lời đúng việc bạn đã kiểm tra, để tôi không ghi nhầm.`,
    };
  }
  const name = quotedEffectIntent(only, locale);
  const confirmed = kind === "effect.confirmed";
  if (input.request.source === "voice") {
    // Asked back and answered with a spoken yes, through the same token a spoken quit uses (`CONFIRMATION_REQUIRED_KINDS`):
    // a misheard sentence must not record an answer that cannot be changed.
    return {
      kind: "needs-confirmation",
      intent: { kind, effectId: only.effectId },
      readBack: en
        ? `Record that ${name} ${confirmed ? "took effect" : "did not take effect"}? Once recorded, it cannot be changed.`
        : `Ghi nhận ${name} ${confirmed ? "đã" : "chưa"} có hiệu lực? Ghi nhận xong thì không đổi lại được.`,
      confirmationToken: resolution.kind === "needs-confirmation" ? resolution.confirmationToken : (randomUUID() as ConfirmationToken),
    };
  }
  // Typed, the answer is given where the buttons are: the inbox opens on the notice, whose two buttons carry the warning
  // that an answer cannot be changed. One press there is the confirmation, so nothing is recorded from the sentence alone.
  const button = en ? (confirmed ? "It took effect" : "It did not take effect") : confirmed ? "Đã có hiệu lực" : "Chưa có hiệu lực";
  return {
    kind: "intent",
    intent: { kind: "inbox.open" },
    requiresConfirmation: false,
    readBack: en
      ? `To record that ${name} ${confirmed ? "took effect" : "did not take effect"}, press “${button}” on its notice in the inbox. Once recorded, it cannot be changed.`
      : `Để ghi nhận ${name} ${confirmed ? "đã" : "chưa"} có hiệu lực, bạn bấm “${button}” ở thông báo của nó trong hộp thư. Ghi nhận xong thì không đổi lại được.`,
  };
}

/**
 * Without a notice named, these act on the newest notice in the list, which is the one "the latest notice" means. The
 * rest act on the newest notice that offers them now: "retry the failed background work" means the work that failed,
 * wherever its notice sits in the list.
 */
const NEWEST_NOTICE_ACTIONS: ReadonlySet<NoticeOperationId> = new Set(["mark-read", "mark-unread", "dismiss", "snooze", "suppress", "unsuppress"]);

/** How many notices a sentence's target is looked for among: the page the inbox shows. */
const NOTICE_TARGET_WINDOW = 50;

/**
 * "Dismiss the latest notification", "retry the failed background work": which notice a sentence means, decided here.
 *
 * A sentence names an action and never a notice, so the node names it from the inbox as it is now (see
 * `NEWEST_NOTICE_ACTIONS`); a click names the notice itself, and that notice is checked the same way. Either way the
 * action has to be one `noticeActionsFor` offers the notice now, and possible — the same resolver that draws the panel's
 * buttons and that `performNoticeOperation` checks again when the page carries the action out — so a sentence cannot
 * reach an action the panel would not show. Nothing that fits is refused with a sentence that says so rather than
 * guessed. The read-back names the notice by its title, so a person who hears the wrong one can stop it.
 */
function resolveNoticeTarget(
  deps: AppIntentDeps,
  input: DecideInput,
  resolution: Exclude<AppIntentResolution, { kind: "none" | "refused" }>,
  locale: AppIntentLocale,
): Exclude<AppIntentResolution, { kind: "none" }> {
  if (resolution.kind !== "intent" || resolution.intent.kind !== "notice.act") return resolution;
  const en = locale === "en";
  const action = resolution.intent.noticeAction;
  // The matcher always names the action and the contract refuses a request without one; kept so the type says so.
  if (action === undefined) return { kind: "refused", say: APP_INTENT_NOT_UNDERSTOOD };
  const source = input.request.source;
  if (isPersonOnlyNoticeOperation(action) && (source === "agent" || source === "voice-agent")) {
    return {
      kind: "refused",
      say: en
        ? "Installing an update is yours to decide, so I have not installed anything. Press “Update” on the notice in the inbox."
        : "Cài bản cập nhật là việc bạn quyết định, nên tôi chưa cài gì cả. Bạn bấm “Cập nhật” ở thông báo trong hộp thư nhé.",
    };
  }
  const now = deps.now();
  if (action === "restore") return resolveRestoreTarget(deps, input, resolution.intent.noticeId, locale);
  const context = { nodeId: deps.nodeId, now };
  const offer = (notice: Notice): NoticeAction | undefined =>
    action === "mark-read" || action === "mark-unread"
      ? { id: action, placement: "menu" }
      : // `restore` is answered above; it is never a button on a notice in the list.
        noticeActionsFor(deps.db, input.principalId, notice, context).find((entry) => entry.id === action);

  let notice: Notice | undefined;
  const named = resolution.intent.noticeId;
  if (named !== undefined) {
    const stored = getNotification(deps.db, input.principalId, named, now);
    if (stored === undefined || stored.dismissed) {
      return {
        kind: "refused",
        say: en ? "That notice is no longer in your inbox, so I have not done anything." : "Thông báo đó không còn trong hộp thư, nên tôi chưa làm gì cả.",
      };
    }
    notice = stored.notice;
  } else if (action === "unsnooze") {
    [notice] = listSnoozedNotifications(deps.db, input.principalId, now);
  } else if (NEWEST_NOTICE_ACTIONS.has(action)) {
    [notice] = listNotifications(deps.db, input.principalId, 1, now);
  } else {
    notice = listNotifications(deps.db, input.principalId, NOTICE_TARGET_WINDOW, now).find((candidate) => {
      const offered = offer(candidate);
      return offered !== undefined && offered.unavailable === undefined;
    });
  }
  if (notice === undefined) {
    return {
      kind: "refused",
      say: en
        ? `No notice in your inbox lets me ${NOTICE_ACTION_LABEL_EN[action]} right now, so I have not done anything.`
        : `Lúc này không có thông báo nào trong hộp thư để ${NOTICE_ACTION_LABEL_VI[action]}, nên tôi chưa làm gì cả.`,
    };
  }
  const offered = offer(notice);
  if (offered === undefined || offered.unavailable !== undefined) {
    const why = offered?.unavailable;
    return {
      kind: "refused",
      say: en
        ? `The notice “${notice.title}” does not let me ${NOTICE_ACTION_LABEL_EN[action]} right now${why === undefined ? "" : ` because ${UNAVAILABLE_EN[why]}`}, so I have not done anything.`
        : `Không thể ${NOTICE_ACTION_LABEL_VI[action]} với thông báo “${notice.title}”${why === undefined ? "" : ` vì ${UNAVAILABLE_VI[why]}`}, nên tôi chưa làm gì cả.`,
    };
  }
  if (isPersonOnlyNoticeOperation(action)) {
    // Installing is never done from a sentence alone. Spoken, it is asked back and a spoken yes spends a single-use token,
    // as quitting does, so a misheard "update" installs nothing. Typed, the inbox opens on the notice, and its Update
    // button is the confirmation — the same press as installing without a sentence.
    if (source === "voice") {
      return {
        kind: "needs-confirmation",
        intent: { kind: "notice.act", noticeId: notice.noticeId, noticeAction: action },
        readBack: askToConfirmNoticeUpdate(locale, notice.title),
        // Replaced by a stored token in `decideAppIntent`; this one is only the shape.
        confirmationToken: randomUUID() as ConfirmationToken,
      };
    }
    return {
      kind: "intent",
      intent: { kind: "inbox.open", inboxTarget: `notice:${notice.noticeId}` },
      requiresConfirmation: false,
      readBack: pointToNoticeUpdate(locale, notice.title),
    };
  }
  return {
    kind: "intent",
    intent: { kind: "notice.act", noticeId: notice.noticeId, noticeAction: action },
    requiresConfirmation: false,
    readBack: describeNoticeAction(action, locale, notice.title),
  };
}

/**
 * "Undo dismissing the notification": the notice the click named, or the one most recently dismissed while its
 * dismissal can still be undone. The read-back names it, so a person who hears the wrong one can dismiss it again.
 */
function resolveRestoreTarget(
  deps: AppIntentDeps,
  input: DecideInput,
  named: string | undefined,
  locale: AppIntentLocale,
): Exclude<AppIntentResolution, { kind: "none" }> {
  const en = locale === "en";
  const now = deps.now();
  let notice: Notice | undefined;
  if (named === undefined) {
    notice = latestRestorableNotification(deps.db, input.principalId, now);
  } else {
    const stored = getNotification(deps.db, input.principalId, named, now);
    if (stored !== undefined && !stored.dismissed) {
      return {
        kind: "refused",
        say: en ? "That notice is already in your inbox, so there is nothing to undo." : "Thông báo đó vẫn đang ở trong hộp thư, nên không có gì để hoàn tác.",
      };
    }
    notice = stored?.notice;
  }
  if (notice === undefined) {
    const minutes = String(NOTICE_DISMISS_UNDO_WINDOW_MS / 60_000);
    return {
      kind: "refused",
      say: en
        ? `No notice was dismissed in the last ${minutes} minutes, so there is nothing to undo.`
        : `Không có thông báo nào bị bỏ trong ${minutes} phút vừa qua, nên không có gì để hoàn tác.`,
    };
  }
  return {
    kind: "intent",
    intent: { kind: "notice.act", noticeId: notice.noticeId, noticeAction: "restore" },
    requiresConfirmation: false,
    readBack: describeNoticeAction("restore", locale, notice.title),
  };
}

const NOTICE_ACTION_LABEL_VI: Record<NoticeOperationId, string> = {
  "mark-read": "đánh dấu đã đọc",
  "mark-unread": "đánh dấu chưa đọc",
  dismiss: "bỏ thông báo",
  restore: "hoàn tác việc bỏ thông báo",
  snooze: "hoãn thông báo",
  unsnooze: "đưa thông báo đã hoãn trở lại",
  suppress: "tắt báo loại thông báo này",
  unsuppress: "bật lại báo loại thông báo này",
  retry: "chạy lại việc nền",
  update: "cài bản cập nhật",
  "skip-version": "bỏ qua phiên bản",
  "ask-again": "hỏi lại câu hỏi đã hết hạn",
};

const NOTICE_ACTION_LABEL_EN: Record<NoticeOperationId, string> = {
  "mark-read": "mark it as read",
  "mark-unread": "mark it as unread",
  dismiss: "dismiss it",
  restore: "undo its dismissal",
  snooze: "snooze it",
  unsnooze: "bring it back from a snooze",
  suppress: "stop notifications of its kind",
  unsuppress: "turn notifications of its kind back on",
  retry: "retry its background work",
  update: "install its update",
  "skip-version": "skip its version",
  "ask-again": "ask its expired question again",
};

const UNAVAILABLE_VI: Record<NoticeActionUnavailable, string> = {
  "conversation-gone": "cuộc trò chuyện của nó không còn",
  "work-gone": "node không còn bản ghi của việc đó",
  "package-gone": "gói đó không còn được cài",
  "already-current": "gói đã ở phiên bản đó rồi",
};

const UNAVAILABLE_EN: Record<NoticeActionUnavailable, string> = {
  "conversation-gone": "its conversation is gone",
  "work-gone": "the node no longer keeps a record of that work",
  "package-gone": "that package is no longer installed",
  "already-current": "the package is already at that version",
};

/** The sentence for the one refusal that comes from a request naming no tab. */
export const TAB_MISSING_SAY = APP_INTENT_NOT_UNDERSTOOD;

export type { AppIntentSource };

/** Re-exported so a caller testing a decision does not have to reach for the contract module. */
export { describeAppIntent, type AppIntentDecision, type AppIntentLocale };
