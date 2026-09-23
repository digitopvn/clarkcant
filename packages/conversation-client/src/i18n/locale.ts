/**
 * The UI language choice.
 *
 * Mirrors `theme.ts` on purpose: a language is the same kind of preference as a theme — it
 * describes this screen, it must work before the node has answered, and a reload must not lose
 * it. `vi` is the default because Vietnamese is the product's own language (AGENTS.md); `system`
 * is not offered because there is no reliable cross-platform signal for "the user's UI language"
 * that would not sometimes silently switch a Vietnamese speaker's product language away from
 * Vietnamese.
 */

export type LocaleChoice = "vi" | "en";

export const LOCALE_CHOICES: readonly LocaleChoice[] = ["vi", "en"] as const;

export const DEFAULT_LOCALE: LocaleChoice = "vi";

/** Where the choice is cached locally, so the page can render correctly before the node answers. */
export const LOCALE_STORAGE_KEY = "cc.locale";

export function isLocaleChoice(value: unknown): value is LocaleChoice {
  return value === "vi" || value === "en";
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Read the cached choice, or the default. Never throws: an unreadable preference is not worth a broken page. */
export function readStoredLocale(storage?: Pick<Storage, "getItem">): LocaleChoice {
  const store = storage ?? safeStorage();
  if (store === undefined) return DEFAULT_LOCALE;
  try {
    const raw = store.getItem(LOCALE_STORAGE_KEY);
    return isLocaleChoice(raw) ? raw : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Cache the choice. Failure is silent for the same reason `storeTheme` is silent. */
export function storeLocale(choice: LocaleChoice, storage?: Pick<Storage, "setItem">): void {
  const store = storage ?? safeStorage();
  if (store === undefined) return;
  try {
    store.setItem(LOCALE_STORAGE_KEY, choice);
  } catch {
    // A choice that cannot be cached still applies for this session; it just will not survive reload.
  }
}

/** The `lang` attribute value for each choice, so the document always states its real language. */
const HTML_LANG: Record<LocaleChoice, string> = {
  vi: "vi",
  en: "en",
};

/** Write the chosen language onto `<html lang>`. */
export function applyDocumentLocale(choice: LocaleChoice): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = HTML_LANG[choice];
}
