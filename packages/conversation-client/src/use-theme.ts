import { useCallback, useEffect, useState } from "react";

import {
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersLight,
  watchSystemTheme,
  type ThemeChoice,
} from "./theme.ts";
import type { ThemeName } from "@clarkcant/design-tokens";

export interface ThemeState {
  themeChoice: ThemeChoice;
  resolvedTheme: ThemeName;
  /**
   * Apply the choice: store it, resolve it, and write the result onto the document.
   *
   * Storing the choice rather than the resolved value is what lets `system` keep meaning
   * `system` across a reload.
   */
  applyThemeChoice: (next: ThemeChoice) => void;
}

/**
 * The theme the user chose, resolved against the operating system.
 *
 * The choice is held, not the resolved theme. Holding the resolved theme would silently turn
 * `system` into whichever theme the operating system happened to be in when the page loaded,
 * and the interface would then stop following the system it was asked to follow.
 */
export function useTheme(): ThemeState {
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<ThemeName>(() =>
    resolveTheme(readStoredTheme(), systemPrefersLight()),
  );

  const applyThemeChoice = useCallback((next: ThemeChoice) => {
    storeTheme(next);
    const resolved = resolveTheme(next, systemPrefersLight());
    applyResolvedTheme(resolved);
    setThemeChoice(next);
    setResolvedTheme(resolved);
  }, []);

  /*
   * Follow the operating system, but only while the user has actually asked for `system`.
   * A listener that keeps firing after the user picks an explicit theme would override their
   * choice the next time their machine switched to night mode.
   */
  useEffect(() => {
    if (themeChoice !== "system") return;
    return watchSystemTheme((prefersLight) => {
      const resolved = resolveTheme("system", prefersLight);
      applyResolvedTheme(resolved);
      setResolvedTheme(resolved);
    });
  }, [themeChoice]);

  return { themeChoice, resolvedTheme, applyThemeChoice };
}
