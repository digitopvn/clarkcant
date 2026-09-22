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
  type AppIntent,
  type AppIntentDecision,
  type SettingsTab,
  describeAppIntent,
} from "@clarkcant/contracts";

/**
 * What a page can be asked to do.
 *
 * Everything but the window commands is ordinary interface state and is always present. The window commands are
 * optional because a browser genuinely cannot do them, and marking them optional is what makes the
 * `not-desktop` answer truthful instead of a lie about failing.
 */
export interface AppIntentHost {
  openSettings(tab?: SettingsTab): void;
  goHome(): void;
  openFilePicker(): void;
  endVoice(): void;
  /**
   * Opens the widget library.
   *
   * Optional for the same reason the window methods are: a host that cannot show the library should
   * be refused with a sentence that names the limitation rather than reported as having done it.
   */
  openWidgetLibrary?(mode: "browse" | "develop", target?: { definitionId?: string; family?: string }): void;
  expandWindow?(): void;
  minimiseWindow?(): void;
  setMinimal?(compact: boolean): void;
  quit?(): void;
}

export interface AppIntentRun {
  /** Whether the host did anything. */
  ran: boolean;
  /** What to show or read out: the read-back when it ran, the reason when it did not. */
  say: string;
}

/** Said when an intent is understood and the window it needs is not there. */
export const NOT_DESKTOP_SAY =
  "Lệnh này cần cửa sổ desktop. Trình duyệt không điều khiển được cửa sổ của hệ điều hành.";

/** Said when an intent is understood and this build has no widget library to open. */
export const NOT_LIBRARY_SAY =
  "Bản dựng này không mở được thư viện widget, nên tôi chưa làm gì cả.";

function missingCapabilitySay(intent: AppIntent): string {
  return intent.kind === "widgets.open" || intent.kind === "widgets.show"
    ? NOT_LIBRARY_SAY
    : NOT_DESKTOP_SAY;
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

/** Exported for the test that proves every kind is answerable here. */
export function describeMissingCapability(intent: AppIntent): string {
  return missingCapabilitySay(intent);
}

export function runAppIntent(decision: AppIntentDecision, host: AppIntentHost): AppIntentRun {
  if (decision.kind !== "intent") {
    // A question is answered by saying it; a refusal is answered by saying it. Neither is permission, and this
    // function cannot grant any.
    return { ran: false, say: notExecutableSay(decision) };
  }

  const intent = decision.intent;
  const readBack = decision.readBack === "" ? describeAppIntent(intent) : decision.readBack;

  if (!hostHasCapability(host, intent)) {
    return { ran: false, say: missingCapabilitySay(intent) };
  }

  switch (intent.kind) {
    case "settings.open":
      host.openSettings();
      return { ran: true, say: readBack };
    case "settings.tab":
      host.openSettings(intent.tab);
      return { ran: true, say: readBack };
    case "nav.home":
      host.goHome();
      return { ran: true, say: readBack };
    case "composer.attach":
      host.openFilePicker();
      return { ran: true, say: readBack };
    case "voice.end":
      host.endVoice();
      return { ran: true, say: readBack };
    case "window.expand":
      host.expandWindow?.();
      return { ran: true, say: readBack };
    case "window.minimise":
      host.minimiseWindow?.();
      return { ran: true, say: readBack };
    case "window.minimal":
      host.setMinimal?.(true);
      return { ran: true, say: readBack };
    case "app.quit":
      host.quit?.();
      return { ran: true, say: readBack };
    case "widgets.open":
      host.openWidgetLibrary?.("browse");
      return { ran: true, say: readBack };
    case "widgets.show": {
      const target = {
        ...(intent.definitionId === undefined ? {} : { definitionId: intent.definitionId }),
        ...(intent.family === undefined ? {} : { family: intent.family }),
      };
      host.openWidgetLibrary?.("browse", target);
      return { ran: true, say: readBack };
    }
    default: {
      // Every kind above returns. This keeps a tenth kind from being silently ignored by the executor.
      const unreachable: never = intent.kind;
      throw new Error(`no executor for app intent ${String(unreachable)}`);
    }
  }
}

function hostHasCapability(host: AppIntentHost, intent: AppIntent): boolean {
  switch (intent.kind) {
    case "window.expand":
      return host.expandWindow !== undefined;
    case "window.minimise":
      return host.minimiseWindow !== undefined;
    case "window.minimal":
      return host.setMinimal !== undefined;
    case "app.quit":
      return host.quit !== undefined;
    case "widgets.open":
    case "widgets.show":
      return host.openWidgetLibrary !== undefined;
    default:
      return true;
  }
}
