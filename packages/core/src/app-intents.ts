/**
 * Matching what a person said or typed to an application intent.
 *
 * ## Two rules, and why they are the whole design
 *
 * A sentence that is *shaped like a command to the application* and matches nothing is answered with
 * "I did not understand that" and **nothing happens** - it is not handed to the agent, because the
 * person asked the application to do something and letting a model improvise a guess at what they
 * meant is how a control channel becomes unpredictable.
 *
 * Every other sentence is not the registry's business. "How do I look at the settings of this host"
 * mentions settings and is a work request; it goes to the agent exactly as before. The test for this
 * distinction is `isAppCommandShaped`, it lives here, and both directions are tested - a registry
 * that quietly swallows real questions would be worse than no registry at all.
 *
 * ## Why it is a table and not a model call
 *
 * This decides whether something happens to the window the person is looking at. A provider that can
 * paraphrase its way to a different answer on a different day is not something anyone can reason
 * about, so matching is a deterministic lookup with no model in the path.
 *
 * ## Why accents are stripped instead of listed twice
 *
 * Speech transcription is inconsistent about tone marks, so every phrase would otherwise need an
 * accented and an unaccented spelling. Normalising both the sentence and the table removes the
 * duplicate: one entry matches what a person types and what a transcriber hands back.
 */

import {
  SETTINGS_TABS,
  type AppIntent,
  type AppIntentDecision,
  type AppIntentEventDocument,
  type AppIntentKind,
  type AppIntentLocale,
  type AppIntentSource,
  type ConfirmationToken,
  type ConversationId,
  type Instant,
  type SettingsTab,
  appIntentNotUnderstood,
  describeAppIntent,
  intentRequiresConfirmation,
} from "@clarkcant/contracts";
import { type Database, appendEvent } from "@clarkcant/storage";

/**
 * Verbs a command to the application can open with, written **with** their tone marks.
 *
 * The tone marks are the point. Matching strips them so a transcriber that drops them still lands, but that same
 * stripping makes different words identical: "thu" (thu nhỏ, minimise) and "thủ" (thủ đô, capital) are one string
 * without marks, and a one-word test on the bare form turned "Thủ đô là Paris." into a refused command. So the
 * shape test reads the marks and the phrase table does not.
 *
 * Work verbs - đọc, xem, tóm tắt, thêm - are deliberately absent, and so is "về", which is a preposition as often as
 * it is a command: a sentence may begin with "Về việc đó thì..." and asking the agent about something must not be
 * refused. "về nhà" still works, through its own opener.
 */
const CONTROL_VERBS: readonly string[] = [
  "mở",
  "đóng",
  "thu",
  "phóng",
  "kéo",
  "kết",
  "thoát",
  "tắt",
  "đổi",
  "chuyển",
  "hiện",
  "khôi",
  "huỷ",
  "hủy",
  "dừng",
  "đính",
  "open",
  "close",
  "quit",
  "exit",
  "end",
  "go",
  "expand",
  "minimise",
  "minimize",
  "attach",
  "switch",
  "show",
  "hide",
  "minimal",
];

/**
 * The application's own furniture.
 *
 * A control verb on its own is not enough to call a sentence a command: "mở tài liệu giúp tôi" opens with mở and is
 * a work request. Requiring the sentence to be about one of these is what tells "mở cửa sổ trời" - a command the
 * registry does not know, which must be refused rather than guessed at - from a real request for work.
 *
 * "tệp" is deliberately not here: "mở tệp này giúp tôi" is work.
 *
 * "widget" is here because the library is the application's own furniture: "hiện widget lịch" and
 * "show the calendar widget" name something the shell owns, and without this noun neither sentence
 * could be shaped at all. The cost is that an unknown widget sentence is refused rather than handed
 * to the agent, which is the same trade the rest of this table already makes: a sentence shaped like
 * a command to the shell is never guessed at.
 */
const APP_NOUNS: readonly string[] = [
  "cua so",
  "window",
  "settings",
  "cai dat",
  "tab",
  "ung dung",
  "app",
  "phien thoai",
  "thanh voice",
  "man hinh",
  "trang chu",
  "widget",
];

/** A command is short. A long sentence that opens with a verb is prose, not a command. */
const APP_COMMAND_MAX_WORDS = 8;

/**
 * Phrase table, unaccented.
 *
 * Order does not matter: matching takes the longest phrase that appears, so "thu nho toi thieu"
 * cannot be stolen by the shorter "thu nho". Relying on table order for that would make the table's
 * meaning depend on where a line sits.
 */
const PHRASES: readonly { phrase: string; kind: AppIntentKind; wholeSentence?: true; opener?: string }[] = [
  // Ending the voice session.
  { phrase: "ket thuc phien thoai", kind: "voice.end" },
  { phrase: "ket thuc phien", kind: "voice.end" },
  { phrase: "dung phien thoai", kind: "voice.end" },
  { phrase: "tat phien thoai", kind: "voice.end" },
  { phrase: "dong phien thoai", kind: "voice.end" },
  { phrase: "end the voice", kind: "voice.end" },
  { phrase: "end voice", kind: "voice.end" },

  // Starting one.
  { phrase: "mo phien thoai", kind: "voice.open" },
  { phrase: "bat dau phien thoai", kind: "voice.open" },
  { phrase: "start voice", kind: "voice.open" },
  { phrase: "start the voice", kind: "voice.open" },

  // Back to the conversation already open, without leaving it - distinct from nav.home below.
  { phrase: "ve cuoc tro chuyen", kind: "nav.conversation" },
  { phrase: "quay lai cuoc tro chuyen", kind: "nav.conversation" },
  { phrase: "dong lai xem tro chuyen", kind: "nav.conversation" },
  { phrase: "back to the conversation", kind: "nav.conversation" },
  { phrase: "back to conversation", kind: "nav.conversation" },

  // The configured model pool's hotkey, spoken.
  { phrase: "chuyen sang model tiep theo", kind: "model.cycle" },
  { phrase: "doi sang model khac", kind: "model.cycle" },
  { phrase: "switch to the next model", kind: "model.cycle" },
  { phrase: "cycle the model", kind: "model.cycle" },

  // The window.
  { phrase: "mo rong cua so", kind: "window.expand" },
  { phrase: "phong to cua so", kind: "window.expand" },
  { phrase: "expand the window", kind: "window.expand" },
  { phrase: "hien lai cua so", kind: "window.expand" },

  { phrase: "thu nho xuong thanh tac vu", kind: "window.minimise" },
  { phrase: "thu nho cua so xuong", kind: "window.minimise" },
  { phrase: "thu nho cua so", kind: "window.minimise" },
  { phrase: "thu nho xuong", kind: "window.minimise" },
  { phrase: "minimise the window", kind: "window.minimise" },
  { phrase: "minimize the window", kind: "window.minimise" },

  { phrase: "thu nho toi thieu", kind: "window.minimal" },
  { phrase: "thu ve thanh voice", kind: "window.minimal" },
  { phrase: "thu gon ve thanh voice", kind: "window.minimal" },
  { phrase: "thanh voice toi gian", kind: "window.minimal" },
  { phrase: "minimal bar", kind: "window.minimal" },
  { phrase: "shrink to the voice bar", kind: "window.minimal" },
  { phrase: "collapse to the voice bar", kind: "window.minimal" },

  // Settings, navigation, files.
  { phrase: "mo phan cai dat", kind: "settings.open" },
  { phrase: "mo bang cai dat", kind: "settings.open" },
  { phrase: "mo cai dat", kind: "settings.open" },
  { phrase: "mo settings", kind: "settings.open" },
  { phrase: "open settings", kind: "settings.open" },

  { phrase: "ve man hinh bat dau", kind: "nav.home" },
  { phrase: "ve trang chu", kind: "nav.home" },
  { phrase: "ve nha", kind: "nav.home" },
  { phrase: "go back home", kind: "nav.home" },
  { phrase: "go home", kind: "nav.home" },

  // Its opener is three words: "mở hộp" alone also opens "mở hộp thư email của tôi", a request for the
  // agent, and see the note on COMMAND_OPENERS for what a too-broad opener does to such a sentence.
  { phrase: "mo hop thoai chon tep", kind: "composer.attach", opener: "mo hop thoai" },
  { phrase: "chon tep dinh kem", kind: "composer.attach" },
  { phrase: "dinh kem tep", kind: "composer.attach" },
  { phrase: "attach a file", kind: "composer.attach" },
  { phrase: "attach file", kind: "composer.attach" },

  { phrase: "thoat ung dung", kind: "app.quit" },
  { phrase: "thoat app", kind: "app.quit" },
  { phrase: "dong ung dung", kind: "app.quit" },
  { phrase: "dong app", kind: "app.quit" },
  { phrase: "quit the app", kind: "app.quit" },
  { phrase: "quit app", kind: "app.quit" },
  { phrase: "exit the app", kind: "app.quit" },

  // The widget library. Opening the catalogue is one request; naming a widget in it is another.
  //
  // These phrases shape through the control-verb-plus-noun rule rather than through the opener rule:
  // see the note on COMMAND_OPENERS. "thư viện widget" is deliberately absent, because without an
  // opening verb it is not command-shaped and a phrase that can never be reached is a lie in a table.
  { phrase: "mo thu vien widget", kind: "widgets.open" },
  { phrase: "widget library", kind: "widgets.open" },
  { phrase: "widget gallery", kind: "widgets.open" },
  { phrase: "hien widget", kind: "widgets.show" },
  { phrase: "show widget", kind: "widgets.show" },

  // The inbox. Whole-sentence only - see WHOLE_SENTENCE_POLITE. "hộp thư" and "inbox" are not app nouns,
  // because a person also has an email inbox: "open my gmail inbox" and "mở hộp thư email" are requests for
  // work, and a noun here would have made them command-shaped and then refused. Only the bare request,
  // said as the whole sentence, means this application's inbox.
  { phrase: "mo hop thu", kind: "inbox.open", wholeSentence: true },
  { phrase: "xem hop thu", kind: "inbox.open", wholeSentence: true },
  { phrase: "mo thong bao", kind: "inbox.open", wholeSentence: true },
  { phrase: "xem thong bao", kind: "inbox.open", wholeSentence: true },
  { phrase: "open inbox", kind: "inbox.open", wholeSentence: true },
  { phrase: "open the inbox", kind: "inbox.open", wholeSentence: true },
  { phrase: "open my inbox", kind: "inbox.open", wholeSentence: true },
  { phrase: "show inbox", kind: "inbox.open", wholeSentence: true },
  { phrase: "show my inbox", kind: "inbox.open", wholeSentence: true },
  { phrase: "open notifications", kind: "inbox.open", wholeSentence: true },
  { phrase: "show notifications", kind: "inbox.open", wholeSentence: true },
  // Closing it is going back to the conversation, which is what closing any surface over it already means.
  { phrase: "dong hop thu", kind: "nav.conversation", wholeSentence: true },
  { phrase: "close the inbox", kind: "nav.conversation", wholeSentence: true },
  { phrase: "close inbox", kind: "nav.conversation", wholeSentence: true },
];

/**
 * Courtesy a whole-sentence command may end with, in the bare spelling.
 *
 * A whole-sentence phrase is recognised only when it is the entire request, so "mở hộp thư" opens the inbox and
 * "mở hộp thư email của tôi" goes to the agent. These endings are the ones that do not change what was asked.
 */
const WHOLE_SENTENCE_POLITE: readonly string[] = [" giup toi", " cho toi", " cua toi", " di", " nhe", " nha", " please", " for me"];

/** The request with punctuation and courtesy trimmed off its end, for comparing against a whole-sentence phrase. */
function wholeSentenceOf(bare: string): string {
  let sentence = bare.replace(/[.!?,;:]+$/g, "").trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const ending of WHOLE_SENTENCE_POLITE) {
      if (sentence.endsWith(ending)) {
        sentence = sentence.slice(0, -ending.length).trim();
        changed = true;
      }
    }
  }
  return sentence;
}

function wholeSentenceMatch(bare: string): { phrase: string; kind: AppIntentKind } | undefined {
  const sentence = wholeSentenceOf(bare);
  return PHRASES.find((entry) => entry.wholeSentence === true && entry.phrase === sentence);
}

/** Words that name a Settings tab, longest first so "cong cu" is not read as "cong". */
const TAB_WORDS: readonly { words: readonly string[]; tab: SettingsTab }[] = [
  { words: ["experience", "trai nghiem"], tab: "experience" },
  { words: ["ai", "model", "models", "dinh tuyen"], tab: "ai" },
  { words: ["control", "kiem soat"], tab: "control" },
  // "cong cu" moved here with the tab: Extensions & Widgets is where the capability list now lives, and a word
  // that still pointed at a tab named Tools would send somebody to a screen that no longer exists.
  { words: ["extensions", "extension", "tien ich", "cong cu"], tab: "extensions" },
  { words: ["devices", "device", "thiet bi"], tab: "devices" },
  { words: ["memory", "ghi nho"], tab: "memory" },
  { words: ["developer", "nha phat trien"], tab: "developer" },
];

/** Text that asks to change tabs. Present without a tab name, the request is refused rather than guessed. */
const TAB_INTENT_MARKERS: readonly string[] = [
  " tab ",
  "sang tab",
  "doi tab",
  "chuyen tab",
  "tab settings",
];

/**
 * The two words a known command opens with, in the bare spelling, plus the ways a tab change can open.
 *
 * Derived from the table rather than listed again, so a phrase added below cannot be one the shape test then refuses
 * to look at. Two words rather than one is what keeps "thủ đô" out while letting "thu nhỏ" in.
 *
 * The widget phrases are excluded on purpose, and the reason is a regression this derivation caused once.
 * A phrase's first two words become an opener that the shape test accepts for *any* sentence starting with
 * them, so "thu vien widget" contributed the opener "thu vien" and "mo thu vien widget" contributed "mo thu".
 * After that, "thư viện ảnh" and "mở thư viện ảnh" - requests for work, not commands to the shell - were
 * command-shaped, matched no phrase, and were refused with "tôi chưa hiểu câu lệnh đó" instead of reaching
 * the agent. The gallery journey in apps/web/e2e/widget.spec.ts caught it.
 *
 * A phrase whose first two words are too common to claim declares a longer `opener` instead: "mo hop" from
 * "mo hop thoai chon tep" made "mở hộp thư email của tôi" command-shaped in the same way.
 *
 * Excluding them costs nothing: the widget sentences are shaped by the control-verb-plus-noun rule, because
 * "widget" is in APP_NOUNS and "mở"/"hiện"/"show" are in CONTROL_VERBS. Deriving openers only from phrases
 * whose first two words are genuinely command-like is the property that matters here.
 */
const COMMAND_OPENERS: readonly string[] = [
  ...new Set(
    PHRASES.filter(
      (entry) => entry.kind !== "widgets.open" && entry.kind !== "widgets.show" && entry.wholeSentence !== true,
    ).map(
      (entry) => entry.opener ?? entry.phrase.split(" ").slice(0, 2).join(" "),
    ),
  ),
  "mo tab",
  "doi sang",
  "chuyen sang",
  "doi tab",
  "chuyen tab",
  "switch to",
  "sang tab",
];

/** Whether a phrase appears as whole words. "tab" must not be found inside another word. */
function containsPhrase(words: readonly string[], phrase: string): boolean {
  const parts = phrase.split(" ");
  return words.some((_, start) => parts.every((part, offset) => words[start + offset] === part));
}

// Derived from the tabs that exist, so a tab added later is named in the refusal without anyone remembering to
// update a sentence. A refusal that listed a tab which is not there would send the person looking for it.
const TAB_REFUSAL_VI = `Tôi chưa rõ bạn muốn mở tab nào. Các tab đang có: ${SETTINGS_TABS.join(", ")}.`;
const TAB_REFUSAL_EN = `I am not sure which tab you want to open. The tabs available are: ${SETTINGS_TABS.join(", ")}.`;

function tabRefusal(locale: AppIntentLocale): string {
  return locale === "en" ? TAB_REFUSAL_EN : TAB_REFUSAL_VI;
}

/**
 * Lowercase, strip tone marks, collapse whitespace.
 *
 * `đ` is not a combining mark, so it survives NFD and needs its own replacement.
 */
export function normaliseIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a sentence is shaped like a command to the application.
 *
 * Opening verb plus a word limit. The limit is what separates "mo cai dat" from a paragraph that
 * happens to start with "mo", and the verb list is what separates a command from a question about
 * the application's settings.
 */
export function isAppCommandShaped(text: string): boolean {
  const spoken = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (spoken === "") return false;
  const spokenWords = spoken.split(" ");
  if (spokenWords.length > APP_COMMAND_MAX_WORDS) return false;

  const bare = normaliseIntentText(text);
  // 0. It is, in its entirety, one of the phrases that only count as a command when said on their own.
  if (wholeSentenceMatch(bare) !== undefined) return true;

  // 1. It opens the way a known command opens. Compared without tone marks, so a transcription that dropped them
  // still lands here, and two words long, so an ordinary word that happens to share a bare spelling does not.
  if (COMMAND_OPENERS.some((opener) => bare === opener || bare.startsWith(`${opener} `))) return true;

  // 2. It opens with a control verb *and* is about the application's own furniture. Both halves are load-bearing:
  // the verb alone refuses "mở tài liệu giúp tôi", and the noun alone would catch every question that mentions
  // Settings. The verb is read with its tone marks because without them it is a different word.
  const first = spokenWords[0] ?? "";
  return CONTROL_VERBS.includes(first) && APP_NOUNS.some((noun) => containsPhrase(bare.split(" "), noun));
}

export type AppIntentMatch =
  | { kind: "intent"; intent: AppIntent }
  | { kind: "refused"; say: string };

function findTab(normalised: string): SettingsTab | undefined {
  // Only look after the word "tab" when it is there, so "mo settings cua model nay" is not read as a
  // request to switch to the models tab.
  const marker = normalised.indexOf(" tab ");
  const haystack = marker === -1 ? normalised : normalised.slice(marker + 1);
  for (const entry of TAB_WORDS) {
    for (const word of entry.words) {
      if (haystack.includes(word)) return entry.tab;
    }
  }
  return undefined;
}

function looksLikeTabRequest(normalised: string): boolean {
  const padded = ` ${normalised} `;
  return TAB_INTENT_MARKERS.some((marker) => padded.includes(marker)) || normalised.startsWith("tab ");
}

/**
 * Match a sentence.
 *
 * `undefined` means "this is not the registry's business" and the caller continues as before.
 * `refused` means "this was shaped like a command and I will not guess" and the caller answers
 * without acting and without an agent turn.
 */
/**
 * A widget a spoken or typed command can name.
 *
 * The runtime builds this table from the canonical catalogue and injects it here, rather than
 * `core` importing the catalogue: `packs/data-canvas/sample.ts` imports `@clarkcant/core`, so the
 * other direction would be a dependency cycle, and this keeps the matcher free of any knowledge of
 * which widgets exist while still resolving them deterministically.
 */
export interface WidgetTarget {
  phrase: string;
  definitionId?: string;
  family?: string;
}

function findWidgetTarget(bare: string, targets: readonly WidgetTarget[]): WidgetTarget | undefined {
  const words = bare.split(" ");
  // Longest phrase first, so "thư viện ảnh" is not stolen by a shorter "ảnh".
  const sorted = [...targets].sort((a, b) => b.phrase.length - a.phrase.length);
  for (const target of sorted) {
    if (containsPhrase(words, normaliseIntentText(target.phrase))) return target;
  }
  return undefined;
}

export function matchAppIntent(
  text: string,
  options?: { widgetTargets?: readonly WidgetTarget[]; locale?: AppIntentLocale },
): AppIntentMatch | undefined {
  if (!isAppCommandShaped(text)) return undefined;
  const normalised = normaliseIntentText(text);
  const locale = options?.locale ?? "vi";

  // A tab change is checked before anything else: "mo cai dat tab cong cu" also contains "mo cai dat",
  // and the more specific request is the one the person meant.
  if (looksLikeTabRequest(normalised)) {
    const tab = findTab(normalised);
    if (tab === undefined) return { kind: "refused", say: tabRefusal(locale) };
    return { kind: "intent", intent: { kind: "settings.tab", tab } };
  }

  // A widget sentence is resolved against the catalogue before the phrase table, because which
  // widget was named is more specific than the fact that the sentence is about widgets at all.
  if (containsPhrase(normalised.split(" "), "widget")) {
    const target = findWidgetTarget(normalised, options?.widgetTargets ?? []);
    if (target !== undefined) {
      return {
        kind: "intent",
        intent: {
          kind: "widgets.show",
          ...(target.definitionId === undefined ? {} : { definitionId: target.definitionId }),
          ...(target.family === undefined ? {} : { family: target.family }),
        },
      };
    }
  }

  const whole = wholeSentenceMatch(normalised);
  if (whole !== undefined) return { kind: "intent", intent: { kind: whole.kind } };

  const matched = [...PHRASES]
    .filter((entry) => entry.wholeSentence !== true)
    .sort((a, b) => b.phrase.length - a.phrase.length)
    .find((entry) => normalised.includes(entry.phrase));
  if (matched === undefined) return { kind: "refused", say: appIntentNotUnderstood(locale) };
  return { kind: "intent", intent: { kind: matched.kind } };
}

function decisionFor(
  intent: AppIntent,
  mintConfirmationToken: () => ConfirmationToken,
  locale: AppIntentLocale,
): AppIntentDecision {
  if (intentRequiresConfirmation(intent.kind)) {
    return {
      kind: "needs-confirmation",
      intent,
      readBack: describeAppIntent(intent, locale),
      confirmationToken: mintConfirmationToken(),
    };
  }
  return { kind: "intent", intent, requiresConfirmation: false, readBack: describeAppIntent(intent, locale) };
}

export type AppIntentResolution = AppIntentDecision | { kind: "none" };

/**
 * The one decision function.
 *
 * A click already knows what it wants (`intent`); a typed or spoken command has to be matched
 * (`text`). Both come out of here in the same shape, which is what stops the three sources from
 * growing three sets of rules.
 *
 * `locale` defaults to Vietnamese, the product's own language, so an existing caller that has not
 * been touched to pass one keeps getting exactly the sentences it got before.
 */
export function resolveAppIntent(input: {
  text?: string;
  intent?: AppIntent;
  mintConfirmationToken: () => ConfirmationToken;
  widgetTargets?: readonly WidgetTarget[];
  locale?: AppIntentLocale;
}): AppIntentResolution {
  const locale = input.locale ?? "vi";
  if (input.intent !== undefined) {
    return decisionFor(input.intent, input.mintConfirmationToken, locale);
  }
  const match = matchAppIntent(input.text ?? "", {
    ...(input.widgetTargets === undefined ? {} : { widgetTargets: input.widgetTargets }),
    locale,
  });
  if (match === undefined) return { kind: "none" };
  if (match.kind === "refused") return { kind: "refused", say: match.say };
  return decisionFor(match.intent, input.mintConfirmationToken, locale);
}

export interface AppIntentAuditDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
}

/**
 * Record that an intent was acted on.
 *
 * One event kind for all three sources, carrying `source`, `kind` and `confirmed` - so "was this
 * clicked or heard" is answerable from the log alone. The sentence itself is not stored: the audit
 * needs to know what was done, not to keep a recording of what someone said.
 */
export function recordAppIntentEvent(
  deps: AppIntentAuditDeps,
  input: {
    intent: AppIntent;
    source: AppIntentSource;
    confirmed: boolean;
    conversationId?: ConversationId;
  },
): number {
  const document: AppIntentEventDocument = {
    kind: input.intent.kind,
    ...(input.intent.tab === undefined ? {} : { tab: input.intent.tab }),
    // Recorded so the audit can answer which widget was shown, not only that the library opened.
    ...(input.intent.definitionId === undefined ? {} : { definitionId: input.intent.definitionId }),
    ...(input.intent.family === undefined ? {} : { family: input.intent.family }),
    ...(input.intent.modelAlias === undefined ? {} : { modelAlias: input.intent.modelAlias }),
    source: input.source,
    confirmed: input.confirmed,
  };
  return appendEvent(deps.db, {
    eventId: deps.newId("evt"),
    kind: "app.intent",
    stream: "app.intent",
    nodeId: deps.nodeId,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    document,
    occurredAt: deps.now(),
  });
}
