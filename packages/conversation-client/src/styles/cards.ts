/**
 * Cards styles.
 *
 * Generic cards, tables, charts, notes and the pin shelf.
 *
 * Wrapped in its own CSS `@layer` so the concatenation order in styles.ts stays the visible,
 * intentional cascade order rather than an accident of import order.
 */
export const CARDS_CSS = `
@layer cards {
/* Cards */
.cc-card {
  border: 1px solid var(--cc-border);
  background: var(--cc-card);
  border-radius: var(--cc-radius-card);
  overflow: hidden;
}
.cc-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-sm);
  padding: var(--cc-space-sm) var(--cc-space-md);
  border-bottom: 1px solid var(--cc-border);
  font-size: var(--cc-text-label); color: var(--cc-text-muted);
}
.cc-card-title { font-weight: 600; color: var(--cc-text); }
.cc-card-body { padding: var(--cc-space-md); display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-fields { display: grid; grid-template-columns: max-content 1fr; gap: var(--cc-space-xs) var(--cc-space-md); margin: 0; }
.cc-fields dt { color: var(--cc-text-muted); }
.cc-fields dd { margin: 0; }
.cc-badge {
  font-size: var(--cc-text-label);
  padding: 2px var(--cc-space-sm);
  border-radius: var(--cc-radius-pill);
  border: 1px solid var(--cc-border);
  /*
   * Both of these are set explicitly because a badge is sometimes a button. A badge with no
   * background is painted by the user agent, which gives it a light grey that ignores the
   * theme, and the muted text on top of that grey measured 2.2:1 — the worst contrast in the
   * product, on the first three things a new user is invited to click.
   */
  background: transparent;
  color: var(--cc-text-muted);
  /*
   * A badge is a label, not a paragraph. In a flex row narrow enough to squeeze it, the default
   * was breaking "chưa dùng được" across three lines, which reads as three words rather than one
   * state and made the row taller than the text beside it.
   */
  white-space: nowrap;
  flex: none;
}
button.cc-badge, .cc-badge[role="button"] { cursor: pointer; font: inherit; transition: color var(--cc-motion-micro) var(--cc-motion-easing), border-color var(--cc-motion-micro) var(--cc-motion-easing), background var(--cc-motion-micro) var(--cc-motion-easing); }
button.cc-badge:hover, .cc-badge[role="button"]:hover { color: var(--cc-text); border-color: var(--cc-focus); background: var(--cc-elevated); }
.cc-badge[data-tone="warn"] { color: var(--cc-warning); border-color: color-mix(in oklab, var(--cc-warning) 45%, transparent); }
.cc-badge[data-tone="danger"] { color: var(--cc-danger); border-color: color-mix(in oklab, var(--cc-danger) 45%, transparent); }
.cc-badge[data-tone="ok"] { color: var(--cc-success); border-color: color-mix(in oklab, var(--cc-success) 45%, transparent); }
.cc-freshness { font-size: var(--cc-text-label); color: var(--cc-text-muted); }

/* Tables */
.cc-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.cc-table th, .cc-table td { text-align: left; padding: var(--cc-space-xs) var(--cc-space-sm); border-bottom: 1px solid var(--cc-border); }
.cc-table th { color: var(--cc-text-muted); font-weight: 500; font-size: var(--cc-text-label); }
.cc-table tr[aria-selected="true"] td { background: var(--cc-elevated); }
.cc-table tbody tr:hover td { background: var(--cc-elevated); cursor: pointer; }

/* Charts */
.cc-chart { width: 100%; height: 180px; display: block; }
.cc-chart .axis { stroke: var(--cc-border); }
.cc-chart .label { fill: var(--cc-text-muted); font-size: 10px; }
.cc-chart .series { fill: none; stroke: var(--cc-accent); stroke-width: 2; }
.cc-chart .point { fill: var(--cc-accent); }
.cc-chart .bar { fill: var(--cc-accent); }

/* Note */
.cc-note-input, .cc-note-area {
  width: 100%; background: var(--cc-elevated); color: var(--cc-text);
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge);
  padding: var(--cc-space-sm); font: inherit;
}
.cc-note-input { font-weight: 600; }
.cc-note-area { min-height: 120px; resize: vertical; }
.cc-note-meta { font-size: var(--cc-text-label); color: var(--cc-text-muted); }

/* Pin shelf */
.cc-pins {
  max-width: var(--cc-conversation-max-width); margin: 0 auto; width: 100%;
  padding: 0 var(--cc-space-lg) var(--cc-space-sm);
  display: flex; gap: var(--cc-space-sm); flex-wrap: wrap;
}
.cc-pin {
  display: flex; align-items: center; gap: var(--cc-space-sm);
  border: 1px solid var(--cc-border); background: var(--cc-card);
  border-radius: var(--cc-radius-pill); padding: var(--cc-space-xs) var(--cc-space-sm);
  font-size: var(--cc-text-label);
}
.cc-pin button { background: none; border: none; color: var(--cc-text-muted); cursor: pointer; font: inherit; padding: 0 2px; }
.cc-pin button:hover { color: var(--cc-text); }
.cc-pin-expanded { max-width: var(--cc-conversation-max-width); margin: 0 auto var(--cc-space-sm); width: 100%; padding: 0 var(--cc-space-lg); }

/*
 * Terminal card. The xterm.js rules it needs are carried here rather than imported from the package's stylesheet,
 * so both hosts get them from the one stylesheet this package owns, and its durations are the motion tokens.
 */
.cc-terminal-heading { display: flex; align-items: baseline; gap: var(--cc-space-sm); min-width: 0; }
.cc-terminal-cwd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); color: var(--cc-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cc-terminal-line { margin: 0; }
.cc-terminal-line code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); overflow-wrap: anywhere; }
.cc-terminal-label { color: var(--cc-text-muted); font-size: var(--cc-text-label); }
.cc-terminal-viewing { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--cc-space-sm); margin: 0; padding: var(--cc-space-xs) var(--cc-space-md); font-size: var(--cc-text-label); color: var(--cc-warning); border-bottom: 1px solid var(--cc-border); }
.cc-terminal-frame { position: relative; background: var(--cc-code); padding: var(--cc-space-xs) var(--cc-space-sm); }
.cc-terminal-frame:focus-within { outline: 2px solid var(--cc-focus); outline-offset: -2px; }
.cc-terminal-screen { height: 300px; overflow: hidden; }
.cc-terminal[data-expanded="true"] .cc-terminal-screen { height: 560px; }
@media (max-width: 640px) { .cc-terminal-screen { height: 240px; } .cc-terminal[data-expanded="true"] .cc-terminal-screen { height: 420px; } }
.cc-terminal-overlay { position: absolute; inset: 0; margin: 0; display: grid; place-items: center; color: var(--cc-text-muted); font-size: var(--cc-text-label); pointer-events: none; }
.cc-terminal-status { padding: 0 var(--cc-space-md); }
.cc-terminal-status p { margin: var(--cc-space-xs) 0 0; }
.cc-terminal-actions { padding: var(--cc-space-sm) var(--cc-space-md); align-items: center; }
.cc-terminal-hint { margin-left: auto; font-size: var(--cc-text-meta); color: var(--cc-text-tertiary); }
.cc-terminal-panel {
  border-top: 1px solid var(--cc-border);
  padding: var(--cc-space-sm) var(--cc-space-md) var(--cc-space-md);
  display: flex; flex-direction: column; gap: var(--cc-space-sm);
  max-height: 360px; overflow-y: auto;
  animation: cc-enter var(--cc-motion-enter) var(--cc-motion-bounce) both;
}
.cc-terminal-panel-head { display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-sm); }
.cc-terminal-panel h3 { margin: 0; font-size: var(--cc-text-label); font-weight: 600; }
.cc-terminal-panel h3:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-terminal-panel h4 { margin: 0 0 var(--cc-space-xs); font-size: var(--cc-text-label); font-weight: 500; color: var(--cc-text-muted); }
.cc-terminal-panel ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-terminal-panel li { display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-sm); padding: var(--cc-space-xs) 0; border-bottom: 1px solid var(--cc-border); }
.cc-terminal-panel-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--cc-space-sm); min-width: 0; }
.cc-terminal-panel-main code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); overflow-wrap: anywhere; }
.cc-terminal-panel-meta { font-size: var(--cc-text-meta); color: var(--cc-text-muted); overflow-wrap: anywhere; }

/* xterm.js core */
.xterm { cursor: text; position: relative; user-select: none; -webkit-user-select: none; }
.xterm.focus, .xterm:focus { outline: none; }
.xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
.xterm .xterm-helper-textarea { padding: 0; border: 0; margin: 0; position: absolute; opacity: 0; left: -9999em; top: 0; width: 0; height: 0; z-index: -5; white-space: nowrap; overflow: hidden; resize: none; }
.xterm .composition-view { background: var(--cc-code); color: var(--cc-text); display: none; position: absolute; white-space: nowrap; z-index: 1; }
.xterm .composition-view.active { display: block; }
.xterm .xterm-viewport { background-color: var(--cc-code); overflow-y: scroll; cursor: default; position: absolute; right: 0; left: 0; top: 0; bottom: 0; }
.xterm .xterm-screen { position: relative; }
.xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.xterm-char-measure-element { display: inline-block; visibility: hidden; position: absolute; top: 0; left: -9999em; line-height: normal; }
.xterm.enable-mouse-events { cursor: default; }
.xterm.xterm-cursor-pointer, .xterm .xterm-cursor-pointer { cursor: pointer; }
.xterm.column-select.focus { cursor: crosshair; }
.xterm .xterm-accessibility:not(.debug), .xterm .xterm-message { position: absolute; left: 0; top: 0; bottom: 0; right: 0; z-index: 10; color: transparent; pointer-events: none; }
.xterm .xterm-accessibility-tree:not(.debug) *::selection { color: transparent; }
.xterm .xterm-accessibility-tree { font-family: monospace; user-select: text; white-space: pre; }
.xterm .xterm-accessibility-tree > div { transform-origin: left; width: fit-content; }
.xterm .live-region { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.xterm-dim { opacity: 1 !important; }
.xterm-underline-1 { text-decoration: underline; }
.xterm-underline-2 { text-decoration: double underline; }
.xterm-underline-3 { text-decoration: wavy underline; }
.xterm-underline-4 { text-decoration: dotted underline; }
.xterm-underline-5 { text-decoration: dashed underline; }
.xterm-overline { text-decoration: overline; }
.xterm-overline.xterm-underline-1 { text-decoration: overline underline; }
.xterm-overline.xterm-underline-2 { text-decoration: overline double underline; }
.xterm-overline.xterm-underline-3 { text-decoration: overline wavy underline; }
.xterm-overline.xterm-underline-4 { text-decoration: overline dotted underline; }
.xterm-overline.xterm-underline-5 { text-decoration: overline dashed underline; }
.xterm-strikethrough { text-decoration: line-through; }
.xterm-screen .xterm-decoration-container .xterm-decoration { z-index: 6; position: absolute; }
.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer { z-index: 7; }
.xterm-decoration-overview-ruler { z-index: 8; position: absolute; top: 0; right: 0; pointer-events: none; }
.xterm-decoration-top { z-index: 2; position: relative; }
.xterm .xterm-scrollable-element > .scrollbar { cursor: default; }
.xterm .xterm-scrollable-element > .scrollbar > .slider { background: color-mix(in oklab, var(--cc-text-muted) 40%, transparent); border-radius: var(--cc-radius-pill); }
.xterm .xterm-scrollable-element > .visible { opacity: 1; background: transparent; transition: opacity var(--cc-motion-micro) var(--cc-motion-easing); z-index: 11; }
.xterm .xterm-scrollable-element > .invisible { opacity: 0; pointer-events: none; }
.xterm .xterm-scrollable-element > .invisible.fade { transition: opacity var(--cc-motion-exit) var(--cc-motion-easing); }
.xterm .xterm-scrollable-element > .shadow { position: absolute; display: none; }
}
`;
