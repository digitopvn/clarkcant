/**
 * Preview vocabulary, shared by the in-app Widget Lab and `clark widget dev`.
 *
 * This module is the single source for which viewports, widths and themes a preview may take, and
 * for how a control changes them. It was extracted from the CLI dev shell so the two playgrounds
 * cannot drift into disagreeing about what "compact" means; `widget-cli` re-exports these names.
 */

export const PREVIEW_VIEWPORTS = ["320", "conversation", "compact", "expanded"] as const;
export type PreviewViewport = (typeof PREVIEW_VIEWPORTS)[number];

export const PREVIEW_WIDTHS: Record<PreviewViewport, number> = {
  "320": 320,
  conversation: 420,
  compact: 360,
  expanded: 720,
};

export const PREVIEW_THEMES = ["light", "dark", "system"] as const;
export type PreviewTheme = (typeof PREVIEW_THEMES)[number];

export interface PreviewState {
  fixture: string;
  viewport: PreviewViewport;
  theme: PreviewTheme;
  reducedMotion: boolean;
}

export type PreviewAction =
  | { kind: "fixture"; value: string }
  | { kind: "viewport"; value: string }
  | { kind: "theme"; value: string }
  | { kind: "reduced-motion"; value: boolean };

export function initialPreviewState(
  fixtures: readonly string[],
  fixtureId?: string,
): PreviewState {
  return {
    fixture: fixtureId ?? fixtures[0] ?? "default",
    viewport: "conversation",
    theme: "system",
    reducedMotion: false,
  };
}

/**
 * Apply one preview control change.
 *
 * An unknown value is ignored rather than stored: a shell that showed an empty widget because of a
 * typo would be a shell whose author cannot tell a bad fixture name from a broken widget.
 */
export function applyPreviewAction(
  state: PreviewState,
  action: PreviewAction,
  known: { fixtures: readonly string[] },
): PreviewState {
  switch (action.kind) {
    case "fixture": {
      if (!known.fixtures.includes(action.value)) return state;
      return { ...state, fixture: action.value };
    }
    case "viewport": {
      if (!(PREVIEW_VIEWPORTS as readonly string[]).includes(action.value)) return state;
      return { ...state, viewport: action.value as PreviewViewport };
    }
    case "theme": {
      if (!(PREVIEW_THEMES as readonly string[]).includes(action.value)) return state;
      return { ...state, theme: action.value as PreviewTheme };
    }
    case "reduced-motion": {
      return { ...state, reducedMotion: action.value === true };
    }
    default: {
      return state;
    }
  }
}

export function viewportWidth(viewport: PreviewViewport): number {
  return PREVIEW_WIDTHS[viewport];
}
