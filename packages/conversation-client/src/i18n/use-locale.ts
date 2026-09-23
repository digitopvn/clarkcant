import { useCallback, useState } from "react";

import { applyDocumentLocale, readStoredLocale, storeLocale, type LocaleChoice } from "./locale.ts";
import { CATALOGS, type MessageKey } from "./messages.ts";

export interface LocaleState {
  locale: LocaleChoice;
  /** Set the language: cache it, write `<html lang>`, and re-render every `t()` consumer. */
  setLocale: (next: LocaleChoice) => void;
  /** Look up one catalog string. Never translates agent output — only this file's own keys. */
  t: (key: MessageKey) => string;
}

/** Read the cached choice and write it onto the document in the same step, once, at mount. */
function readAndApplyStoredLocale(): LocaleChoice {
  const choice = readStoredLocale();
  applyDocumentLocale(choice);
  return choice;
}

/**
 * The UI language, resolved the same way `useTheme` resolves the theme: read the cached choice
 * before paint, apply it to the document, and keep it in state so every consumer re-renders when
 * it changes.
 */
export function useLocale(): LocaleState {
  const [locale, setLocaleState] = useState<LocaleChoice>(readAndApplyStoredLocale);

  const setLocale = useCallback((next: LocaleChoice) => {
    storeLocale(next);
    applyDocumentLocale(next);
    setLocaleState(next);
  }, []);

  const t = useCallback((key: MessageKey): string => CATALOGS[locale][key], [locale]);

  return { locale, setLocale, t };
}
