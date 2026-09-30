import {
  BUILTIN_CLARK_THEME_REF,
  appearanceSnapshotSchema,
  checkThemeDocument,
  type ThemeContrastFailureView,
  type ThemeDocument,
  type ThemeOrb,
  type ThemeProtectedFailureView,
  type AppearanceSnapshot,
} from "@clarkcant/contracts";
import { appearanceStylesheet, compileAppearance, themeDrawProblem, type ThemeDrawProblem } from "@clarkcant/design-tokens";

/**
 * The theme a page is drawn in, applied without reloading it.
 *
 * The token variables live in a stylesheet of their own, separate from the component styles, so a theme change
 * replaces that one sheet's text and nothing else: no element is re-created, no state is reset, and a conversation, a
 * half-typed message, a pinned widget and a voice session all carry on exactly as they were.
 *
 * What reaches the sheet is compiled here, from a document checked here, even though the node already checked it. The
 * page is where a value would become CSS, so the page does not take the node's word for it: a document that fails the
 * contract, fails the contrast or protected-state audit, or compiles to a value the snapshot schema refuses, is drawn as Clark Default
 * instead.
 */

/** `data-cc-appearance` on the root: the revision being drawn, so a canvas that paints its own colours can follow it. */
export const APPEARANCE_ATTRIBUTE = "ccAppearance";

/**
 * The last theme drawn on this device, so the next load starts in it instead of flashing Clark Default until the node
 * answers. A copy, not a choice: the node's answer replaces it, and it is checked like any other document before use.
 */
export const APPEARANCE_STORAGE_KEY = "cc.appearance";

/** The revision a page is marked with when not even Clark Default's token sheet could be built. */
export const APPEARANCE_UNAVAILABLE = "unavailable";

let tokenSheet: { kind: "constructed"; sheet: CSSStyleSheet } | { kind: "element"; element: HTMLStyleElement } | undefined;

/**
 * A theme refused by an audit: for unreadable colours, or for hiding a protected state. It carries every failing pair
 * as data, so the refusal can be worded in the reader's language.
 */
export class ThemeDrawError extends Error {
  readonly problem: ThemeDrawProblem;

  constructor(problem: ThemeDrawProblem) {
    super(problem.message);
    this.name = "ThemeDrawError";
    this.problem = problem;
  }
}

export interface CompiledAppearance {
  css: string;
  snapshots?: AppearanceSnapshots;
  reducedSnapshots?: AppearanceSnapshots;
  /** Both schemes' revisions: the page is drawn in whichever the colour scheme resolves to, and either can change. */
  revision: string;
}

type AppearanceSnapshots = Readonly<Record<"dark" | "light", AppearanceSnapshot>>;

/**
 * Compile a theme into the token stylesheet, both schemes.
 *
 * Throws when the theme fails the contrast or protected-state audit Clark Default is held to, or when the result would break the
 * snapshot contract: either way the caller draws Clark Default and says why.
 */
export function compileThemeStylesheet(theme: ThemeDocument | undefined, themeRef: string): CompiledAppearance {
  if (theme !== undefined) {
    const refused = themeDrawProblem(theme);
    if (refused !== undefined) throw new ThemeDrawError(refused);
  }
  const compile = (scheme: "dark" | "light", reducedMotion = false): AppearanceSnapshot => compileAppearance(
    theme === undefined ? { scheme, reducedMotion } : { scheme, theme, themeRef, reducedMotion },
  );
  const dark = compile("dark");
  const light = compile("light");
  return {
    css: appearanceStylesheet({ dark, light }),
    revision: `${dark.revision}-${light.revision}`,
    snapshots: { dark, light },
    reducedSnapshots: { dark: compile("dark", true), light: compile("light", true) },
  };
}

/**
 * Clark Default's token sheet, which never throws.
 *
 * Every fallback lands here, so it cannot itself be a way to fail. If even Clark Default does not compile — a broken
 * build, not anything a person or a package did — the token sheet is left empty and the error is logged: the component
 * sheet still installs and the conversation still renders, which is better than a window with nothing in it.
 */
function clarkStylesheet(): CompiledAppearance {
  try {
    return compileThemeStylesheet(undefined, BUILTIN_CLARK_THEME_REF);
  } catch (error) {
    console.error("Clark Default's token sheet did not compile", error);
    return { css: "", revision: APPEARANCE_UNAVAILABLE };
  }
}

/**
 * Install the token sheet and the component sheet, in that order.
 *
 * A constructed sheet rather than a `<style>` element: the desktop shell's policy has no `'unsafe-inline'` in
 * `style-src`, which blocks a script-made `<style>` and left the window with no stylesheet at all. `style-src` does not
 * govern an adopted sheet, so the same policy stands and the styles still apply. The element stays as the fallback for
 * an engine without constructable sheets.
 *
 * Nothing here throws. This runs before the first render, and a throw would leave the window blank; a theme remembered
 * from an earlier load that cannot be drawn now is dropped, and the page starts on Clark Default.
 */
export function installStyleSheets(componentCss: string): void {
  if (typeof document === "undefined" || tokenSheet !== undefined) return;
  const clark = clarkStylesheet();
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
  if (cached === undefined) return;
  try {
    applyAppearance(cached);
  } catch (error) {
    console.error("the remembered theme could not be drawn, so the page starts on Clark Default", error);
    writeTokens(clark);
    writeThemeOrb(undefined);
    cacheAppearance(undefined);
  }
}

export type AppliedAppearance =
  | { ok: true; themeRef: string; revision: string }
  /** The theme could not be drawn here; Clark Default is drawn instead, and `problem` says why. */
  | {
      ok: false;
      themeRef: typeof BUILTIN_CLARK_THEME_REF;
      revision: string;
      problem: string;
      /** When the refusal was for the theme's colours: every failing pair. */
      contrast?: ThemeContrastFailureView[];
      /** When the refusal was for hiding a protected state: every failing check. */
      protected?: ThemeProtectedFailureView[];
    };

/**
 * Draw the page in a theme, replacing only the token sheet.
 *
 * `theme` is `null` for Clark Default. Anything else is treated as untrusted input and checked before it is compiled.
 */
export function applyAppearance(input: { theme: unknown; themeRef: string }): AppliedAppearance {
  let compiled: CompiledAppearance | undefined;
  let problem: string | undefined;
  let refused: ThemeDrawProblem | undefined;
  let orbDefault: ThemeOrb | undefined;
  if (input.theme === null) {
    compiled = clarkStylesheet();
  } else {
    const checked = checkThemeDocument(input.theme);
    if (!checked.ok) {
      problem = checked.problems.join("; ");
    } else {
      try {
        compiled = compileThemeStylesheet(checked.document, input.themeRef);
        orbDefault = checked.document.orb;
      } catch (error) {
        problem = error instanceof Error ? error.message : "the theme does not compile";
        if (error instanceof ThemeDrawError) refused = error.problem;
      }
    }
  }

  const drawn = compiled ?? clarkStylesheet();
  writeTokens(drawn);
  writeThemeOrb(orbDefault);
  cacheAppearance(problem === undefined && input.theme !== null ? { theme: input.theme, themeRef: input.themeRef } : undefined);
  return problem === undefined && compiled !== undefined
    ? { ok: true, themeRef: input.theme === null ? BUILTIN_CLARK_THEME_REF : input.themeRef, revision: drawn.revision }
    : {
        ok: false,
        themeRef: BUILTIN_CLARK_THEME_REF,
        revision: drawn.revision,
        problem: problem ?? "the theme does not compile",
        ...(refused?.code === "THEME_LOW_CONTRAST" ? { contrast: refused.contrast } : {}),
        ...(refused?.code === "THEME_PROTECTED" ? { protected: refused.protected } : {}),
      };
}

/**
 * The Orb the drawn theme suggests, or `undefined` when it suggests none or Clark Default is drawn.
 *
 * Set only from a document that passed the contract and both audits, in the same step that draws it, so the Orb and
 * the token sheet cannot disagree about which theme is on screen. Every Orb on the page reads it as a default under the
 * person's own choice, never over it; see `resolveOrbProfile`.
 */
let themeOrb: ThemeOrb | undefined;
const themeOrbListeners = new Set<() => void>();

function writeThemeOrb(next: ThemeOrb | undefined): void {
  if (JSON.stringify(next) === JSON.stringify(themeOrb)) return;
  themeOrb = next;
  for (const listener of themeOrbListeners) listener();
}

/** The drawn theme's Orb suggestion. The same object until it changes, as `useSyncExternalStore` needs. */
export function readThemeOrb(): ThemeOrb | undefined {
  return themeOrb;
}

/** Called when the drawn theme's Orb suggestion changes. Returns the function that stops it. */
export function subscribeToThemeOrb(onChange: () => void): () => void {
  themeOrbListeners.add(onChange);
  return () => themeOrbListeners.delete(onChange);
}

function writeTokens(compiled: CompiledAppearance): void {
  if (typeof document !== "undefined" && tokenSheet !== undefined && document.documentElement.dataset[APPEARANCE_ATTRIBUTE] !== compiled.revision) {
    if (tokenSheet.kind === "constructed") tokenSheet.sheet.replaceSync(compiled.css);
    else tokenSheet.element.textContent = compiled.css;
    document.documentElement.dataset[APPEARANCE_ATTRIBUTE] = compiled.revision;
  }
  if (compiled.snapshots !== undefined && compiled.reducedSnapshots !== undefined && drawnAppearance.revision !== compiled.revision) {
    drawnAppearance = compiled;
    for (const listener of appearanceListeners) listener();
  }
}

let drawnAppearance = clarkStylesheet();
const appearanceListeners = new Set<() => void>();

/** The checked appearance actually drawn, including a Lab subtree's scheme and reduced motion. */
export function readAppearanceSnapshot(scope?: Element | null): AppearanceSnapshot | undefined {
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  const scopedScheme = scope?.closest("[data-cc-theme]")?.getAttribute("data-cc-theme");
  const scheme = (scopedScheme ?? root?.dataset.ccTheme) === "light" ? "light" : "dark";
  const reduced = scope?.closest('[data-cc-reduced-motion="true"]') != null
    || (typeof document !== "undefined" && document.body?.dataset.ccReducedMotion === "true")
    || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  return (reduced ? drawnAppearance.reducedSnapshots : drawnAppearance.snapshots)?.[scheme];
}

/** One drawn snapshot path for iframe and detached renderers; no node/theme query. */
export function subscribeToAppearanceSnapshot(listener: () => void): () => void {
  appearanceListeners.add(listener);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(listener) : undefined;
  if (typeof document !== "undefined") {
    observer?.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-cc-theme", "data-cc-reduced-motion"],
    });
  }
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
  media?.addEventListener("change", listener);
  return () => {
    appearanceListeners.delete(listener);
    observer?.disconnect();
    media?.removeEventListener("change", listener);
  };
}

/** A detached surface draws the host's resolved snapshot, without credentials or a theme lookup. */
export function applyRelayedAppearance(raw: unknown): boolean {
  const checked = appearanceSnapshotSchema.safeParse(raw);
  if (!checked.success) return false;
  const snapshot = checked.data;
  const pair = { dark: snapshot, light: snapshot };
  writeTokens({ css: appearanceStylesheet(pair), revision: snapshot.revision, snapshots: pair, reducedSnapshots: pair });
  if (typeof document !== "undefined") document.documentElement.dataset.ccTheme = snapshot.scheme;
  return true;
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
