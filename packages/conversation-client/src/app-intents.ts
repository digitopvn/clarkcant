/**
 * Carrying out an application intent, in the page.
 *
 * ## One executor, three sources
 *
 * A click, a typed command and a spoken command all arrive here with the same decision, so the thing that
 * opens Settings is one function and not three. That is the property the whole registry exists to buy: if
 * clicking Settings and saying "open Settings" had separate implementations, they would drift, and the one
 * that drifted would be the one nobody was exercising.
 *
 * ## It cannot be asked to confirm
 *
 * `runAppIntent` takes no confirmation parameter and never asks a question. The only decision member it acts
 * on is `kind: "intent"`, which a node produces only after it has turned a single-use token into permission.
 * So there is no code path here that could quit the application because somebody said something that sounded
 * like a command - the permission has to have already been granted, by the node, on the record.
 *
 * ## What it does in a browser
 *
 * Window commands cannot work in a page, and the honest answer is to say so rather than to appear to work.
 * A host simply omits the methods it cannot provide, and the sentence that comes back names the limitation.
 * This is the difference between "nothing happened and I do not know why" and "this needs the desktop app".
 */

import {
  SLASH_COMMAND_INTENTS,
  type AppIntent,
  type AppIntentDecision,
  type AppIntentKind,
  type AppIntentResolution,
  type ColorScheme,
  type NoticeOperationId,
  type OrbProfileName,
  type SettingsTab,
  type TypedSlashCommand,
  describeAppIntent,
  intentRequiresConfirmation,
  isPersonOnlyAppIntent,
} from "@clarkcant/contracts";

import { readStoredLocale } from "./i18n/locale.ts";
import { CATALOGS } from "./i18n/messages.ts";

/**
 * What one host method did.
 *
 * Nothing, for the ordinary case where the read-back already says it. A sentence, when the host knows better than
 * the read-back what happened - a model switch says which profile it landed on. A promise of either, for the work
 * that has to ask the node first. A method that could not do it throws, and the error's message is the reason
 * given: the executor never reports as done something that failed on the way.
 */
export type HostEffect = void | string | Promise<void | string>;

/**
 * What a page can be asked to do.
 *
 * Everything but the window commands is ordinary interface state and is always present. The window commands are
 * optional because a browser genuinely cannot do them, and marking them optional is what makes the
 * `not-desktop` answer truthful instead of a lie about failing.
 */
export interface AppIntentHost {
  openSettings(tab?: SettingsTab): HostEffect;
  goHome(): HostEffect;
  deleteConversation?(conversationId: string, deletionPermit?: string): HostEffect;
  openFilePicker(): HostEffect;
  endVoice(): HostEffect;
  /**
   * Starts voice mode, ensuring a conversation exists first.
   *
   * Optional for the same reason the widget library is: a host that has not wired a voice surface
   * should be refused with a sentence, not reported as having opened one.
   */
  openVoice?(): HostEffect;
  /**
   * Closes Settings and the widget library and returns to the conversation already open, without
   * resetting or leaving it.
   *
   * Distinct from `goHome`, which leaves the session: `nav.conversation` is "close what is on top
   * of the conversation", and `goHome` is "leave the conversation". Optional is not meaningful here
   * — every host that has a conversation surface can dismiss its own overlays — but it is declared
   * alongside the other new members for the same reason: a host built before this existed should not
   * silently gain a method it never implemented.
   */
  showConversation?(): HostEffect;
  /**
   * Moves the configured model pool to the next enabled profile, applying to a new generation.
   *
   * Optional: a host with no model pool (e.g. a fixture with no node behind it) cannot promise this,
   * and a caller that reported success anyway would be lying about what changed.
   */
  cycleModel?(): HostEffect;
  /**
   * Opens the inbox over the conversation: what is waiting for the person, and the notices from work that ran
   * while nobody was looking. Optional: a host with no node behind it has no inbox to open.
   */
  openInbox?(target?: string): HostEffect;
  /**
   * Carries out one of a notice's own actions — mark read, dismiss or undo a dismissal, snooze, retry, update, skip a
   * version, ask again — through the node's notice-action route, the one the panel's buttons, MCP and both agents reach;
   * the node checks it against what the notice offers now. Installing an update reaches here only from the person: a
   * spoken request they confirmed (a typed one opens the inbox on the notice instead), never an agent's. Resolves to the
   * sentence saying what the node did; throws the reason when it did not. Optional for the reason `openInbox` is.
   */
  actOnNotice?(noticeId: string, action: NoticeOperationId): HostEffect;
  /**
   * Asks Clark about the newest notice in the inbox: the inbox's own "Ask Clark", reached by a sentence. Optional for
   * the reason `openInbox` is; a host that has an inbox but nothing in it refuses with a sentence saying so.
   */
  askAboutLatestNotice?(): HostEffect;
  /**
   * Records the person's answer about an effect whose outcome was unknown — the inbox's "It took effect" and "It did not
   * take effect", reached by a sentence. The node named the effect in the decision; this records it through the same
   * person-only route the buttons call. Optional for the reason `openInbox` is.
   */
  recordEffectOutcome?(effectId: string, outcome: "confirmed" | "failed"): HostEffect;
  /**
   * Stops the reply this conversation is writing, keeping what it has already written. Optional: a host with no
   * node behind it has no turn to stop.
   */
  stopTurn?(): HostEffect;
  /** Selects a configured model-pool profile by its alias. See `cycleModel` for why this is optional. */
  selectModel?(alias: string): HostEffect;
  /**
   * Changes the orb's style, through the same preference write the Settings control makes.
   *
   * Optional: a host with no node behind it has nowhere to store the choice, and an orb that changed on
   * screen without being saved would revert on the next reload — a success that was not one.
   */
  selectOrbProfile?(profile: OrbProfileName): HostEffect;
  /**
   * Chooses the theme the node resolved, through the same preference write the theme picker makes, and answers with
   * what is actually drawn - a theme the page refuses to draw is reported as refused, not as chosen.
   *
   * Optional for the reason `selectOrbProfile` is: a host with no node has nowhere to keep the choice.
   */
  setTheme?(themeRef: string, themeName: string | undefined): HostEffect;
  /** Chooses light, dark or system, through the same device-local write the Settings control makes. */
  setColorScheme?(scheme: ColorScheme): HostEffect;
  /** Puts the theme back to Clark Default and light or dark back to following the system. */
  resetAppearance?(): HostEffect;
  /** Opens the list of themes the person can choose from. */
  openThemeGallery?(): HostEffect;
  /**
   * Opens the widget library.
   *
   * Optional for the same reason the window methods are: a host that cannot show the library should
   * be refused with a sentence that names the limitation rather than reported as having done it.
   */
  openWidgetLibrary?(mode: "browse" | "develop", target?: { definitionId?: string; family?: string }): HostEffect;
  expandWindow?(): HostEffect;
  minimiseWindow?(): HostEffect;
  setFullScreen?(value: boolean): HostEffect;
  setMinimal?(compact: boolean): HostEffect;
  quit?(): HostEffect;
}

export interface AppIntentRun {
  /** Whether the host did anything. */
  ran: boolean;
  /** What to show or read out: the read-back when it ran, the reason when it did not. */
  say: string;
}

/**
 * Said when an intent is understood and the window it needs is not there.
 *
 * The Vietnamese default, since this module has no React tree to read `useT` from — `runAppIntent`
 * is called from a click, a typed command and a spoken command alike, some of them off the render
 * path entirely. `missingCapabilitySay` below resolves the actual UI language at call time instead,
 * from the same cached choice `useLocale` reads; this constant stays for callers (and this file's
 * own tests) that want the fixed, unlocalized wording.
 */
export const NOT_DESKTOP_SAY =
  "Lệnh này cần cửa sổ desktop. Trình duyệt không điều khiển được cửa sổ của hệ điều hành.";

/** Said when an intent is understood and this build has no widget library to open. */
export const NOT_LIBRARY_SAY =
  "Bản dựng này không mở được thư viện widget, nên tôi chưa làm gì cả.";

function missingCapabilitySay(intent: AppIntent): string {
  const catalog = CATALOGS[readStoredLocale()];
  switch (intent.kind) {
    case "widgets.open":
    case "widgets.show":
      return catalog["shell.intent.notLibrary"];
    case "voice.open":
      return catalog["shell.intent.notVoice"];
    case "model.cycle":
    case "model.select":
      return catalog["shell.intent.notModelPool"];
    case "conversation.delete":
      return catalog["shell.intent.notDelete"];
    case "nav.conversation":
      return catalog["shell.intent.notConversation"];
    case "inbox.open":
    case "inbox.ask":
    case "notice.act":
    case "effect.confirmed":
    case "effect.failed":
      return catalog["shell.intent.notInbox"];
    case "turn.stop":
      return catalog["shell.intent.notTurn"];
    case "orb.select":
      return catalog["shell.intent.notOrb"];
    case "appearance.set-theme":
    case "appearance.set-color-scheme":
    case "appearance.reset":
    case "appearance.open-theme-gallery":
      return catalog["shell.intent.notAppearance"];
    default:
      return catalog["shell.intent.notDesktop"];
  }
}

/** Said when a decision came back that is not executable: a question, or a refusal. */
function notExecutableSay(decision: AppIntentDecision): string {
  switch (decision.kind) {
    case "refused":
      return decision.say;
    case "needs-confirmation":
      return decision.readBack;
    case "intent":
      // Unreachable: this function is only called for the other two members.
      return describeAppIntent(decision.intent);
  }
}

function describeMissingOrbProfile(): string {
  return CATALOGS[readStoredLocale()]["shell.intent.orbProfileMissing"];
}

/** Exported for the test that proves every kind is answerable here. */
export function describeMissingCapability(intent: AppIntent): string {
  return missingCapabilitySay(intent);
}

/**
 * Carry out a decision, and say what became of it.
 *
 * Asynchronous because some intents are the node's to finish - a model switch is only done when the pool says so
 * - and "done" has to mean done: the agent's `control_app` reports this answer back to the model, so an executor
 * that resolved before the work did would let the model tell the person something that is not true yet.
 */
export async function runAppIntent(decision: AppIntentDecision, host: AppIntentHost): Promise<AppIntentRun> {
  if (decision.kind !== "intent") {
    // A question is answered by saying it; a refusal is answered by saying it. Neither is permission, and this
    // function cannot grant any.
    return { ran: false, say: notExecutableSay(decision) };
  }

  const intent = decision.intent;
  const readBack = decision.readBack === "" ? describeAppIntent(intent) : decision.readBack;

  // The node never issues one of these through `control_app`; a decision that carries an agent's id and names one
  // anyway did not come through it, and is refused rather than recorded as the person's answer.
  if (decision.controlId !== undefined && isPersonOnlyAppIntent(intent.kind)) {
    return { ran: false, say: CATALOGS[readStoredLocale()]["shell.intent.personOnly"] };
  }

  if (!hostHasCapability(host, intent)) {
    return { ran: false, say: missingCapabilitySay(intent) };
  }

  try {
    const said = await carryOut(intent, host);
    return { ran: true, say: typeof said === "string" && said !== "" ? said : readBack };
  } catch (cause) {
    return { ran: false, say: cause instanceof Error && cause.message !== "" ? cause.message : String(cause) };
  }
}

function carryOut(intent: AppIntent, host: AppIntentHost): HostEffect {
  switch (intent.kind) {
    case "conversation.delete":
      if (intent.conversationId === undefined) throw new Error(missingCapabilitySay(intent));
      return host.deleteConversation?.(intent.conversationId, intent.deletionPermit);
    case "settings.open":
      return host.openSettings();
    case "settings.tab":
      return host.openSettings(intent.tab);
    case "nav.home":
      return host.goHome();
    case "composer.attach":
      return host.openFilePicker();
    case "voice.end":
      return host.endVoice();
    case "voice.open":
      return host.openVoice?.();
    case "nav.conversation":
      return host.showConversation?.();
    case "inbox.open":
      return host.openInbox?.(intent.inboxTarget);
    case "inbox.ask":
      return host.askAboutLatestNotice?.();
    case "notice.act":
      // The node names the notice and the action before it decides; one without either did not come through it, and
      // is refused rather than carried out on whichever notice happens to be first.
      if (intent.noticeId === undefined || intent.noticeAction === undefined) {
        throw new Error(CATALOGS[readStoredLocale()]["shell.intent.noticeMissing"]);
      }
      return host.actOnNotice?.(intent.noticeId, intent.noticeAction);
    case "effect.confirmed":
    case "effect.failed":
      // The contract refuses one without an effect, so this is a decision that did not come through it: refused
      // rather than answered about whichever effect happens to be waiting.
      if (intent.effectId === undefined) throw new Error(CATALOGS[readStoredLocale()]["shell.intent.personOnly"]);
      return host.recordEffectOutcome?.(intent.effectId, intent.kind === "effect.confirmed" ? "confirmed" : "failed");
    case "turn.stop":
      return host.stopTurn?.();
    case "model.cycle":
      return host.cycleModel?.();
    case "model.select":
      return host.selectModel?.(intent.modelAlias ?? "");
    case "orb.select":
      // The contract refuses an `orb.select` without a profile, so this is a decision that did not come
      // through it. Refused rather than defaulted: switching to some orb nobody named is not what was asked.
      if (intent.orbProfile === undefined) throw new Error(describeMissingOrbProfile());
      return host.selectOrbProfile?.(intent.orbProfile);
    case "appearance.set-theme":
      // The contract refuses one without a theme; defaulting to some theme nobody named is not what was asked.
      if (intent.themeRef === undefined) throw new Error(CATALOGS[readStoredLocale()]["shell.intent.themeMissing"]);
      return host.setTheme?.(intent.themeRef, intent.themeName);
    case "appearance.set-color-scheme":
      if (intent.colorScheme === undefined) throw new Error(CATALOGS[readStoredLocale()]["shell.intent.themeMissing"]);
      return host.setColorScheme?.(intent.colorScheme);
    case "appearance.reset":
      return host.resetAppearance?.();
    case "appearance.open-theme-gallery":
      return host.openThemeGallery?.();
    case "window.expand":
      return host.expandWindow?.();
    case "window.minimise":
      return host.minimiseWindow?.();
    case "window.minimal":
      return host.setMinimal?.(true);
    case "window.fullscreen":
      return host.setFullScreen?.(true);
    case "window.windowed":
      return host.setFullScreen?.(false);
    case "app.quit":
      return host.quit?.();
    case "widgets.open":
      return host.openWidgetLibrary?.("browse");
    case "widgets.show":
      return host.openWidgetLibrary?.("browse", {
        ...(intent.definitionId === undefined ? {} : { definitionId: intent.definitionId }),
        ...(intent.family === undefined ? {} : { family: intent.family }),
      });
    default: {
      // Every kind above returns. This keeps a tenth kind from being silently ignored by the executor.
      const unreachable: never = intent.kind;
      throw new Error(`no executor for app intent ${String(unreachable)}`);
    }
  }
}

function hostHasCapability(host: AppIntentHost, intent: AppIntent): boolean {
  switch (intent.kind) {
    case "conversation.delete":
      return host.deleteConversation !== undefined;
    case "window.expand":
      return host.expandWindow !== undefined;
    case "window.minimise":
      return host.minimiseWindow !== undefined;
    case "window.minimal":
      return host.setMinimal !== undefined;
    case "window.fullscreen":
    case "window.windowed":
      return host.setFullScreen !== undefined;
    case "app.quit":
      return host.quit !== undefined;
    case "widgets.open":
    case "widgets.show":
      return host.openWidgetLibrary !== undefined;
    case "voice.open":
      return host.openVoice !== undefined;
    case "nav.conversation":
      return host.showConversation !== undefined;
    case "inbox.open":
      return host.openInbox !== undefined;
    case "inbox.ask":
      return host.askAboutLatestNotice !== undefined;
    case "notice.act":
      return host.actOnNotice !== undefined;
    case "effect.confirmed":
    case "effect.failed":
      return host.recordEffectOutcome !== undefined;
    case "turn.stop":
      return host.stopTurn !== undefined;
    case "model.cycle":
      return host.cycleModel !== undefined;
    case "model.select":
      return host.selectModel !== undefined;
    case "orb.select":
      return host.selectOrbProfile !== undefined;
    case "appearance.set-theme":
      return host.setTheme !== undefined;
    case "appearance.set-color-scheme":
      return host.setColorScheme !== undefined;
    case "appearance.reset":
      return host.resetAppearance !== undefined;
    case "appearance.open-theme-gallery":
      return host.openThemeGallery !== undefined;
    default:
      return true;
  }
}

/**
 * The intents the page carries out the moment they are asked for, before the node has answered.
 *
 * Only going home, for now - the logo, and `/new` typed while a reply is being written: the node never refuses
 * `nav.home` and never asks to confirm it, and leaving the conversation changes only what the page shows - the
 * conversation stays in the node's history, and a reply still being written there goes on. Waiting for the answer
 * instead left a window in which the composer still belonged to the conversation being left: a message sent in it was
 * checked only as a command there, and the restart that landed after it emptied the composer, so the text was lost
 * without a word.
 *
 * An intent the node may ask the person to confirm can never be one of these, whatever is listed here: carrying it out
 * before the node has decided would skip the question (`runsAtOnce`).
 */
export const INTENTS_RUN_AT_ONCE: ReadonlySet<AppIntentKind> = new Set<AppIntentKind>(["nav.home"]);

/** Whether `kind` is carried out before the node has answered: listed above, and never one that needs confirming. */
export function runsAtOnce(kind: AppIntentKind): boolean {
  return INTENTS_RUN_AT_ONCE.has(kind) && !intentRequiresConfirmation(kind);
}

/**
 * The intent a typed command is carried out as before the node answers, if it is one: `/new` is the logo.
 *
 * Read from `SLASH_COMMAND_INTENTS`, the same copy the node resolves a typed command through, so the page never goes
 * home at once on a command the node would read differently. Any other command is decided by the node first.
 *
 * A sentence that means the same thing ("start a new conversation") is not read here: only the node knows what a
 * sentence means, and a second reading in the page would be a classifier that drifts from it. So typed as a sentence
 * during a reply, going home waits for the node's answer, and text typed into the composer before that answer lands
 * is cleared with the restart, as the logo clears it. Accepted: `/new` and the logo are the immediate ways.
 */
export function typedCommandRunAtOnce(typed: TypedSlashCommand | undefined): AppIntentKind | undefined {
  const kind = typed === undefined ? undefined : SLASH_COMMAND_INTENTS[typed.command];
  return kind !== undefined && runsAtOnce(kind) ? kind : undefined;
}

export interface RunAtOnceDeps {
  /** Tells the node; its answer is its record of what the page already did. */
  ask: () => Promise<AppIntentResolution>;
  /** The one executor, through the page's own `runIntent`. */
  run: (decision: AppIntentDecision) => void;
  /** The node's answer naming the same intent, for a caller that says its read-back (`/new` during a reply). */
  onRecorded?: (decision: Extract<AppIntentDecision, { kind: "intent" }>) => void;
  /**
   * The node could not be told, so its read-back will not come: the caller says what was kept in its place, from what
   * the page itself knows (`intents.newConversationKept`).
   */
  onUnrecorded?: () => void;
}

/**
 * Carries out an intent in `INTENTS_RUN_AT_ONCE` now and tells the node at the same time, so typing that follows it
 * lands in the new state. One path for the logo and for `/new`.
 *
 * The node's answer is not carried out a second time when it names the same intent, which is what it does: that would
 * restart again and empty a composer the person has started typing in. Any other answer should not happen (the node
 * resolves a named `nav.home` and never asks to confirm it); were one to come, the page has already done what was asked
 * and saying "refused" over the start screen would contradict what is on it, so it is left as a trace for whoever
 * debugs the node. A request that failed is traced too, and `onUnrecorded` lets the caller say what the node's
 * read-back would have said: the conversation left behind is kept, and `/sessions` reopens it.
 */
export function runAppIntentAtOnce(kind: AppIntentKind, deps: RunAtOnceDeps): Promise<void> {
  deps.run({ kind: "intent", intent: { kind }, requiresConfirmation: false, readBack: "" });
  return deps.ask().then(
    (decision) => {
      if (decision.kind === "intent" && decision.intent.kind === kind) {
        deps.onRecorded?.(decision);
        return;
      }
      console.warn(`the node answered "${decision.kind}" for the ${kind} the page already carried out; the screen is left as it is`);
    },
    (cause: unknown) => {
      console.warn(`the ${kind} the page carried out could not be recorded by the node`, cause);
      deps.onUnrecorded?.();
    },
  );
}

export interface ClickAppIntentDeps {
  /** Asks the node what the click means; for a click run at once, the node's record of it. */
  ask: () => Promise<AppIntentResolution>;
  /** The one executor, through the page's own `runIntent`. */
  run: (decision: AppIntentDecision) => void;
  /** The node could not be asked, so a click that waits for it did nothing. */
  onLookupFailed: () => void;
  /** The node could not be told about a click already carried out (`RunAtOnceDeps.onUnrecorded`). */
  onUnrecorded?: () => void;
}

/**
 * A click on one of the page's own controls, decided by the node and carried out by the one executor.
 *
 * A click that `runsAtOnce` goes through `runAppIntentAtOnce`. Every other click waits for the node's decision.
 */
export function clickAppIntent(kind: AppIntentKind, deps: ClickAppIntentDeps): Promise<void> {
  if (runsAtOnce(kind)) return runAppIntentAtOnce(kind, deps);
  return deps.ask().then(
    (decision) => {
      if (decision.kind !== "none") deps.run(decision);
    },
    () => deps.onLookupFailed(),
  );
}
