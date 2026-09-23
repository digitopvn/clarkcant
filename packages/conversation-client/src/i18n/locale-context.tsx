import { createContext, useContext, type ReactElement, type ReactNode } from "react";

import type { LocaleState } from "./use-locale.ts";
import type { MessageKey } from "./messages.ts";

/**
 * Threads `useLocale`'s state to every consumer without each component re-deriving it.
 *
 * Default is `undefined` rather than a synthesized `vi` state: a component that reads `useT`
 * outside `LocaleProvider` has a real bug (the provider was not mounted), and failing loudly is
 * better than silently always rendering Vietnamese regardless of what the user chose.
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

/** The translator for the current UI language. Throws outside `LocaleProvider`. */
export function useT(): (key: MessageKey) => string {
  const state = useContext(LocaleContext);
  if (state === undefined) {
    throw new Error("useT() called outside <LocaleProvider>");
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
