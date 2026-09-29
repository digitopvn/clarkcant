/**
 * The colour-scheme choice: System, Light or Dark.
 *
 * This is the colour scheme, not the theme. A theme (Clark Default, or one a package provides) is a separate choice,
 * `experience.themeRef`, and every theme is drawn in whichever scheme is resolved here. The names below predate that
 * split and still say "theme" where they mean the scheme.
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

import { type ColorScheme, type ResolvedColorScheme, colorSchemeSchema, resolveColorScheme } from "@clarkcant/contracts";

/** What the user asked for. `system` is a choice, not a resolved scheme. */
export type ThemeChoice = ColorScheme;

export const THEME_CHOICES: readonly ThemeChoice[] = ["dark", "light", "system"] as const;

/** The attribute the token sheet selects on. Both themes are always present in the sheet. */
export const THEME_ATTRIBUTE = "ccTheme";

/**
 * Where the choice is stored. Exported so the drift test compares the real constant against the
 * pre-paint script rather than against a copy of the string, which would keep passing while the two
 * drifted apart.
 */
export const THEME_STORAGE_KEY = "cc.theme";

/**
 * `system` when the preference is unreadable.
 *
 * The default matters more than it looks: an unreadable preference is the first-run case, and
 * following the operating system is the answer that is wrong for the fewest people.
 */
export const DEFAULT_THEME_CHOICE: ThemeChoice = "system";

/** Whether a stored value is a choice, by the contract's own schema rather than a second list that could drift. */
export function isThemeChoice(value: unknown): value is ThemeChoice {
  return colorSchemeSchema.safeParse(value).success;
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
    const raw = store.getItem(THEME_STORAGE_KEY);
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
    store.setItem(THEME_STORAGE_KEY, choice);
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
export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ResolvedColorScheme {
  return resolveColorScheme(choice, prefersLight);
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
export function applyResolvedTheme(theme: ResolvedColorScheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset[THEME_ATTRIBUTE] = theme;
}

/**
 * Read the theme the document is currently showing.
 *
 * The attribute is the source of truth rather than the React state, because a canvas that reads it
 * has no way to know which component last changed the theme — and it must agree with what the CSS
 * is actually painting, not with what someone intended.
 */
export function readDocumentTheme(): ResolvedColorScheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset[THEME_ATTRIBUTE] === "light" ? "light" : "dark";
}

/**
 * What the document is drawn in: the colour scheme and the revision of the theme's tokens.
 *
 * One string, so a consumer that has to redraw on either change compares one value. A theme change keeps the scheme
 * and changes the revision; a scheme change keeps the theme and changes which of its two blocks applies.
 */
export function readDocumentAppearance(): string {
  if (typeof document === "undefined") return "dark";
  return `${readDocumentTheme()}:${document.documentElement.dataset.ccAppearance ?? ""}`;
}

/**
 * Called when the document's colour scheme or theme changes.
 *
 * Exists for the WebGL orb. The orb paints its own background to match the page, and it reads that
 * colour once when it is created — so without a notification it keeps the previous colour and its
 * square canvas becomes a visible rectangle on the new one. Nothing else needs this: the rest of the
 * interface is CSS and follows the attributes on its own.
 */
export function subscribeToDocumentTheme(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver !== "function") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-cc-theme", "data-cc-appearance"],
  });
  return () => observer.disconnect();
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
 * The inline script that ran before the first paint was removed.
 *
 * It was exported here and never used: the page cannot run an inline script under `script-src
 * 'self'`, so the real pre-paint logic lives in `apps/web/public/theme-init.js`, and this copy was
 * dead code that could only drift away from it. A drift test compares that file against the
 * constants above instead, which is a check that cannot silently stop being true.
 */
export const PREPAINT_SCRIPT_PATH = "apps/web/public/theme-init.js";
