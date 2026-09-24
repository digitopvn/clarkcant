/**
 * Panels styles.
 *
 * Evidence/artifact badges, focus rings, screen-reader-only text, settings, widget library, capability lists and small-viewport rules.
 *
 * Wrapped in its own CSS `@layer` so the concatenation order in styles.ts stays the visible,
 * intentional cascade order rather than an accident of import order.
 */
export const PANELS_CSS = `
@layer panels {
/* Evidence and artifacts */
.cc-evidence { display: flex; gap: var(--cc-space-sm); align-items: flex-start; font-size: var(--cc-text-label); }
.cc-evidence[data-verdict="not-verified"] { color: var(--cc-warning); }
.cc-evidence[data-verdict="contradicted"] { color: var(--cc-danger); }
.cc-evidence[data-verdict="verified"] { color: var(--cc-success); }

/* Focus: never removed, only restyled. Keyboard users must be able to see where they are. */
:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; border-radius: var(--cc-radius-badge); }
button:focus-visible, textarea:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }

/* Screen-reader-only text: the text alternative for every rich surface. */
.cc-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/*
 * The UI check panel.
 *
 * A scrim and a right-hand drawer rather than a modal, because its job is to be read
 * alongside the interface it describes: a modal that covered the screen would hide the
 * thing being checked.
 */
.cc-panel-scrim { position: fixed; inset: 0; background: color-mix(in oklab, var(--cc-code) 72%, transparent); z-index: 60; }
.cc-panel {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 61;
  width: min(400px, 92vw); display: flex; flex-direction: column;
  background: var(--cc-elevated); border-left: 1px solid var(--cc-border);
  box-shadow: -8px 0 32px color-mix(in oklab, var(--cc-code) 60%, transparent);
  animation: cc-panel-in var(--cc-motion-panel) var(--cc-motion-easing);
}
@keyframes cc-panel-in { from { transform: translateX(100%); } to { transform: none; } }
.cc-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--cc-space-md) var(--cc-space-lg); border-bottom: 1px solid var(--cc-border);
}
.cc-panel-head h2 { font-size: var(--cc-text-heading-md); line-height: var(--cc-leading-heading-md); margin: 0; }
.cc-panel-body { overflow-y: auto; padding: var(--cc-space-lg); display: flex; flex-direction: column; gap: var(--cc-space-xl); }
.cc-panel-section h3 {
  margin: 0 0 var(--cc-space-sm); font-size: var(--cc-text-label); line-height: var(--cc-leading-label);
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--cc-text-muted); font-weight: 600;
}
/* Groups are separated by more than the rows inside them, which is what makes them read as groups. */
.cc-panel-section + .cc-panel-section { margin-top: var(--cc-space-xl); }
.cc-panel-row { display: flex; flex-wrap: wrap; gap: var(--cc-space-sm); align-items: center; }

/*
 * Settings rows.
 *
 * The description is a visible line, never a tooltip: a limitation that only appears on hover is
 * one most people never learn about. The control column is fixed-width so a column of rows lines
 * up down the control rather than down the text.
 */
.cc-setting-row {
  display: flex;
  /* Centred rather than baseline-aligned: a row is a label with a description under it and a control on
     the right, and the control belongs beside the pair rather than level with the first line of it. */
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-md);
  padding: var(--cc-space-md) 0; border-bottom: 1px solid var(--cc-border);
}
.cc-setting-row:last-of-type { border-bottom: none; }
.cc-setting-row[data-state="blocked"] .cc-setting-label { color: var(--cc-warning); }
.cc-setting-row[data-state="absent"] .cc-setting-label { color: var(--cc-text-tertiary); }
.cc-setting-text { display: flex; flex-direction: column; gap: var(--cc-space-xxs); min-width: 0; }
.cc-setting-label { color: var(--cc-text); font-size: var(--cc-text-body-sm); line-height: var(--cc-leading-body-sm); font-weight: 600; }
.cc-setting-desc { color: var(--cc-text-muted); font-size: var(--cc-text-label); line-height: var(--cc-leading-label); }
.cc-setting-control { flex: none; display: flex; align-items: center; gap: var(--cc-space-sm); color: var(--cc-text-muted); }
.cc-setting-control code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm); color: var(--cc-text-muted); overflow-wrap: anywhere; }

/* A capability, with its real readiness. The reason is shown whenever there is one. */
.cc-tool-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--cc-space-md);
  padding: var(--cc-space-sm) 0; border-bottom: 1px solid var(--cc-border);
}
.cc-tool-row:last-of-type { border-bottom: none; }
.cc-tool-row code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm); color: var(--cc-text); }
.cc-tool-blocked { color: var(--cc-warning); }
.cc-panel-note { margin: var(--cc-space-sm) 0 0; font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-badge[data-selected="true"], .cc-swatch[aria-pressed="true"] {
  outline: 2px solid var(--cc-focus); outline-offset: 2px;
}
.cc-swatch { width: 32px; height: 32px; border-radius: var(--cc-radius-pill); border: 1px solid var(--cc-border); cursor: pointer; padding: 0; }
.cc-panel-readout { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-panel-readout li {
  display: flex; justify-content: space-between; gap: var(--cc-space-sm);
  font-size: var(--cc-text-label); color: var(--cc-text-muted);
  font-variant-numeric: tabular-nums;
}
.cc-panel-readout li[data-pass="false"] { color: var(--cc-danger); }
.cc-specimen { margin: 0; padding: var(--cc-space-sm) 0; border-bottom: 1px solid var(--cc-border); color: var(--cc-text); }
.cc-specimen-token { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-meta); line-height: var(--cc-leading-meta); color: var(--cc-text-tertiary); margin-top: var(--cc-space-xxs); }
.cc-radius-demo {
  width: 86px; height: 62px; display: flex; flex-direction: column; justify-content: center; gap: var(--cc-space-xxs);
  padding: var(--cc-space-xs); background: var(--cc-card); border: 1px solid var(--cc-border);
  font-size: var(--cc-text-meta); color: var(--cc-text-tertiary);
}
.cc-radius-demo code { color: var(--cc-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-meta); }
.cc-panel-space { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-panel-space li { display: flex; align-items: center; gap: var(--cc-space-sm); font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-panel-space code { width: 3rem; color: var(--cc-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-meta); }
.cc-space-bar { height: 10px; min-width: 2px; background: var(--cc-accent); border-radius: var(--cc-radius-badge); flex: none; }
.cc-space-value { color: var(--cc-text-tertiary); font-variant-numeric: tabular-nums; }

/* ------------------------------------------------------------------ *
 * Composed surface
 *
 * One container, several leaf regions. The grid is the only layout the container performs: each
 * region is an ordinary card, so a leaf that fails still leaves the rest of the surface readable.
 * ------------------------------------------------------------------ */
.cc-surface { padding: 0; }
.cc-surface-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--cc-space-md);
  align-items: start;
}
/* Wide regions span the full width so a chart or a month view is never cramped beside a tile. */
.cc-surface-region[data-slot="metrics"] { grid-column: 1 / -1; }
.cc-surface-region[data-slot="trend"] { grid-column: span 2; min-width: 0; }
.cc-surface-region[data-slot="calendar"] { grid-column: span 2; min-width: 0; }
.cc-surface-region[data-slot="cta"] { grid-column: 1 / -1; }
.cc-surface-region { display: flex; flex-direction: column; gap: var(--cc-space-xs); min-width: 0; }
.cc-surface-alt { margin: var(--cc-space-xs) 0 0; padding-left: var(--cc-space-md); color: var(--cc-text-muted); }

/* One column when there is no room for two. Reading order is unchanged: it is the slot order. */
@media (max-width: 560px) {
  .cc-surface-grid { grid-template-columns: 1fr; }
  .cc-surface-region[data-slot="trend"],
  .cc-surface-region[data-slot="calendar"] { grid-column: 1 / -1; }
}

.cc-metrics {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--cc-space-sm);
}
.cc-metric {
  display: flex; flex-direction: column; gap: var(--cc-space-xxs);
  border: 1px solid var(--cc-border); background: var(--cc-elevated);
  border-radius: var(--cc-radius-badge); padding: var(--cc-space-sm);
}
.cc-metric-label { color: var(--cc-text-muted); font-size: var(--cc-text-label); }
.cc-metric-value { font-size: var(--cc-text-heading-md); font-weight: 600; font-variant-numeric: tabular-nums; }
.cc-metric-unit { color: var(--cc-text-muted); font-size: var(--cc-text-label); margin-left: var(--cc-space-xxs); }
.cc-metric-hint { color: var(--cc-text-tertiary); font-size: var(--cc-text-meta); }

.cc-filter { display: flex; flex-direction: column; gap: var(--cc-space-xxs); }
.cc-filter select {
  background: var(--cc-elevated); color: var(--cc-text); font: inherit;
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge); padding: var(--cc-space-xs) var(--cc-space-sm);
  min-height: 32px;
}

/*
 * Six tones before they repeat. Each wedge's legend swatch reads the same tone, so a colour is always
 * named beside it; the old rules stopped at four, and the fifth wedge was the same colour as the first.
 */
.cc-donut { width: 160px; height: 160px; transform: rotate(-90deg); flex: none; }
.cc-donut .wedge { fill: none; stroke-width: 22; transform-origin: 80px 80px; }
.cc-donut .wedge:hover { opacity: 0.85; }
.cc-donut .wedge { stroke: var(--cc-slice, var(--cc-accent)); }
[data-slice-tone="1"] { --cc-slice: color-mix(in oklab, var(--cc-accent) 68%, var(--cc-text)); }
[data-slice-tone="2"] { --cc-slice: color-mix(in oklab, var(--cc-accent) 55%, var(--cc-card)); }
[data-slice-tone="3"] { --cc-slice: color-mix(in oklab, var(--cc-accent) 38%, var(--cc-text)); }
[data-slice-tone="4"] { --cc-slice: color-mix(in oklab, var(--cc-accent) 30%, var(--cc-card)); }
[data-slice-tone="5"] { --cc-slice: color-mix(in oklab, var(--cc-accent) 18%, var(--cc-text)); }
.cc-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); font-size: var(--cc-text-label); flex: 1; min-width: 160px; }
.cc-legend li { display: flex; gap: var(--cc-space-sm); justify-content: space-between; align-items: center; }
.cc-legend li > span:last-child { font-variant-numeric: tabular-nums; color: var(--cc-text-muted); }
.cc-legend-name { display: inline-flex; align-items: center; gap: var(--cc-space-sm); min-width: 0; }
.cc-legend-swatch { width: 10px; height: 10px; border-radius: 3px; background: var(--cc-slice, var(--cc-accent)); flex: none; }
.cc-text-alt summary { cursor: pointer; color: var(--cc-text-muted); font-size: var(--cc-text-label); width: fit-content; border-radius: var(--cc-radius-badge); }
.cc-text-alt summary:hover { color: var(--cc-text); }
.cc-text-alt[open] summary { margin-bottom: var(--cc-space-xs); }

.cc-calendar { width: 100%; border-collapse: collapse; table-layout: fixed; }
.cc-calendar th { color: var(--cc-text-muted); font-weight: 500; font-size: var(--cc-text-meta); padding: var(--cc-space-xxs); }
.cc-calendar td { padding: 1px; }
.cc-calendar-day {
  width: 100%; min-height: 36px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1px; background: none; border: 1px solid transparent; border-radius: var(--cc-radius-badge);
  color: var(--cc-text); font: inherit; cursor: pointer;
}
.cc-calendar td[data-in-month="false"] .cc-calendar-day { color: var(--cc-text-tertiary); }
.cc-calendar-day:hover { background: var(--cc-elevated); }
.cc-calendar-day[aria-pressed="true"] { border-color: var(--cc-accent); background: color-mix(in oklab, var(--cc-accent) 12%, var(--cc-card)); font-weight: 600; }
/* An event count is a small pill, so a day with events reads differently at a glance from a day without. */
.cc-calendar-count {
  font-size: var(--cc-text-meta); line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums;
  min-width: 16px; padding: 2px var(--cc-space-xs); border-radius: var(--cc-radius-pill);
  color: var(--cc-accent); background: color-mix(in oklab, var(--cc-accent) 16%, transparent);
}
.cc-calendar-detail {
  font-size: var(--cc-text-label); color: var(--cc-text);
  border-top: 1px solid var(--cc-border); padding-top: var(--cc-space-sm);
}
.cc-calendar-detail ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-calendar-detail li { display: flex; flex-wrap: wrap; gap: var(--cc-space-xxs) var(--cc-space-sm); align-items: baseline; }

.cc-image { margin: 0; display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-xs); }
.cc-image img { max-width: 100%; height: auto; border-radius: var(--cc-radius-badge); border: 1px solid var(--cc-border); background: var(--cc-elevated); }

/*
 * Pictures in numbers, and moving pictures.
 *
 * The gallery decides its own columns from the space it has, because a fixed column count is wrong at exactly
 * one width. The carousel puts its controls below the picture rather than over it: a control that covers part
 * of the thing it steps through hides the thing being looked at.
 */
.cc-gallery {
  display: grid; gap: var(--cc-space-md); margin: 0; padding: 0; list-style: none;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
}
.cc-gallery img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; }
.cc-carousel { display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-carousel-controls { display: flex; align-items: center; justify-content: center; gap: var(--cc-space-md); }
.cc-carousel-controls button {
  background: var(--cc-elevated); border: 1px solid var(--cc-border); color: inherit; cursor: pointer; font: inherit;
  border-radius: var(--cc-radius-pill); width: 32px; height: 32px; line-height: 1;
  transition-property: transform; transition-duration: var(--cc-motion-micro); transition-timing-function: var(--cc-motion-bounce);
}
.cc-carousel-controls button:hover { border-color: var(--cc-accent); }
.cc-carousel-controls button:active { transform: scale(0.94); }
.cc-embed { position: relative; aspect-ratio: 16 / 9; }
.cc-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: var(--cc-radius-card); }
.cc-video video { width: 100%; display: block; border-radius: var(--cc-radius-card); }

.cc-cta {
  display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-md);
  border: 1px solid var(--cc-border); background: var(--cc-elevated);
  border-radius: var(--cc-radius-badge); padding: var(--cc-space-sm) var(--cc-space-md);
}
.cc-cta p { margin: 0; }
.cc-cta > div { display: flex; flex-direction: column; gap: var(--cc-space-xxs); min-width: 0; }
.cc-cta > .cc-action { flex: none; }
@media (max-width: 480px) {
  .cc-cta { flex-direction: column; align-items: stretch; }
}

/* The live view of a pinned instance, and the notice when another surface holds it. */
.cc-live-surface { display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-live-surface[data-ownership="elsewhere"] { opacity: 0.9; }
.cc-live-surface[data-ownership="owner"] .cc-surface-region { border-left: 2px solid transparent; }

/*
 * The settings controls, one shape per kind of decision.
 *
 * Each wraps its own note rather than putting it in a tooltip: a control whose meaning is only visible on
 * hover is a control most people never understand. The pending state is a dimming rather than a spinner,
 * because the write is fast and a spinner appearing for a keystroke is noise.
 */
.cc-segmented-wrap { display: flex; flex-direction: column; gap: var(--cc-space-xxs); align-items: flex-end; }
.cc-segmented { display: flex; flex-wrap: wrap; gap: var(--cc-space-xs); justify-content: flex-end; }
.cc-segmented[data-pending="true"] { opacity: 0.6; }
/* The note belongs to the whole group, so it is aligned with the controls rather than with the label. */
.cc-segmented-wrap > .cc-panel-note { margin: 0; text-align: right; max-width: 34ch; }

.cc-toggle-wrap { display: flex; flex-direction: column; gap: var(--cc-space-xxs); align-items: flex-end; }
/*
 * Positioned, so the visually-hidden input inside it is placed against this label.
 *
 * Without it the absolute input resolves against the nearest positioned ancestor — the modal — and lands
 * somewhere else on the page entirely. The control still worked with a mouse, which is why this survived a
 * screenshot: what broke was its position for assistive technology and for anything that had to reach it,
 * and the first thing to notice was a browser test that refused to click an element outside the viewport.
 */
.cc-toggle { position: relative; display: flex; align-items: center; gap: var(--cc-space-sm); cursor: pointer; }
.cc-toggle input {
  /* The real checkbox stays in the layout for keyboard and screen-reader behaviour, and is hidden visually
     rather than with display:none, which would take it out of the tab order. */
  position: absolute; width: 1px; height: 1px; opacity: 0; margin: 0;
}
.cc-toggle-track {
  width: 38px; height: 22px; border-radius: var(--cc-radius-pill);
  background: var(--cc-card); border: 1px solid var(--cc-border); position: relative;
  transition: background var(--cc-motion-micro) var(--cc-motion-easing), border-color var(--cc-motion-micro) var(--cc-motion-easing);
}
.cc-toggle-track::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: var(--cc-radius-pill); background: var(--cc-text-muted);
  transition: transform var(--cc-motion-micro) var(--cc-motion-bounce), background var(--cc-motion-micro) var(--cc-motion-easing);
}
.cc-toggle input:checked + .cc-toggle-track { background: color-mix(in oklab, var(--cc-accent) 30%, transparent); border-color: var(--cc-accent); }
.cc-toggle input:checked + .cc-toggle-track::after { transform: translateX(16px); background: var(--cc-accent); }
.cc-toggle input:disabled + .cc-toggle-track { opacity: 0.45; }
.cc-toggle input:focus-visible + .cc-toggle-track { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
/* A word beside the switch, so the state does not depend on the knob's position or on a colour. */
.cc-toggle-state { font-size: var(--cc-text-label); color: var(--cc-text-muted); min-width: 2.4ch; }
.cc-toggle-wrap > .cc-panel-note { margin: 0; text-align: right; max-width: 34ch; }

.cc-inline-status[data-tone="error"] { color: var(--cc-danger); }
.cc-inline-status[data-tone="ok"] { color: var(--cc-success); }

.cc-range { display: flex; flex-direction: column; gap: var(--cc-space-xxs); align-items: flex-end; min-width: 200px; }
.cc-range-row { display: flex; align-items: center; gap: var(--cc-space-sm); width: 100%; }
.cc-range input[type="range"] { flex: 1; accent-color: var(--cc-accent); min-width: 110px; }
/* Narrow, because the number is a value to confirm rather than a field to type a sentence into. */
.cc-range input[type="number"] {
  width: 72px; padding: var(--cc-space-xxs) var(--cc-space-xs);
  background: var(--cc-card); color: var(--cc-text); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-badge); font: inherit; font-variant-numeric: tabular-nums;
}
.cc-range input[type="number"]:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 1px; }
.cc-range > .cc-setting-desc { align-self: flex-end; }

/*
 * The orb preview: one live renderer, not a grid of them.
 *
 * A WebGL context per preset would be a GPU program each for a difference the label already states. The
 * selected preset feeds this one canvas, and the stage behind it carries the palette so a machine without
 * WebGL still shows the colours that were chosen.
 */
.cc-orb-preview { display: flex; align-items: center; gap: var(--cc-space-md); padding: var(--cc-space-sm) 0; }
.cc-orb-preview-stage {
  width: 96px; height: 96px; flex: none; border-radius: var(--cc-radius-pill);
  display: flex; align-items: center; justify-content: center;
  background: var(--cc-card); border: 1px solid var(--cc-border);
}
.cc-orb-preview-canvas { display: block; }

.cc-effect-list { list-style: none; margin: var(--cc-space-sm) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-effect-list li { font-size: var(--cc-text-label); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-effect-list code { color: var(--cc-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); }

/*
 * The personal-instructions field.
 *
 * A textarea rather than a single-line input, because the text is prose the user is writing about how they
 * want to be answered. Disabled while the toggle is off but still visible, so turning it off does not look
 * like it discarded what was typed.
 */
.cc-personal-instructions {
  width: 100%; min-height: 92px; resize: vertical; padding: var(--cc-space-sm);
  background: var(--cc-card); color: var(--cc-text); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-badge); font: inherit; line-height: var(--cc-leading-body-sm);
}
.cc-personal-instructions:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 1px; }
.cc-personal-instructions:disabled { opacity: 0.55; cursor: not-allowed; }
/* Over the bound is a state worth seeing before the node refuses the write, not a silent failure. */
.cc-panel-note[data-over-bound="true"] { color: var(--cc-danger); }

@media (prefers-reduced-motion: reduce) {
  .cc-scroll { scroll-behavior: auto; }
  * { transition-duration: var(--cc-motion-micro) !important; animation-duration: var(--cc-motion-micro) !important; }
  /*
   * Two animations are turned off rather than shortened, because shortening does not mean the same
   * thing for an animation that never ends: an infinite loop at zero duration is not a still frame,
   * it is a value being recomputed for every frame of the rest of the session.
   */
  .cc-composer-glow::before { animation: none !important; }
  .cc-thinking-dot { animation: none !important; opacity: 0.7; }
  .cc-caret { animation: none !important; }
  /* A running tool would otherwise be a ring spinning with a zero-duration animation: not a still
     frame, but a value recomputed for every frame of the session. */
  .cc-tool-mark[data-status="running"] { animation: none !important; }
}

  /*
   * The desktop window's own chrome.
   *
   * A frameless window is dragged by its document, so the strip is the drag handle - and the controls opt out
   * of it, because a button inside a drag region cannot be clicked. In a browser none of this renders at all.
   */
  .cc-desktop-chrome { position: fixed; top: 0; left: 0; right: 0; height: 34px; display: flex; align-items: center; gap: 6px; z-index: 30; }
  .cc-desktop-drag { flex: 1 1 auto; height: 100%; -webkit-app-region: drag; }
  .cc-desktop-controls { display: flex; align-items: center; gap: 2px; -webkit-app-region: no-drag; }
  .cc-desktop-button { -webkit-app-region: no-drag; background: transparent; color: inherit; border: 1px solid var(--cc-line, rgba(255, 255, 255, 0.16)); border-radius: 6px; width: 26px; height: 22px; line-height: 1; font-size: 12px; cursor: pointer; }
  .cc-desktop-button:hover { border-color: var(--cc-accent, #7aa2f7); }
  .cc-desktop-button[data-pinned="true"] { border-color: var(--cc-accent, #7aa2f7); }
  .cc-desktop-mode { -webkit-app-region: no-drag; font-size: 11px; opacity: 0.72; padding-right: 6px; }
  .cc-desktop-problem { -webkit-app-region: no-drag; font-size: 11px; padding-right: 6px; opacity: 0.9; }

  /*
   * The compact surface: what the window shows when it has shrunk to the voice bar.
   *
   * The conversation is not unmounted - the session behind it keeps running, which is the whole point - so this
   * takes the window and hides what is underneath rather than removing it.
   */
  [data-compact="true"] .cc-voice-scrim { position: fixed; inset: 0; border-radius: 0; background: var(--cc-bg, #0d1117); }
/* ------------------------------------------------------------------ *
 * Widget Library
 * ------------------------------------------------------------------ */

/*
 * A full-screen utility surface over the conversation. The scrim is above the settings panel's, because
 * the library is the only dialog open while it is up: the settings panel closes itself before this opens,
 * since Modal's Escape handler is document-level and would otherwise close both.
 */
.cc-widget-library-scrim { position: fixed; inset: 0; background: color-mix(in oklab, var(--cc-code) 78%, transparent); z-index: 80; }
.cc-widget-library {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(1100px, calc(100vw - 24px)); max-height: calc(100vh - 32px);
  display: flex; flex-direction: column;
  background: var(--cc-elevated); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-modal);
  box-shadow: 0 24px 64px color-mix(in oklab, var(--cc-code) 70%, transparent);
  z-index: 81; overflow: hidden;
  animation: cc-panel-in var(--cc-motion-panel) var(--cc-motion-easing);
}
.cc-widget-library:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-widget-library-head { display: flex; align-items: center; gap: var(--cc-space-md); padding: var(--cc-space-lg); border-bottom: 1px solid var(--cc-border); }
.cc-widget-library-head h2 { margin: 0; font-size: var(--cc-text-heading-md); line-height: var(--cc-leading-heading-md); }
.cc-widget-library-head-left { display: flex; align-items: center; gap: var(--cc-space-sm); }
.cc-widget-library-search { flex: 1; min-width: 0; }
.cc-widget-library-facets { display: flex; flex-wrap: wrap; gap: var(--cc-space-xs); padding: var(--cc-space-sm) var(--cc-space-lg); border-bottom: 1px solid var(--cc-border); }
.cc-widget-library-facet { cursor: pointer; font: inherit; padding: var(--cc-space-xs) var(--cc-space-sm); border-radius: var(--cc-radius-button); border: 1px solid var(--cc-border); background: transparent; color: inherit; }
.cc-widget-library-facet[data-selected="true"] { border-color: var(--cc-accent); }
.cc-widget-library-body { overflow-y: auto; padding: var(--cc-space-lg); }
.cc-widget-library-empty { margin: 0; color: var(--cc-text-muted); }
.cc-library-builtin h3, .cc-library-provenance h3 { margin: 0 0 var(--cc-space-sm); font-weight: 600; }
/* Installed packages are separated from the built-in catalog by a rule, so the two lists read as two
   different claims rather than one mixed list. */
.cc-library-provenance { margin-top: var(--cc-space-lg); padding-top: var(--cc-space-lg); border-top: 1px solid var(--cc-border); }
.cc-provenance-retry { display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-sm); }
.cc-provenance-retry button { cursor: pointer; font: inherit; padding: var(--cc-space-xs) var(--cc-space-sm); border-radius: var(--cc-radius-button); border: 1px solid var(--cc-border); background: transparent; color: inherit; }
.cc-provenance-retry button:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
/* Uninstall, roll back and restore sit under the facts they act on, as plain buttons: a pill would read as a suggestion. */
.cc-package-actions { display: flex; flex-wrap: wrap; gap: var(--cc-space-sm); margin-top: var(--cc-space-sm); }
.cc-package-actions button { cursor: pointer; font: inherit; padding: var(--cc-space-xs) var(--cc-space-sm); border-radius: var(--cc-radius-button); border: 1px solid var(--cc-border); background: transparent; color: inherit; transition: border-color var(--cc-motion-micro) var(--cc-motion-easing); }
.cc-package-actions button:hover:not(:disabled) { border-color: var(--cc-accent); }
.cc-package-actions button:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-package-actions button:disabled { opacity: 0.45; cursor: default; }
.cc-panel-note[data-package-status="failed"], .cc-panel-note[data-capability-status="failed"] { color: var(--cc-danger); }
/* What could not be shown from an installed package, kept beside the installed list rather than inside the grid. */
.cc-library-notes { margin-top: var(--cc-space-lg); padding-top: var(--cc-space-lg); border-top: 1px solid var(--cc-border); }
.cc-library-notes h3 { margin: 0 0 var(--cc-space-sm); font-weight: 600; }
.cc-library-notes ul { margin: 0; padding-left: var(--cc-space-lg); color: var(--cc-text-muted); }
.cc-widget-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--cc-space-md); grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.cc-widget-card { margin: 0; }
.cc-widget-card-btn { display: flex; flex-direction: column; gap: var(--cc-space-sm); width: 100%; text-align: left; cursor: pointer; font: inherit; color: inherit; padding: var(--cc-space-md); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-card); background: transparent; }
.cc-widget-card-btn:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-widget-card-preview { display: block; min-height: 96px; overflow: hidden; }
.cc-widget-card-text { display: block; color: var(--cc-text-muted); }
.cc-widget-card-meta { display: flex; flex-direction: column; gap: var(--cc-space-xxs); }
.cc-widget-card-name { font-weight: 600; }
.cc-widget-card-family { color: var(--cc-text-muted); }
.cc-widget-card-desc { color: var(--cc-text-muted); }
.cc-widget-card-source { color: var(--cc-text-muted); font-size: var(--cc-text-label); }
.cc-widget-preview { display: block; }
.cc-widget-preview-missing { margin: 0; color: var(--cc-text-muted); }
.cc-widget-detail { display: flex; flex-direction: column; gap: var(--cc-space-lg); }
.cc-widget-detail-meta { display: grid; grid-template-columns: max-content 1fr; gap: var(--cc-space-xxs) var(--cc-space-md); margin: 0; }
.cc-widget-detail-meta dt { color: var(--cc-text-muted); }
.cc-widget-detail-meta dd { margin: 0; }

/* A 320 px viewport is a supported width, not a degraded one: one column, and the surface still fits. */
@media (max-width: 520px) {
  .cc-widget-library { width: calc(100vw - 12px); max-height: calc(100vh - 16px); }
  .cc-widget-grid { grid-template-columns: 1fr; }
  .cc-widget-library-head { flex-wrap: wrap; }
}

/* ------------------------------------------------------------------ *
 * Widget Lab (developer mode)
 * ------------------------------------------------------------------ */

.cc-widget-lab-controls { display: flex; flex-wrap: wrap; gap: var(--cc-space-md); align-items: flex-end; }
.cc-widget-lab-control { display: flex; flex-direction: column; gap: var(--cc-space-xxs); }
.cc-widget-lab-check { flex-direction: row; align-items: center; gap: var(--cc-space-xs); }
.cc-widget-detail-preview { display: flex; flex-direction: column; gap: var(--cc-space-md); min-width: 0; }
.cc-widget-detail-inspector { display: flex; flex-direction: column; gap: var(--cc-space-md); min-width: 0; }
.cc-widget-preview-frame { border: 1px solid var(--cc-border); border-radius: var(--cc-radius-card); padding: var(--cc-space-sm); overflow: auto; background: var(--cc-window); color: var(--cc-text); }
.cc-widget-inspector { display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-widget-inspector-panel { border: 1px solid var(--cc-border); border-radius: var(--cc-radius-button); padding: var(--cc-space-sm); }
.cc-widget-inspector-panel summary { cursor: pointer; font-weight: 600; }
.cc-widget-inspector-rows { display: flex; flex-direction: column; gap: var(--cc-space-xxs); margin: var(--cc-space-xs) 0 0; }
.cc-widget-inspector-row { display: grid; grid-template-columns: max-content 1fr; gap: var(--cc-space-sm); }
.cc-widget-inspector-row dt { color: var(--cc-text-muted); }
.cc-widget-inspector-row dd { margin: 0; overflow-wrap: anywhere; }
.cc-widget-props { display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-widget-props-raw textarea { width: 100%; min-height: 120px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.cc-widget-props-problems { margin: 0; padding-left: var(--cc-space-lg); color: var(--cc-danger, var(--cc-text)); }

/*
 * Wide screens show the preview and the inspector together; narrow ones step between them, because
 * three compressed columns at 320 px is a layout nobody can read.
 */
@media (min-width: 901px) {
  .cc-widget-lab-pane-toggle { display: none; }
  .cc-widget-detail { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: var(--cc-space-lg); }
  .cc-widget-lab-controls { grid-column: 1 / -1; }
}
@media (max-width: 900px) {
  .cc-widget-detail[data-widget-lab-pane="preview"] .cc-widget-detail-inspector { display: none; }
  .cc-widget-detail[data-widget-lab-pane="inspector"] .cc-widget-detail-preview { display: none; }
  .cc-widget-detail { display: flex; flex-direction: column; gap: var(--cc-space-lg); }
}
/* ------------------------------------------------------------------ *
 * Settings: layout polish
 * ------------------------------------------------------------------ */

/*
 * A segmented control is one object with a choice inside it, so it gets a track and the choice is a filled
 * segment. It used to be a row of loose pills with the focus ring standing in for "selected", which made a
 * keyboard user unable to tell where focus was from what was chosen. The fill, the border and the weight carry
 * the state together, so it does not rest on the accent colour alone; focus keeps its own outline.
 */
.cc-segmented {
  gap: var(--cc-space-xxs); padding: var(--cc-space-xxs);
  background: var(--cc-window); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-button);
}
.cc-segmented > .cc-badge {
  cursor: pointer; font: inherit; font-size: var(--cc-text-label); line-height: var(--cc-leading-label);
  min-height: 28px; padding: var(--cc-space-xs) var(--cc-space-md);
  background: transparent; border-color: transparent; border-radius: var(--cc-radius-badge);
  color: var(--cc-text-muted);
  transition: background-color var(--cc-motion-micro) var(--cc-motion-easing), color var(--cc-motion-micro) var(--cc-motion-easing), border-color var(--cc-motion-micro) var(--cc-motion-easing);
}
.cc-segmented > .cc-badge:hover { color: var(--cc-text); }
.cc-segmented > .cc-badge[data-selected="true"] {
  outline: none; font-weight: 600; color: var(--cc-text);
  background: color-mix(in oklab, var(--cc-accent) 18%, var(--cc-elevated));
  border-color: color-mix(in oklab, var(--cc-accent) 55%, transparent);
}
.cc-segmented > .cc-badge:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }

/*
 * Buttons inside a settings form start where the fields start. The chip row is centred for the hero's starting
 * chips; in a form that left "Save" floating in the middle, detached from the fields it saves, and the chips were
 * sized for two lines of text rather than one verb.
 */
.cc-tabpanel .cc-chip-row { justify-content: flex-start; }
.cc-tabpanel .cc-chip-row > .cc-chip { padding: var(--cc-space-xs) var(--cc-space-lg); }
.cc-tabpanel .cc-chip:disabled { opacity: 0.45; cursor: default; border-color: var(--cc-border); }

/* A wide table scrolls inside its own box instead of widening the dialog. */
.cc-table-scroll { overflow-x: auto; max-width: 100%; }
.cc-model-pool { width: 100%; border-collapse: collapse; font-size: var(--cc-text-label); font-variant-numeric: tabular-nums; }
.cc-model-pool th, .cc-model-pool td { text-align: left; padding: var(--cc-space-xs) var(--cc-space-sm); border-bottom: 1px solid var(--cc-border); white-space: nowrap; }
.cc-model-pool th { color: var(--cc-text-muted); font-weight: 500; }

/* The guarded categories are a list of checkboxes; they wrap as a group instead of pushing past the edge. */
.cc-guard-classes { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--cc-space-xs) var(--cc-space-md); }
.cc-guard-classes label { display: inline-flex; align-items: center; gap: var(--cc-space-xs); cursor: pointer; font-size: var(--cc-text-label); color: var(--cc-text); }
.cc-guard-classes input { accent-color: var(--cc-accent); margin: 0; }

/* A definition list's value may be a path or an id; it wraps rather than pushing the column off the page. */
.cc-fields { grid-template-columns: max-content minmax(0, 1fr); }
.cc-fields dd { min-width: 0; overflow-wrap: anywhere; }

/* In this layer rather than beside .cc-setup-card, because the voice layer's .cc-chip padding comes later and wins. */
.cc-setup-card > .cc-chip { padding: var(--cc-space-xs) var(--cc-space-lg); }

/*
 * A free-text setting takes the width the row gives it and looks like the other prose fields, rather than the
 * browser's default box at its intrinsic twenty columns.
 */
.cc-setting-control > textarea {
  width: 100%; min-width: 16rem; min-height: 92px; resize: vertical; padding: var(--cc-space-sm);
  background: var(--cc-card); color: var(--cc-text); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-badge); font: inherit; line-height: var(--cc-leading-body-sm);
}

/*
 * Narrow windows stack a setting: label and description on top, the control under them at full width. Side by
 * side at 375 px, the label column was squeezed to one word per line while the control ran off the edge.
 */
@media (max-width: 560px) {
  .cc-setting-row { flex-direction: column; align-items: stretch; gap: var(--cc-space-sm); }
  .cc-setting-control { flex: initial; flex-wrap: wrap; justify-content: flex-start; }
  .cc-segmented-wrap, .cc-toggle-wrap, .cc-range { align-items: flex-start; }
  .cc-segmented { justify-content: flex-start; }
  .cc-segmented-wrap > .cc-panel-note, .cc-toggle-wrap > .cc-panel-note { text-align: left; max-width: none; }
  .cc-range { min-width: 0; width: 100%; }
  .cc-range > .cc-setting-desc { align-self: flex-start; }
  .cc-guard-classes { justify-content: flex-start; }
  .cc-setting-control > textarea { min-width: 0; }
}

/*
 * The tab strip scrolls once the dialog is narrower than its 640 px, which happens below a viewport of 640 px
 * plus the dialog's 16 px gutters, not only at the stacking breakpoint above. Its scrollbar is hidden, so the
 * right edge fades to say there is more. The end padding and scroll padding are as wide as the fade, so the
 * last tab, or the selected one scrolled into view, stops clear of it instead of sitting half-hidden.
 */
@media (max-width: 672px) {
  .cc-tabs {
    mask-image: linear-gradient(to right, #000 calc(100% - var(--cc-space-xl)), transparent);
    padding-inline-end: var(--cc-space-xl);
    scroll-padding-inline-end: var(--cc-space-xl);
  }
}

/*
 * Touch. A 28 px circle is a fine target for a mouse and a miss for a thumb, so on a coarse pointer the icon
 * buttons and segments grow to the 44 px the accessibility section asks of primary touch controls. The visible
 * shape grows with them, because an invisible hit area around a small glyph is a target nobody can aim at.
 */
@media (pointer: coarse) {
  .cc-icon-btn { width: 44px; height: 44px; }
  /* button.cc-chip, because an attachment chip is an <li> whose control is its remove button, not the chip. */
  .cc-segmented > .cc-badge, .cc-tab, button.cc-chip { min-height: 44px; }
  .cc-chip-remove { min-width: 44px; min-height: 44px; }
}
}
`;
