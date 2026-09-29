import { BUILTIN_CLARK_THEME_REF, checkThemeDocument, type ThemeDocument } from "@clarkcant/contracts";
import { appearanceStylesheet, compileAppearance } from "@clarkcant/design-tokens";

/**
 * The theme a page is drawn in, applied without reloading it.
 *
 * The token variables live in a stylesheet of their own, separate from the component styles, so a theme change
 * replaces that one sheet's text and nothing else: no element is re-created, no state is reset, and a conversation, a
 * half-typed message, a pinned widget and a voice session all carry on exactly as they were.
 *
 * What reaches the sheet is compiled here, from a document checked here, even though the node already checked it. The
 * page is where a value would become CSS, so the page does not take the node's word for it: a document that fails the
 * contract, or compiles to a value the snapshot schema refuses, is drawn as Clark Default instead.
 */

/** `data-cc-appearance` on the root: the revision being drawn, so a canvas that paints its own colours can follow it. */
export const APPEARANCE_ATTRIBUTE = "ccAppearance";

/**
 * The last theme drawn on this device, so the next load starts in it instead of flashing Clark Default until the node
 * answers. A copy, not a choice: the node's answer replaces it, and it is checked like any other document before use.
 */
export const APPEARANCE_STORAGE_KEY = "cc.appearance";

let tokenSheet: { kind: "constructed"; sheet: CSSStyleSheet } | { kind: "element"; element: HTMLStyleElement } | undefined;

export interface CompiledAppearance {
  css: string;
  /** Both schemes' revisions: the page is drawn in whichever the colour scheme resolves to, and either can change. */
  revision: string;
}

/** Compile a theme into the token stylesheet, both schemes. Throws when the result would break the snapshot contract. */
export function compileThemeStylesheet(theme: ThemeDocument | undefined, themeRef: string): CompiledAppearance {
  const dark = compileAppearance({ scheme: "dark", theme, themeRef });
  const light = compileAppearance({ scheme: "light", theme, themeRef });
  return { css: appearanceStylesheet({ dark, light }), revision: `${dark.revision}-${light.revision}` };
}

/**
 * Install the token sheet and the component sheet, in that order.
 *
 * A constructed sheet rather than a `<style>` element: the desktop shell's policy has no `'unsafe-inline'` in
 * `style-src`, which blocks a script-made `<style>` and left the window with no stylesheet at all. `style-src` does not
 * govern an adopted sheet, so the same policy stands and the styles still apply. The element stays as the fallback for
 * an engine without constructable sheets.
 */
export function installStyleSheets(componentCss: string): void {
  if (typeof document === "undefined" || tokenSheet !== undefined) return;
  const clark = compileThemeStylesheet(undefined, BUILTIN_CLARK_THEME_REF);
  if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in document) {
    const tokens = new CSSStyleSheet();
    tokens.replaceSync(clark.css);
    const components = new CSSStyleSheet();
    components.replaceSync(componentCss);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, tokens, components];
    tokenSheet = { kind: "constructed", sheet: tokens };
  } else {
    const tokens = document.createElement("style");
    tokens.dataset.clarkcant = "tokens";
    tokens.textContent = clark.css;
    const components = document.createElement("style");
    components.dataset.clarkcant = "styles";
    components.textContent = componentCss;
    document.head.append(tokens, components);
    tokenSheet = { kind: "element", element: tokens };
  }
  document.documentElement.dataset[APPEARANCE_ATTRIBUTE] = clark.revision;
  const cached = readCachedAppearance();
  if (cached !== undefined) applyAppearance(cached);
}

export type AppliedAppearance =
  | { ok: true; themeRef: string; revision: string }
  /** The theme could not be drawn here; Clark Default is drawn instead, and `problem` says why. */
  | { ok: false; themeRef: typeof BUILTIN_CLARK_THEME_REF; revision: string; problem: string };

/**
 * Draw the page in a theme, replacing only the token sheet.
 *
 * `theme` is `null` for Clark Default. Anything else is treated as untrusted input and checked before it is compiled.
 */
export function applyAppearance(input: { theme: unknown; themeRef: string }): AppliedAppearance {
  let compiled: CompiledAppearance | undefined;
  let problem: string | undefined;
  if (input.theme === null) {
    compiled = compileThemeStylesheet(undefined, BUILTIN_CLARK_THEME_REF);
  } else {
    const checked = checkThemeDocument(input.theme);
    if (!checked.ok) {
      problem = checked.problems.join("; ");
    } else {
      try {
        compiled = compileThemeStylesheet(checked.document, input.themeRef);
      } catch (error) {
        problem = error instanceof Error ? error.message : "the theme does not compile";
      }
    }
  }

  const drawn = compiled ?? compileThemeStylesheet(undefined, BUILTIN_CLARK_THEME_REF);
  writeTokens(drawn);
  cacheAppearance(problem === undefined && input.theme !== null ? { theme: input.theme, themeRef: input.themeRef } : undefined);
  return problem === undefined && compiled !== undefined
    ? { ok: true, themeRef: input.theme === null ? BUILTIN_CLARK_THEME_REF : input.themeRef, revision: drawn.revision }
    : { ok: false, themeRef: BUILTIN_CLARK_THEME_REF, revision: drawn.revision, problem: problem ?? "the theme does not compile" };
}

function writeTokens(compiled: CompiledAppearance): void {
  if (typeof document === "undefined" || tokenSheet === undefined) return;
  // Nothing changed: leave the sheet alone, so a refetch that returns the same theme restyles nothing.
  if (document.documentElement.dataset[APPEARANCE_ATTRIBUTE] === compiled.revision) return;
  if (tokenSheet.kind === "constructed") tokenSheet.sheet.replaceSync(compiled.css);
  else tokenSheet.element.textContent = compiled.css;
  document.documentElement.dataset[APPEARANCE_ATTRIBUTE] = compiled.revision;
}

function readCachedAppearance(): { theme: unknown; themeRef: string } | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(APPEARANCE_STORAGE_KEY);
    if (raw === null || raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as { theme?: unknown; themeRef?: unknown };
    return typeof parsed.themeRef === "string" && parsed.theme !== undefined
      ? { theme: parsed.theme, themeRef: parsed.themeRef }
      : undefined;
  } catch {
    // Storage blocked, or a value this build did not write: start on Clark Default and let the node answer.
    return undefined;
  }
}

function cacheAppearance(value: { theme: unknown; themeRef: string } | undefined): void {
  try {
    if (value === undefined) globalThis.localStorage?.removeItem(APPEARANCE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A device that cannot store it redraws from the node's answer on the next load, which is all this saves.
  }
}