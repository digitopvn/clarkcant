import { type AppearanceFallbackCode, BUILTIN_CLARK_THEME_REF, type ColorScheme } from "@clarkcant/contracts";

import { GatewayError } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";
import type { AppearanceRead } from "./use-appearance.ts";

/**
 * Changing the appearance, as one set of actions whichever way the person asked.
 *
 * The theme picker's click, a typed "đổi giao diện sang …", a spoken one and the agent's `control_app` all store the
 * theme through the same preference write (`experience.themeRef`, which the node checks before it stores it) and all
 * redraw through the same appearance read. Light and dark are the device's own choice and go through the same
 * `applyThemeChoice` the Settings control calls. Nothing here asks for confirmation: an appearance change is undone by
 * making it again, and a theme the node or the page refuses to draw is reported as refused, never as chosen.
 */

/** The sentence for each reason the node gives for drawing Clark Default instead of the chosen theme. */
export const APPEARANCE_FALLBACK_KEYS: Readonly<Record<AppearanceFallbackCode, MessageKey>> = {
  THEME_NOT_INSTALLED: "settings.experience.themePicker.fallback.notInstalled",
  THEME_INVALID: "settings.experience.themePicker.fallback.invalid",
  THEME_LOW_CONTRAST: "settings.experience.themePicker.fallback.lowContrast",
  THEME_PROTECTED: "settings.experience.themePicker.fallback.protected",
  THEME_UNAVAILABLE: "settings.experience.themePicker.fallback.unavailable",
  THEME_UNKNOWN: "settings.experience.themePicker.fallback.unknown",
};

/**
 * The sentence for a fallback code, or a generic one for a code this build does not know.
 *
 * The code comes from the node, which can be newer than the page; an unknown one must still read as a sentence in the
 * person's language, not as a missing message key.
 */
export function appearanceFallbackKey(code: string): MessageKey {
  return Object.hasOwn(APPEARANCE_FALLBACK_KEYS, code)
    ? APPEARANCE_FALLBACK_KEYS[code as AppearanceFallbackCode]
    : "settings.experience.themePicker.fallback.other";
}

/** The refusals of a theme write that mean the theme cannot be drawn safely, rather than that the node failed. */
const AUDIT_REFUSALS: ReadonlySet<string> = new Set(["THEME_LOW_CONTRAST", "THEME_PROTECTED"]);

/**
 * The other refusals a theme write can carry, said in the reader's language. The node's own sentence beside the code
 * is English and names internals, so it is for logs; a refusal without a code here (a busy node, a lost connection)
 * keeps the node's sentence, which is the most specific thing known about it.
 */
const WRITE_REFUSAL_KEYS: Readonly<Record<string, MessageKey>> = {
  THEME_NOT_INSTALLED: "shell.intent.themeWriteReason.notInstalled",
  THEME_INVALID: "shell.intent.themeWriteReason.invalid",
  THEME_UNAVAILABLE: "shell.intent.themeWriteReason.unavailable",
  THEME_UNKNOWN: "shell.intent.themeWriteReason.unknown",
};

export interface ThemeSelection {
  /** Store the theme: the same preference write the theme picker makes. */
  write: (themeRef: string) => Promise<unknown>;
  /** Re-read the appearance and draw it; `undefined` when the node could not answer. */
  refresh: () => Promise<AppearanceRead | undefined>;
  t: (key: MessageKey) => string;
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), template);
}

/**
 * Choose a theme, and answer only with what the screen now shows.
 *
 * The sentence is what the person is told, so "done" waits for the redraw. A write the node refused because the theme
 * would hide what Clark keeps visible is said as that, in the reader's language. A redraw that shows Clark Default
 * instead says why, from the same fallback sentences the theme picker uses.
 */
export async function chooseThemeShown(themeRef: string, name: string | undefined, selection: ThemeSelection): Promise<string> {
  const { t } = selection;
  const label = name ?? themeRef;
  try {
    await selection.write(themeRef);
  } catch (cause) {
    if (cause instanceof GatewayError && AUDIT_REFUSALS.has(cause.code)) {
      throw new Error(fill(t("shell.intent.themeRefused"), { name: label }), { cause });
    }
    const known = cause instanceof GatewayError && Object.hasOwn(WRITE_REFUSAL_KEYS, cause.code) ? WRITE_REFUSAL_KEYS[cause.code] : undefined;
    const reason =
      known !== undefined
        ? t(known)
        : cause instanceof GatewayError
          ? cause.reason
          : cause instanceof Error
            ? cause.message
            : String(cause);
    throw new Error(fill(t("shell.intent.themeWriteFailed"), { name: label, reason }), { cause });
  }
  const read = await selection.refresh();
  if (read === undefined) throw new Error(fill(t("shell.intent.themeSavedNotShown"), { name: label }));
  if (read.localProblem !== undefined) {
    throw new Error(fill(t("shell.intent.themeShowsDefault"), { name: label, reason: t("shell.intent.themeLocalRefused") }));
  }
  if (read.appearance.appliedRef !== themeRef) {
    const code = read.appearance.fallback?.code;
    const reason = code === undefined ? t("shell.intent.themeLocalRefused") : t(appearanceFallbackKey(code));
    throw new Error(fill(t("shell.intent.themeShowsDefault"), { name: label, reason }));
  }
  return fill(t("shell.intent.themeChanged"), { name: label });
}

export interface AppearanceReset extends ThemeSelection {
  /** The device's light/dark choice, the same call the Settings control makes. */
  applyColorScheme: (scheme: ColorScheme) => void;
}

/**
 * Put the appearance back: Clark Default, and light or dark following the system.
 *
 * The theme goes first because it is the half that can fail; a reset that could not store Clark Default leaves the
 * light/dark choice as it was, so the person is not left with half of what they asked for and told it was all.
 */
export async function resetAppearanceShown(reset: AppearanceReset): Promise<void> {
  await chooseThemeShown(BUILTIN_CLARK_THEME_REF, "Clark Default", reset);
  reset.applyColorScheme("system");
}
