/**
 * The theme choice.
 *
 * Three things are separate here and keeping them separate is the whole design:
 *
 *   - the *choice* the user made, which is `dark`, `light`, or `system`;
 *   - the *resolved* theme, which is always `dark` or `light`;
 *   - what the document currently shows, which is the resolved theme as an attribute.
 *
 * Storing the resolved theme instead of the choice loses the fact that the user asked for
 * `system`, so the interface can no longer follow the operating system when it changes. That
 * is a small bug that only shows up later, on someone else's machine, at night.
 *
 * The choice lives in `localStorage` rather than on the node because it describes this screen,
 * and it has to work when the node does not: a person who set light mode and then lost the
 * runtime should not be dropped into a dark page.
 */

import { type ThemeName } from "@clarkcant/design-tokens";

/** What the user asked for. `system` is a choice, not a resolved theme. */
export type ThemeChoice = "dark" | "light" | "system";

export const THEME_CHOICES: readonly ThemeChoice[] = ["dark", "light", "system"] as const;

/** The attribute the token sheet selects on. Both themes are always present in the sheet. */
export const THEME_ATTRIBUTE = "ccTheme";

const STORAGE_KEY = "cc.theme";

/**
 * `system` when the preference is unreadable.
 *
 * The default matters more than it looks: an unreadable preference is the first-run case, and
 * following the operating system is the answer that is wrong for the fewest people.
 */
export const DEFAULT_THEME_CHOICE: ThemeChoice = "system";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "dark" || value === "light" || value === "system";
}

/**
 * Read the stored choice, or the default.
 *
 * Reading is wrapped because `localStorage` throws rather than returning null in some privacy
 * configurations. A theme is not worth a broken page, so the failure is a fallback.
 */
export function readStoredTheme(storage?: Pick<Storage, "getItem">): ThemeChoice {
  const store = storage ?? safeStorage();
  if (store === undefined) return DEFAULT_THEME_CHOICE;
  try {
    const raw = store.getItem(STORAGE_KEY);
    return isThemeChoice(raw) ? raw : DEFAULT_THEME_CHOICE;
  } catch {
    return DEFAULT_THEME_CHOICE;
  }
}

/** Store the choice. Failure is silent for the same reason reading is guarded. */
export function storeTheme(choice: ThemeChoice, storage?: Pick<Storage, "setItem">): void {
  const store = storage ?? safeStorage();
  if (store === undefined) return;
  try {
    store.setItem(STORAGE_KEY, choice);
  } catch {
    // A preference that cannot be saved is a preference that does not survive reload; the
    // interface still works, so this is not worth interrupting the user for.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Turn a choice into the theme that is actually shown.
 *
 * `system` resolves through the media query. When the query is unavailable the answer is dark,
 * matching the specification's default surface.
 */
export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ThemeName {
  if (choice === "system") return prefersLight ? "light" : "dark";
  return choice;
}

/**
 * Whether the operating system is asking for a light interface.
 *
 * `matchMedia` is absent outside a browser and during server rendering, and the fallback is
 * dark rather than an exception, because a theme is not a reason to fail a render.
 */
export function systemPrefersLight(): boolean {
  if (typeof matchMedia !== "function") return false;
  try {
    return matchMedia("(prefers-color-scheme: light)").matches;
  } catch {
    return false;
  }
}

/** Write the resolved theme onto the document. */
export function applyResolvedTheme(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset[THEME_ATTRIBUTE] = theme;
}

/**
 * Follow the operating system while the choice is `system`.
 *
 * Returns a function that stops following. The listener is re-registered per call rather than
 * held globally, so a component that unmounts does not leave a listener holding its setState.
 */
export function watchSystemTheme(onChange: (prefersLight: boolean) => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  let query: MediaQueryList;
  try {
    query = matchMedia("(prefers-color-scheme: light)");
  } catch {
    return () => {};
  }
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/**
 * The inline script that runs before the first paint.
 *
 * Without this the page paints with the dark default and then switches, which is a visible
 * flash on every load for anyone who chose light. It is a string rather than a module because
 * it has to run in the document head, before the bundle.
 */
export const ANTI_FLASH_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});var l=(c==="light")||(c==="system"&&matchMedia("(prefers-color-scheme: light)").matches);document.documentElement.dataset.${THEME_ATTRIBUTE}=l?"light":"dark";}catch(e){document.documentElement.dataset.${THEME_ATTRIBUTE}="dark";}})();`;
