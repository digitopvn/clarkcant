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
  APP_INTENT_NOT_UNDERSTOOD,
  SETTINGS_TABS,
  type AppIntent,
  type AppIntentDecision,
  type AppIntentEventDocument,
  type AppIntentKind,
  type AppIntentSource,
  type ConfirmationToken,
  type ConversationId,
  type Instant,
  type SettingsTab,
  describeAppIntent,
  intentRequiresConfirmation,
} from "@clarkcant/contracts";
import { type Database, appendEvent } from "@clarkcant/storage";

/**
 * Verbs a command to the application can open with.
 *
 * Only the first word is checked, so "thu nho" is covered by "thu". Kept to verbs that are about the
 * application itself; work verbs like "doc", "xem", "tom tat" or "them" are deliberately absent,
 * which is what keeps "xem cai dat cua may chu nay giup toi" a question - and also "them ghi chu vao
 * tai lieu", which is work somebody wants done rather than a command to the shell. Leaving "them" out
 * costs the phrasing "them tep dinh kem" and is worth it: refusing a real work request is a worse
 * failure than not recognising one way of saying "attach a file".
 */
const APP_COMMAND_VERBS: readonly string[] = [
  "mo",
  "dong",
  "thu",
  "phong",
  "ket",
  "thoat",
  "ve",
  "tat",
  "doi",
  "dinh",
  "chon",
  "dung",
  "chuyen",
  "huy",
  "khoi",
  "thuong",
  "hien",
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

/** A command is short. A long sentence that opens with a verb is prose, not a command. */
const APP_COMMAND_MAX_WORDS = 8;

/**
 * Phrase table, unaccented.
 *
 * Order does not matter: matching takes the longest phrase that appears, so "thu nho toi thieu"
 * cannot be stolen by the shorter "thu nho". Relying on table order for that would make the table's
 * meaning depend on where a line sits.
 */
const PHRASES: readonly { phrase: string; kind: AppIntentKind }[] = [
  // Ending the voice session.
  { phrase: "ket thuc phien thoai", kind: "voice.end" },
  { phrase: "ket thuc phien", kind: "voice.end" },
  { phrase: "dung phien thoai", kind: "voice.end" },
  { phrase: "tat phien thoai", kind: "voice.end" },
  { phrase: "dong phien thoai", kind: "voice.end" },
  { phrase: "end the voice", kind: "voice.end" },
  { phrase: "end voice", kind: "voice.end" },

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

  { phrase: "mo hop thoai chon tep", kind: "composer.attach" },
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
];

/** Words that name a Settings tab, longest first so "cong cu" is not read as "cong". */
const TAB_WORDS: readonly { words: readonly string[]; tab: SettingsTab }[] = [
  { words: ["general", "chung", "co ban"], tab: "general" },
  { words: ["models", "model"], tab: "models" },
  { words: ["tools", "tool", "cong cu"], tab: "tools" },
  { words: ["devices", "device", "thiet bi"], tab: "devices" },
];

/** Text that asks to change tabs. Present without a tab name, the request is refused rather than guessed. */
const TAB_INTENT_MARKERS: readonly string[] = [
  " tab ",
  "sang tab",
  "doi tab",
  "chuyen tab",
  "tab settings",
];

// Derived from the tabs that exist, so a tab added later is named in the refusal without anyone remembering to
// update a sentence. A refusal that listed a tab which is not there would send the person looking for it.
const TAB_REFUSAL = `Tôi chưa rõ bạn muốn mở tab nào. Các tab đang có: ${SETTINGS_TABS.join(", ")}.`;

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
  const normalised = normaliseIntentText(text);
  if (normalised === "") return false;
  const words = normalised.split(" ");
  if (words.length > APP_COMMAND_MAX_WORDS) return false;
  const first = words[0] ?? "";
  return APP_COMMAND_VERBS.includes(first);
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
export function matchAppIntent(text: string): AppIntentMatch | undefined {
  if (!isAppCommandShaped(text)) return undefined;
  const normalised = normaliseIntentText(text);

  // A tab change is checked before anything else: "mo cai dat tab cong cu" also contains "mo cai dat",
  // and the more specific request is the one the person meant.
  if (looksLikeTabRequest(normalised)) {
    const tab = findTab(normalised);
    if (tab === undefined) return { kind: "refused", say: TAB_REFUSAL };
    return { kind: "intent", intent: { kind: "settings.tab", tab } };
  }

  const matched = [...PHRASES].sort((a, b) => b.phrase.length - a.phrase.length).find((entry) => normalised.includes(entry.phrase));
  if (matched === undefined) return { kind: "refused", say: APP_INTENT_NOT_UNDERSTOOD };
  return { kind: "intent", intent: { kind: matched.kind } };
}

function decisionFor(intent: AppIntent, mintConfirmationToken: () => ConfirmationToken): AppIntentDecision {
  if (intentRequiresConfirmation(intent.kind)) {
    return {
      kind: "needs-confirmation",
      intent,
      readBack: describeAppIntent(intent),
      confirmationToken: mintConfirmationToken(),
    };
  }
  return { kind: "intent", intent, requiresConfirmation: false, readBack: describeAppIntent(intent) };
}

export type AppIntentResolution = AppIntentDecision | { kind: "none" };

/**
 * The one decision function.
 *
 * A click already knows what it wants (`intent`); a typed or spoken command has to be matched
 * (`text`). Both come out of here in the same shape, which is what stops the three sources from
 * growing three sets of rules.
 */
export function resolveAppIntent(input: {
  text?: string;
  intent?: AppIntent;
  mintConfirmationToken: () => ConfirmationToken;
}): AppIntentResolution {
  if (input.intent !== undefined) {
    return decisionFor(input.intent, input.mintConfirmationToken);
  }
  const match = matchAppIntent(input.text ?? "");
  if (match === undefined) return { kind: "none" };
  if (match.kind === "refused") return { kind: "refused", say: match.say };
  return decisionFor(match.intent, input.mintConfirmationToken);
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
