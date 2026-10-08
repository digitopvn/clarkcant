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
import { NOTICE_DISMISS_UNDO_WINDOW_MS, type NoticeOperationId, inboxTargetSchema, noticeOperationIdSchema } from "./inbox.ts";
import { ORB_PROFILE_LABELS, orbProfileSchema } from "./preferences.ts";
import type { SlashCommand } from "./slash-commands.ts";
import { colorSchemeSchema, themeRefSchema, type ColorScheme } from "./themes.ts";

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
  "inbox.ask",
  "turn.stop",
  "conversation.delete",
  "orb.select",
  "effect.confirmed",
  "effect.failed",
  "notice.act",
  "appearance.set-theme",
  "appearance.set-color-scheme",
  "appearance.reset",
  "appearance.open-theme-gallery",
] as const;

export const appIntentKindSchema = z.enum(APP_INTENT_KINDS);
export type AppIntentKind = z.infer<typeof appIntentKindSchema>;

/**
 * The kinds only the person may ask for: deleting a conversation or resolving an unobserved effect.
 *
 * "It took effect" decides what a task may report about itself, so it is the person's the way an approval is. The node
 * refuses these from the agent's own sources (`agent`, `voice-agent`), `control_app` does not offer them, the page's
 * executor refuses one that carries an agent's `controlId`, and the route it finally calls is person-only
 * (`isPersonOnlyRoute`). Four checks rather than one, because each surface is reachable on its own.
 */
export const PERSON_ONLY_APP_INTENT_KINDS: readonly AppIntentKind[] = ["effect.confirmed", "effect.failed", "conversation.delete"];

export function isPersonOnlyAppIntent(kind: AppIntentKind): boolean {
  return PERSON_ONLY_APP_INTENT_KINDS.includes(kind);
}

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
 * `"agent"` marks a request the main model made through a tool call, and `"voice-agent"` one the
 * model answering a spoken sentence made, rather than one a person typed (`"chat"`), clicked or said
 * (`"voice"`). Kept in the same enum as the others rather than a separate `origin` field, because
 * every caller of this schema already switches on `source` and a second field would let the two
 * disagree - an "agent" request whose `source` still said "chat" would be audited as if a person had
 * asked for it. The five values are the five answers the audit has to be able to give.
 */
export const appIntentSourceSchema = z.enum(["chat", "click", "voice", "agent", "voice-agent"]);
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

/** A theme's display name as a read-back carries it: the same bound a theme document's `displayName` has. */
export const appIntentThemeNameSchema = z.string().trim().min(1).max(80);

/**
 * The two widget kinds.
 *
 * The four appearance kinds change how the whole window looks — the theme, the colour scheme, both back to Clark
 * Default and System, or the list of themes to choose from. Each is a preference write any Settings control can make
 * and undo, so none asks for confirmation; which theme a reference draws is checked by the node's registry, not here.
 *
 * `widgets.open` opens the library on the catalogue; `widgets.show` opens it on a particular widget
 * or family. Neither carries anything executable, which is why neither needs confirmation: the worst
 * an unwanted one can do is show a catalogue the person can close.
 */
export const appIntentSchema = z
  .strictObject({
    kind: appIntentKindSchema,
    /** The node binds deletion to the conversation in which the person asked, never a name parsed from prose. */
    conversationId: z.string().min(1).max(128).optional(),
    /** Minted only after the person answers a policy question; the deletion capability spends it once. */
    deletionPermit: z.uuid().optional(),
    tab: settingsTabSchema.optional(),
    definitionId: capabilityRefSchema.optional(),
    family: widgetFamilySchema.optional(),
    /** Carried only by `model.select`, naming a profile from the configured pool - never a bare provider/model string. */
    modelAlias: modelAliasSchema.optional(),
    /**
     * Carried only by `orb.select`: one of the orb's named profiles, the same closed set the `orb.profile` preference
     * accepts. A name, never a colour or a shader value, so this channel cannot carry anything the Settings buttons
     * could not.
     */
    orbProfile: orbProfileSchema.optional(),
    /**
     * Carried only by `effect.confirmed` and `effect.failed`: the one effect the node found waiting for the person's
     * answer when it understood the sentence. Filled in by the node, never taken from the words, so a sentence can only
     * answer the effect the node itself named in the read-back.
     */
    effectId: z.string().min(1).max(128).optional(),
    /**
     * Carried only by `notice.act`: the notice, and which of the node's own notice actions to take on it
     * (`NOTICE_OPERATION_IDS`). The notice is named by the node, never read from the words: a sentence such as "dismiss
     * the latest notification" is resolved to the newest notice that offers that action now, and the read-back names it.
     */
    noticeId: z.string().min(1).max(128).optional(),
    noticeAction: noticeOperationIdSchema.optional(),
    /**
     * Carried only by `inbox.open`, and only optionally: the notice or waiting item the inbox should open on, as an OS or
     * web notification's click names it (`inboxTargetSchema`). An id, never anything the person would read.
     */
    inboxTarget: inboxTargetSchema.optional(),
    /**
     * Carried only by `appearance.set-theme`: the theme to draw, as the `experience.themeRef` preference names it. A
     * reference, never a document: what it draws is whatever the node's registry holds under it, checked there.
     */
    themeRef: themeRefSchema.optional(),
    /**
     * Carried only by `appearance.set-theme`, beside `themeRef`: the theme's display name, for the read-back. Filled in
     * by the node from its registry, never taken from the words or a click, so a read-back names the theme that will
     * actually be drawn.
     */
    themeName: appIntentThemeNameSchema.optional(),
    /** Carried only by `appearance.set-color-scheme`: System, Light or Dark. */
    colorScheme: colorSchemeSchema.optional(),
  })
  .refine((intent) => intent.kind === "conversation.delete" || (intent.conversationId === undefined && intent.deletionPermit === undefined), {
    message: "only conversation.delete may carry a conversation or deletion permit",
    path: ["conversationId"],
  })
  .refine((intent) => intent.kind !== "appearance.set-theme" || intent.themeRef !== undefined, {
    message: "appearance.set-theme must name the theme to switch to",
    path: ["themeRef"],
  })
  .refine((intent) => intent.kind === "appearance.set-theme" || (intent.themeRef === undefined && intent.themeName === undefined), {
    message: "only appearance.set-theme may name a theme",
    path: ["themeRef"],
  })
  .refine((intent) => intent.kind !== "appearance.set-color-scheme" || intent.colorScheme !== undefined, {
    message: "appearance.set-color-scheme must name System, Light or Dark",
    path: ["colorScheme"],
  })
  .refine((intent) => intent.kind === "appearance.set-color-scheme" || intent.colorScheme === undefined, {
    message: "only appearance.set-color-scheme may name a colour scheme",
    path: ["colorScheme"],
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
  })
  .refine((intent) => intent.kind !== "orb.select" || intent.orbProfile !== undefined, {
    message: "orb.select must name the orb profile to switch to",
    path: ["orbProfile"],
  })
  .refine((intent) => intent.kind === "orb.select" || intent.orbProfile === undefined, {
    message: "only orb.select may name an orb profile",
    path: ["orbProfile"],
  })
  .refine((intent) => (intent.kind !== "effect.confirmed" && intent.kind !== "effect.failed") || intent.effectId !== undefined, {
    message: "an answer about an effect must name the effect it answers",
    path: ["effectId"],
  })
  .refine((intent) => intent.kind === "effect.confirmed" || intent.kind === "effect.failed" || intent.effectId === undefined, {
    message: "only an answer about an effect may name one",
    path: ["effectId"],
  })
  .refine((intent) => intent.kind !== "notice.act" || (intent.noticeId !== undefined && intent.noticeAction !== undefined), {
    message: "notice.act must name the notice and the action to take on it",
    path: ["noticeId"],
  })
  .refine((intent) => intent.kind === "notice.act" || (intent.noticeId === undefined && intent.noticeAction === undefined), {
    message: "only notice.act may name a notice or a notice action",
    path: ["noticeId"],
  })
  .refine((intent) => intent.kind === "inbox.open" || intent.inboxTarget === undefined, {
    message: "only inbox.open may name where the inbox opens",
    path: ["inboxTarget"],
  });
export type AppIntent = z.infer<typeof appIntentSchema>;

/**
 * The intents never executable from a single request: quitting, and an answer about an effect, which cannot be changed
 * once recorded. The node turns a sentence answering an effect into its own question (spoken) or into the inbox's
 * buttons (typed); see `answerAboutEffect` in the runtime.
 */
export const CONFIRMATION_REQUIRED_KINDS: readonly AppIntentKind[] = ["app.quit", "effect.confirmed", "effect.failed"];

export function intentRequiresConfirmation(kind: AppIntentKind): boolean {
  return CONFIRMATION_REQUIRED_KINDS.includes(kind);
}

/**
 * The typed slash commands that stand for one app intent whatever follows them: `/new` is going home, as the logo is.
 *
 * The one copy of that reading. The node resolves a typed command through it (`slashCommandAppIntent` in
 * `@clarkcant/core`), and the page reads it to go home at once on `/new` typed during a reply, before the node has
 * answered. Two copies would drift: were `/new` to gain an argument the node reads, a page reading its own copy would
 * still go home at once and drop it. A command whose meaning depends on its argument (`/settings <tab>`) is not here.
 */
export const SLASH_COMMAND_INTENTS: Readonly<Partial<Record<SlashCommand, AppIntentKind>>> = { new: "nav.home" };

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
 * What each Settings tab is called on screen, in each interface language.
 *
 * The one source of the labels: the panel draws its tab strip from these, a read-back and a refusal name a tab by
 * them, and the matcher accepts every word in them as that tab's name. A command names a tab the person is looking
 * at, so the words here are the words on screen; a second list would drift from the panel, and a person typing
 * the label they see would be told the tab does not exist.
 */
export const SETTINGS_TAB_LABELS = {
  experience: { vi: "Trải nghiệm", en: "Experience" },
  ai: { vi: "AI & Định tuyến", en: "AI & Routing" },
  control: { vi: "Kiểm soát", en: "Control" },
  extensions: { vi: "Tiện ích", en: "Extensions" },
  devices: { vi: "Thiết bị & Giọng nói", en: "Devices & Voice" },
  memory: { vi: "Bộ nhớ", en: "Memory" },
  developer: { vi: "Nhà phát triển", en: "Developer" },
} as const satisfies Record<SettingsTab, Record<AppIntentLocale, string>>;

/** Every Settings tab by its label in `locale`, in the panel's order: what a refusal lists. */
export function settingsTabLabelList(locale: AppIntentLocale): string {
  return SETTINGS_TABS.map((tab) => SETTINGS_TAB_LABELS[tab][locale]).join(", ");
}

/**
 * The read-back for a notice action, naming the notice by its title when the caller has it (the node does, once it has
 * resolved which notice a sentence means) and as "that notice" when it does not.
 */
export function describeNoticeAction(action: NoticeOperationId, locale: AppIntentLocale = "vi", title?: string): string {
  const en = locale === "en";
  const notice = noticeNamed(locale, title);
  switch (action) {
    case "mark-read":
      return en ? `Marking ${notice} as read.` : `Tôi đánh dấu ${notice} là đã đọc nhé.`;
    case "mark-unread":
      return en ? `Marking ${notice} as unread.` : `Tôi đánh dấu ${notice} là chưa đọc nhé.`;
    case "dismiss": {
      // True because the page keeps an Undo beside this sentence for the whole window, and "undo dismissing the
      // notification" restores it too; the node accepts the undo for exactly as long.
      const minutes = String(NOTICE_DISMISS_UNDO_WINDOW_MS / 60_000);
      return en
        ? `Dismissing ${notice}. You can undo this within ${minutes} minutes.`
        : `Tôi bỏ ${notice} khỏi hộp thư nhé. Bạn có thể hoàn tác trong ${minutes} phút.`;
    }
    case "restore":
      return en ? `Undoing the dismissal of ${notice}.` : `Tôi hoàn tác việc bỏ ${notice} nhé.`;
    case "snooze":
      return en ? `Snoozing ${notice} for an hour.` : `Tôi hoãn ${notice} một tiếng nhé.`;
    case "unsnooze":
      return en ? `Bringing ${notice} back to the inbox.` : `Tôi đưa ${notice} trở lại hộp thư nhé.`;
    case "suppress":
      return en ? `Stopping notifications like ${notice}.` : `Tôi tắt báo cho loại thông báo như ${notice} nhé.`;
    case "unsuppress":
      return en ? `Notifying you again about notices like ${notice}.` : `Tôi bật lại báo cho loại thông báo như ${notice} nhé.`;
    case "retry":
      return en ? `Running the background work in ${notice} again.` : `Tôi chạy lại việc nền trong ${notice} nhé.`;
    case "update":
      return en ? `Installing the update ${notice} is about.` : `Tôi cài bản cập nhật trong ${notice} nhé.`;
    case "skip-version":
      return en ? `Skipping the version ${notice} is about.` : `Tôi bỏ qua phiên bản trong ${notice} nhé.`;
    case "ask-again":
      return en ? `Asking the expired question in ${notice} again.` : `Tôi hỏi lại câu hỏi đã hết hạn trong ${notice} nhé.`;
    default: {
      const unreachable: never = action;
      throw new Error(`no read-back sentence for notice action ${String(unreachable)}`);
    }
  }
}

/** A notice as a read-back names it: by its title when the node resolved one, as "that notice" when it did not. */
function noticeNamed(locale: AppIntentLocale, title: string | undefined): string {
  const en = locale === "en";
  if (title === undefined) return en ? "that notice" : "thông báo đó";
  return en ? `the notice “${title}”` : `thông báo “${title}”`;
}

/**
 * The question a spoken "install the latest update" is answered with. Installing puts new code on the machine and grants
 * it what its manifest asks for, so a sentence alone never installs: a spoken yes spends a single-use token, as it does
 * for quitting.
 */
export function askToConfirmNoticeUpdate(locale: AppIntentLocale = "vi", title?: string): string {
  const notice = noticeNamed(locale, title);
  return locale === "en"
    ? `Install the update in ${notice}? It adds new code and the permissions it asks for. Do you confirm?`
    : `Cài bản cập nhật trong ${notice}? Bản này thêm mã mới và các quyền nó yêu cầu. Bạn xác nhận chứ?`;
}

/**
 * What a typed "install the latest update" is answered with: the inbox opens on the notice, and its Update button is the
 * confirmation — the same place and the same press as installing it without a sentence.
 */
export function pointToNoticeUpdate(locale: AppIntentLocale = "vi", title?: string): string {
  const notice = noticeNamed(locale, title);
  return locale === "en"
    ? `To install the update in ${notice}, press “Update” on the notice in the inbox. Nothing is installed until you do.`
    : `Để cài bản cập nhật trong ${notice}, bạn bấm “Cập nhật” ở thông báo trong hộp thư. Chưa có gì được cài cho đến khi bạn bấm.`;
}

/** The on-screen name of the profile an `orb.select` names; the refinements above guarantee there is one. */
function orbProfileLabel(intent: AppIntent): string {
  return ORB_PROFILE_LABELS[intent.orbProfile ?? "clark"];
}

/** The theme an `appearance.set-theme` names: its display name when the node filled one in, else its reference. */
function themeLabel(intent: AppIntent): string {
  return intent.themeName ?? intent.themeRef ?? "";
}

const COLOR_SCHEME_READ_BACK_VI: Record<ColorScheme, string> = {
  dark: "Tôi chuyển giao diện sang nền tối nhé.",
  light: "Tôi chuyển giao diện sang nền sáng nhé.",
  system: "Tôi cho giao diện sáng hay tối theo hệ thống nhé.",
};

const COLOR_SCHEME_READ_BACK_EN: Record<ColorScheme, string> = {
  dark: "Switching the appearance to dark.",
  light: "Switching the appearance to light.",
  system: "Letting the system decide between light and dark.",
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
    case "conversation.delete":
      return "Xoá hội thoại này cùng tệp đính kèm và tệp widget. Không thể Hoàn tác. Bộ nhớ đã lưu và tài nguyên dùng chung được giữ lại.";
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
      return `Tôi mở Settings ở tab ${SETTINGS_TAB_LABELS[intent.tab ?? "experience"].vi} nhé.`;
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
      return intent.inboxTarget === undefined ? "Tôi mở hộp thư nhé." : "Tôi mở hộp thư ở mục đó nhé.";
    case "inbox.ask":
      return "Tôi xem thông báo mới nhất rồi nói cho bạn nó nghĩa là gì nhé.";
    case "turn.stop":
      return "Tôi dừng câu trả lời đang chạy nhé; phần đã viết vẫn được giữ lại.";
    case "orb.select":
      return `Tôi đổi Orb sang kiểu ${orbProfileLabel(intent)} nhé.`;
    case "effect.confirmed":
      return "Tôi ghi nhận là việc đang chờ đã có hiệu lực nhé.";
    case "effect.failed":
      return "Tôi ghi nhận là việc đang chờ chưa có hiệu lực nhé.";
    case "notice.act":
      return describeNoticeAction(intent.noticeAction ?? "mark-read", "vi");
    case "appearance.set-theme":
      return themeLabel(intent) === ""
        ? "Tôi đổi chủ đề giao diện nhé."
        : `Tôi đổi giao diện sang chủ đề ${themeLabel(intent)} nhé.`;
    case "appearance.set-color-scheme":
      return COLOR_SCHEME_READ_BACK_VI[intent.colorScheme ?? "system"];
    case "appearance.reset":
      return "Tôi đưa giao diện về mặc định nhé: chủ đề Clark Default, sáng hay tối theo hệ thống.";
    case "appearance.open-theme-gallery":
      return "Tôi mở danh sách chủ đề giao diện nhé.";
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
    case "conversation.delete":
      return "Delete this conversation, its attachments and widget files. There is no Undo. Saved memory and shared resources are kept.";
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
      return `Opening Settings on the ${SETTINGS_TAB_LABELS[intent.tab ?? "experience"].en} tab.`;
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
      return intent.inboxTarget === undefined ? "Opening your inbox." : "Opening your inbox at that item.";
    case "inbox.ask":
      return "Looking at your latest notice and saying what it means.";
    case "turn.stop":
      return "Stopping the reply in progress; what it already wrote is kept.";
    case "orb.select":
      return `Switching the Orb to the ${orbProfileLabel(intent)} style.`;
    case "effect.confirmed":
      return "Recording that the waiting action took effect.";
    case "effect.failed":
      return "Recording that the waiting action did not take effect.";
    case "notice.act":
      return describeNoticeAction(intent.noticeAction ?? "mark-read", "en");
    case "appearance.set-theme":
      return themeLabel(intent) === ""
        ? "Changing the theme."
        : `Switching the appearance to the ${themeLabel(intent)} theme.`;
    case "appearance.set-color-scheme":
      return COLOR_SCHEME_READ_BACK_EN[intent.colorScheme ?? "system"];
    case "appearance.reset":
      return "Resetting the appearance: Clark Default, with light or dark following the system.";
    case "appearance.open-theme-gallery":
      return "Opening the list of themes.";
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
/** Names one agent-issued app-control action, so the page that ran it can say what happened to it. */
export const hostControlIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, { error: "must be a host-control id" });

export const appIntentDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("intent"),
    intent: appIntentSchema,
    requiresConfirmation: z.literal(false),
    readBack: z.string(),
    /**
     * Present only on a decision the agent issued through `control_app`. The page reports what its
     * executor did under this id (`POST /app-intents/host-control/:controlId`), which is what lets the
     * tool tell the model "done" or "failed" instead of "sent".
     */
    controlId: hostControlIdSchema.optional(),
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
    /** Carried so a click can name the orb profile an `orb.select` switches to. */
    orbProfile: orbProfileSchema.optional(),
    /** Carried so a request that already knows the notice can name it for `notice.act`; the node checks it is offered. */
    noticeId: z.string().min(1).max(128).optional(),
    noticeAction: noticeOperationIdSchema.optional(),
    /** Carried so a notification's click can open the inbox on what it was about. */
    inboxTarget: inboxTargetSchema.optional(),
    /** Carried so a click can name the theme an `appearance.set-theme` draws. The node fills in its name. */
    themeRef: themeRefSchema.optional(),
    /** Carried so a click can name the scheme an `appearance.set-color-scheme` switches to. */
    colorScheme: colorSchemeSchema.optional(),
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

/**
 * The request body for `POST /app-intents/host-control/:controlId`: what the page's one executor
 * (`runAppIntent`) did with an agent-issued decision. `say` is the read-back when it ran and the
 * reason when it did not, the same sentence the page shows.
 */
export const hostControlReportSchema = z.strictObject({
  ran: z.boolean(),
  say: z.string().max(2000),
});
export type HostControlReport = z.infer<typeof hostControlReportSchema>;

/** The audit document appended for every intent that was acted on. */
export const appIntentEventDocumentSchema = z.strictObject({
  kind: appIntentKindSchema,
  tab: settingsTabSchema.optional(),
  /** Recorded so the audit can answer *which* widget was shown, not only that the library opened. */
  definitionId: capabilityRefSchema.optional(),
  family: widgetFamilySchema.optional(),
  /** Recorded so the audit can answer which profile a `model.select` switched to. */
  modelAlias: modelAliasSchema.optional(),
  /** Recorded so the audit can answer which orb an `orb.select` switched to. */
  orbProfile: orbProfileSchema.optional(),
  /** Recorded so the audit can answer which effect a sentence was understood to answer. */
  effectId: z.string().min(1).max(128).optional(),
  /** Recorded so the audit can answer which notice was acted on, and how. */
  noticeId: z.string().min(1).max(128).optional(),
  noticeAction: noticeOperationIdSchema.optional(),
  /** Recorded so the audit can answer what a notification's click opened the inbox on. */
  inboxTarget: inboxTargetSchema.optional(),
  /** Recorded so the audit can answer which theme an `appearance.set-theme` drew. */
  themeRef: themeRefSchema.optional(),
  /** Recorded so the audit can answer which scheme an `appearance.set-color-scheme` chose. */
  colorScheme: colorSchemeSchema.optional(),
  source: appIntentSourceSchema,
  confirmed: z.boolean(),
});
export type AppIntentEventDocument = z.infer<typeof appIntentEventDocumentSchema>;
