import { createContext, useContext, type ReactElement, type ReactNode } from "react";

import type { LocaleState } from "./use-locale.ts";
import { readStoredLocale } from "./locale.ts";
import { CATALOGS, type MessageKey } from "./messages.ts";

/**
 * Threads `useLocale`'s state to every consumer without each component re-deriving it.
 *
 * Default is `undefined` rather than a synthesized `vi` state: `useT` falls back to
 * the stored choice, and `useLocaleState` (the setter) still requires the provider.
 */
const LocaleContext = createContext<LocaleState | undefined>(undefined);

export function LocaleProvider({
  value,
  children,
}: {
  value: LocaleState;
  children: ReactNode;
}): ReactElement {
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * The translator for the current UI language.
 *
 * Outside `LocaleProvider` (a detached widget window, or a hook that runs in `Conversation`'s own
 * body before its provider mounts) this reads the stored choice instead of throwing: a missing
 * provider must never blank the whole window, and the stored choice is what the user picked.
 */
export function useT(): (key: MessageKey) => string {
  const state = useContext(LocaleContext);
  if (state === undefined) {
    const catalog = CATALOGS[readStoredLocale()];
    return (key) => catalog[key];
  }
  return state.t;
}

/** The current locale choice and setter, for the settings picker. */
export function useLocaleState(): LocaleState {
  const state = useContext(LocaleContext);
  if (state === undefined) {
    throw new Error("useLocaleState() called outside <LocaleProvider>");
  }
  return state;
}
