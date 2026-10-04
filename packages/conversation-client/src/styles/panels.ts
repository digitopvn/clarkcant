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
.cc-evidence { display: flex; gap: var(--cc-space-sm); align-items: baseline; font-size: var(--cc-text-label); }
/* The verdict carries the colour; the sentence beside it stays in the reading tone, so a good result is quiet. */
.cc-evidence[data-verdict="not-verified"] .cc-evidence-verdict { color: var(--cc-warning); }
.cc-evidence[data-verdict="contradicted"] .cc-evidence-verdict { color: var(--cc-danger); }
.cc-evidence[data-verdict="verified"] .cc-evidence-verdict { color: color-mix(in oklab, var(--cc-success) 75%, var(--cc-text-muted)); }

/* Focus: never removed, only restyled. Keyboard users must be able to see where they are. */
:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; border-radius: var(--cc-radius-badge); }
button:focus-visible, textarea:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
/* A code or diff scroll fills a card that clips whatever overflows it, so its ring is drawn inside the scroll. It is
   here, after the rule above, because this layer comes last and an outer ring from above would be cut off. */
.cc-viewer-scroll:focus-visible { outline-offset: -2px; }
/* The composer's field draws its focus on the pill around it (see the composer layer), not as a rectangle inside a
   stadium. Restated here because this layer comes last and the rule above would otherwise put the rectangle back. */
.cc-composer textarea:focus-visible { outline: none; }

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
  background: var(--cc-elevated); border-left: var(--cc-line, 1px solid) var(--cc-border);
  box-shadow: var(--cc-shadow-drawer, -8px 0 32px color-mix(in oklab, var(--cc-code) 60%, transparent));
  animation: cc-panel-in var(--cc-motion-panel) var(--cc-motion-easing);
}
@keyframes cc-panel-in { from { transform: translateX(100%); } to { transform: none; } }
.cc-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--cc-space-md) var(--cc-space-lg); border-bottom: var(--cc-line, 1px solid) var(--cc-border);
}
.cc-panel-head h2 { font-family: var(--cc-font-display, "Plus Jakarta Sans Variable", ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif); font-size: var(--cc-text-heading-md); line-height: var(--cc-leading-heading-md); margin: 0; }
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
  padding: var(--cc-space-md) 0; border-bottom: var(--cc-line, 1px solid) var(--cc-border);
}
.cc-setting-row:last-of-type { border-bottom: none; }
.cc-setting-row[data-state="blocked"] .cc-setting-label { color: var(--cc-warning); }
.cc-setting-row[data-state="absent"] .cc-setting-label { color: var(--cc-text-tertiary); }
.cc-setting-text { display: flex; flex-direction: column; gap: var(--cc-space-xxs); min-width: 0; }
.cc-setting-label { color: var(--cc-text); font-size: var(--cc-text-body-sm); line-height: var(--cc-leading-body-sm); font-weight: 600; }
.cc-setting-desc { color: var(--cc-text-muted); font-size: var(--cc-text-label); line-height: var(--cc-leading-label); }
.cc-setting-control { flex: none; display: flex; align-items: center; gap: var(--cc-space-sm); color: var(--cc-text-muted); }
/*
 * A stacked row: label and description on top at full width, the control under them at full width, at every
 * width. For a control too wide to sit beside the text, which would otherwise squeeze the description into a
 * column a few words wide.
 */
.cc-setting-row[data-layout="stacked"] { flex-direction: column; align-items: stretch; gap: var(--cc-space-sm); }
.cc-setting-row[data-layout="stacked"] > .cc-setting-control { flex: initial; display: block; }
/* A plain value in the control column, such as a date, at the size of the row text beside it rather than the reply size. */
.cc-setting-control > time { font-size: var(--cc-text-body-sm); line-height: var(--cc-leading-body-sm); }
.cc-setting-control code { font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm); color: var(--cc-text-muted); overflow-wrap: anywhere; }

/* A capability, with its real readiness. The reason is shown whenever there is one. */
.cc-tool-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--cc-space-md);
  padding: var(--cc-space-sm) 0; border-bottom: var(--cc-line, 1px solid) var(--cc-border);
}
.cc-tool-row:last-of-type { border-bottom: none; }
.cc-tool-row code { font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm); color: var(--cc-text); }
.cc-tool-blocked { color: var(--cc-text-muted); }
.cc-tool-why { margin-top: var(--cc-space-xxs); font-size: var(--cc-text-label); }
.cc-tool-why > summary { cursor: pointer; width: fit-content; color: var(--cc-text-tertiary); }
.cc-tool-why > summary:hover { color: var(--cc-text); }
.cc-tool-why[open] > summary { margin-bottom: var(--cc-space-xxs); }
.cc-memory-empty > p { margin: 0; }
/* The tool lists: a subgroup heading in sentence case under the section's capitals, then one row per tool. */
.cc-tool-list-heading {
  margin: var(--cc-space-md) 0 var(--cc-space-xs); font-size: var(--cc-text-body-sm); font-weight: 600; color: var(--cc-text);
}
.cc-tool-list-heading:first-child { margin-top: 0; }
.cc-tool-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.cc-tool-list > li {
  display: flex; flex-wrap: wrap; align-items: baseline; column-gap: var(--cc-space-sm);
  padding: var(--cc-space-xs) 0; border-top: var(--cc-line, 1px solid) var(--cc-border);
}
.cc-tool-list > li:first-child { border-top: 0; }
.cc-tool-list > li > code { font-size: var(--cc-text-label); color: var(--cc-text-tertiary); }
.cc-tool-list > li > .cc-tool-why { flex-basis: 100%; }
.cc-tool-list .cc-tool-why .cc-panel-note { margin: 0; }
/* One tag per extension: names set inline with nothing between them run together into one unreadable word. */
.cc-pi-extensions { gap: var(--cc-space-xs); }
/* pi's settings: one key and value per line, as the node reports them. */
.cc-pi-settings { display: flex; flex-direction: column; gap: var(--cc-space-xxs); margin-top: var(--cc-space-sm); }
.cc-pi-settings > code { overflow-wrap: anywhere; }
.cc-pi-extensions > code {
  font-size: var(--cc-text-label); color: var(--cc-text-muted); padding: 2px var(--cc-space-xs);
  border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-badge); overflow-wrap: anywhere;
}
.cc-panel-note { margin: var(--cc-space-sm) 0 0; font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-badge[data-selected="true"], .cc-swatch[aria-pressed="true"] {
  outline: 2px solid var(--cc-focus); outline-offset: 2px;
}
.cc-swatch { width: 32px; height: 32px; border-radius: var(--cc-radius-pill); border: var(--cc-line, 1px solid) var(--cc-border); cursor: pointer; padding: 0; }
.cc-panel-readout { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-panel-readout li {
  display: flex; justify-content: space-between; gap: var(--cc-space-sm);
  font-size: var(--cc-text-label); color: var(--cc-text-muted);
  font-variant-numeric: tabular-nums;
}
.cc-panel-readout li[data-pass="false"] { color: var(--cc-danger); }
.cc-specimen { margin: 0; padding: var(--cc-space-sm) 0; border-bottom: var(--cc-line, 1px solid) var(--cc-border); color: var(--cc-text); }
.cc-specimen-token { display: block; font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-meta); line-height: var(--cc-leading-meta); color: var(--cc-text-tertiary); margin-top: var(--cc-space-xxs); }
.cc-radius-demo {
  width: 86px; height: 62px; display: flex; flex-direction: column; justify-content: center; gap: var(--cc-space-xxs);
  padding: var(--cc-space-xs); background: var(--cc-card); border: var(--cc-line, 1px solid) var(--cc-border);
  font-size: var(--cc-text-meta); color: var(--cc-text-tertiary);
}
.cc-radius-demo code { color: var(--cc-text); font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-meta); }
.cc-panel-space { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-panel-space li { display: flex; align-items: center; gap: var(--cc-space-sm); font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-panel-space code { width: 3rem; color: var(--cc-text); font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-meta); }
.cc-space-bar { height: 10px; min-width: 2px; background: var(--cc-accent); border-radius: var(--cc-radius-badge); flex: none; }
.cc-space-value { color: var(--cc-text-tertiary); font-variant-numeric: tabular-nums; }

/* ------------------------------------------------------------------ *
 * Composed surface
 *
 * One container, several leaf regions. The grid is the only layout the container performs: each
 * region is an ordinary card, so a leaf that fails still leaves the rest of the surface readable.
 * ------------------------------------------------------------------ */
/* A figure element, so without this the browser's own 40px a side indents it from the reply it belongs to and takes the room
   a split or a grid needs for its columns. */
.cc-surface { padding: 0; margin: 0; }
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

/* ------------------------------------------------------------------ *
 * A surface arranged as a tree
 *
 * Sized by the surface's own width, not the window's: the conversation column is narrower than the
 * window whenever a panel is open, and a grid that measured the window would keep three columns in a
 * column that has room for one. Reading order is the tree's order at every width.
 * ------------------------------------------------------------------ */
.cc-layout { container-type: inline-size; display: flex; flex-direction: column; gap: var(--cc-space-md); min-width: 0; }
.cc-layout-stack, .cc-layout-row, .cc-layout-grid, .cc-layout-split, .cc-layout-tabs, .cc-layout-leaf {
  display: flex; flex-direction: column; gap: var(--cc-space-xs); min-width: 0;
}
.cc-layout-stack-body { display: flex; flex-direction: column; gap: var(--cc-space-md); min-width: 0; }
.cc-layout-row-body { display: flex; flex-wrap: wrap; gap: var(--cc-space-md); align-items: flex-start; min-width: 0; }
.cc-layout-row-body > * { flex: 1 1 220px; }
/* At most the columns the tree asked for, and never one narrower than a region can be read at: a three-column grid in
   a 650px conversation column is two columns, and one on a phone. */
.cc-layout-grid-body {
  --cc-layout-gap: var(--cc-space-md);
  display: grid; gap: var(--cc-layout-gap); align-items: start; min-width: 0;
  grid-template-columns: repeat(
    auto-fit,
    minmax(min(100%, max(220px, (100% - (var(--cc-layout-columns, 2) - 1) * var(--cc-layout-gap)) / var(--cc-layout-columns, 2))), 1fr)
  );
}
/* A leaf's card header lets its freshness badge move under a long title instead of squeezing the title to a word a line. */
.cc-layout .cc-card-head { flex-wrap: wrap; }
.cc-layout-split-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--cc-space-md); align-items: start; }
.cc-layout-label { font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-layout-card {
  display: flex; flex-direction: column; gap: var(--cc-space-sm); min-width: 0;
  border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-card); padding: var(--cc-space-md);
}
.cc-layout-card-title { margin: 0; font-size: var(--cc-text-body-sm); font-weight: 600; color: var(--cc-text); }
.cc-layout-tablist {
  display: flex; flex-wrap: nowrap; gap: var(--cc-space-md); border-bottom: var(--cc-line, 1px solid) var(--cc-border);
  overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none;
}
.cc-layout-tablist::-webkit-scrollbar { display: none; }
.cc-layout-tabpanel { padding-top: var(--cc-space-sm); min-width: 0; }
.cc-layout-tabpanel:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; border-radius: var(--cc-radius-badge); }
.cc-layout-collapsible { min-width: 0; }
/* The summary keeps a visible open/closed mark: a flex summary loses the browser's own disclosure triangle. */
.cc-layout-summary {
  cursor: pointer; min-height: 32px; display: flex; align-items: center; gap: var(--cc-space-xs); list-style: none;
  width: fit-content; padding-right: var(--cc-space-xs); font-size: var(--cc-text-body-sm); font-weight: 600; color: var(--cc-text);
}
.cc-layout-summary::-webkit-details-marker { display: none; }
.cc-layout-summary::before { content: "▸"; color: var(--cc-text-tertiary); font-size: var(--cc-text-meta); }
.cc-layout-collapsible[open] > .cc-layout-summary::before { content: "▾"; }
.cc-layout-summary:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; border-radius: var(--cc-radius-badge); }
.cc-layout-collapsible[open] > .cc-layout-summary { margin-bottom: var(--cc-space-sm); }
.cc-layout-divider { border: 0; border-top: var(--cc-line, 1px solid) var(--cc-border); margin: 0; width: 100%; }

@container (max-width: 560px) {
  .cc-layout-split-body { grid-template-columns: minmax(0, 1fr); }
}
.cc-metrics {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--cc-space-sm);
}
.cc-metric {
  display: flex; flex-direction: column; gap: var(--cc-space-xxs);
  border: var(--cc-line, 1px solid) var(--cc-border); background: var(--cc-elevated);
  border-radius: var(--cc-radius-badge); padding: var(--cc-space-sm);
}
.cc-metric-label { color: var(--cc-text-muted); font-size: var(--cc-text-label); }
.cc-metric-value { font-size: var(--cc-text-heading-md); font-weight: 600; font-variant-numeric: tabular-nums; }
.cc-metric-unit { color: var(--cc-text-muted); font-size: var(--cc-text-label); margin-left: var(--cc-space-xxs); }
.cc-metric-hint { color: var(--cc-text-tertiary); font-size: var(--cc-text-meta); }

.cc-filter { display: flex; flex-direction: column; gap: var(--cc-space-xxs); }
.cc-filter select {
  background: var(--cc-elevated); color: var(--cc-text); font: inherit;
  border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-badge); padding: var(--cc-space-xs) var(--cc-space-sm);
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
/*
 * Series sit side by side as lines, so the donut's lightness steps of one hue are too close to tell apart. Where the
 * browser can, each series turns the accent round the hue wheel instead, keeping its lightness so it stays readable on
 * the card in either theme; a grey accent is given enough chroma for the turn to show.
 */
@supports (color: oklch(from red l c h)) {
  .cc-chart [data-slice-tone="1"], .cc-xy-key[data-slice-tone="1"] { --cc-slice: oklch(from var(--cc-accent) l max(c, 0.12) calc(h + 240)); }
  .cc-chart [data-slice-tone="2"], .cc-xy-key[data-slice-tone="2"] { --cc-slice: oklch(from var(--cc-accent) l max(c, 0.12) calc(h + 75)); }
  .cc-chart [data-slice-tone="3"], .cc-xy-key[data-slice-tone="3"] { --cc-slice: oklch(from var(--cc-accent) l max(c, 0.12) calc(h + 150)); }
  .cc-chart [data-slice-tone="4"], .cc-xy-key[data-slice-tone="4"] { --cc-slice: oklch(from var(--cc-accent) l max(c, 0.12) calc(h + 300)); }
  .cc-chart [data-slice-tone="5"], .cc-xy-key[data-slice-tone="5"] { --cc-slice: oklch(from var(--cc-accent) l max(c, 0.12) calc(h + 35)); }
}
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
  border-top: var(--cc-line, 1px solid) var(--cc-border); padding-top: var(--cc-space-sm);
}
.cc-calendar-detail ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-calendar-detail li { display: flex; flex-wrap: wrap; gap: var(--cc-space-xxs) var(--cc-space-sm); align-items: baseline; }
.cc-calendar-detail li > .cc-calendar-event { flex: 1; }
/* The calendar measures its own width, so the week lays its days out as columns only where seven of them fit. */
.cc-calendar-root { container-type: inline-size; display: flex; flex-direction: column; gap: var(--cc-space-sm); min-width: 0; }
.cc-calendar-views { display: flex; flex-wrap: wrap; gap: var(--cc-space-xs); }
.cc-calendar-views button, .cc-calendar-week-nav button, .cc-calendar-clear {
  min-height: 32px; padding: 0 var(--cc-space-sm); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge);
  background: transparent; color: var(--cc-text); font: inherit; font-size: var(--cc-text-label); cursor: pointer;
}
.cc-calendar-views button[aria-pressed="true"] {
  border-color: var(--cc-accent); background: color-mix(in oklab, var(--cc-accent) 14%, var(--cc-card)); font-weight: 600;
}
.cc-calendar-week-nav button:disabled { opacity: 0.5; cursor: not-allowed; }
.cc-calendar-week-nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--cc-space-sm); }
.cc-calendar-week-label { font-size: var(--cc-text-label); color: var(--cc-text-muted); font-variant-numeric: tabular-nums; }
/* Today is ringed and underlined as well as tinted, and named in its label, so it is not told by colour alone. */
.cc-calendar td[data-today="true"] .cc-calendar-day { box-shadow: inset 0 0 0 2px var(--cc-text-muted); }
.cc-calendar td[data-today="true"] .cc-calendar-day > span:first-child {
  font-weight: 700; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px;
}
.cc-calendar-week { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: var(--cc-space-xxs); }
.cc-calendar-week-day {
  display: flex; flex-direction: column; gap: var(--cc-space-xxs); min-width: 0;
  padding: var(--cc-space-xxs); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge);
}
.cc-calendar-week-day[data-today="true"] { border-width: 2px; border-color: var(--cc-text-muted); }
.cc-calendar-week-head {
  display: flex; flex-direction: column; align-items: flex-start; gap: 0; min-width: 0; padding: 2px var(--cc-space-xxs);
  border: 1px solid transparent; border-radius: var(--cc-radius-badge); background: none; color: var(--cc-text);
  font: inherit; font-size: var(--cc-text-meta); text-align: left; cursor: pointer;
}
.cc-calendar-week-head:hover { background: var(--cc-elevated); }
.cc-calendar-week-head[aria-pressed="true"] {
  border-color: var(--cc-accent); background: color-mix(in oklab, var(--cc-accent) 12%, var(--cc-card)); font-weight: 600;
}
.cc-calendar-week-name { color: var(--cc-text-muted); }
.cc-calendar-week-date { font-variant-numeric: tabular-nums; }
.cc-calendar-today-tag { font-size: var(--cc-text-meta); font-weight: 700; }
.cc-calendar-events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cc-calendar-event {
  width: 100%; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 0;
  padding: 2px var(--cc-space-xs); border: 1px solid var(--cc-border); border-left: 3px solid var(--cc-accent);
  border-radius: var(--cc-radius-badge); background: var(--cc-elevated); color: var(--cc-text);
  font: inherit; font-size: var(--cc-text-meta); text-align: left; cursor: pointer;
}
/*
 * An all-day event is striped as well as labelled "all day", so it is told apart from a timed one without colour. The
 * stripes are faint and the text on them is the full text colour, not the muted one, so it keeps AA contrast on either
 * stripe whatever the accent.
 */
.cc-calendar-event[data-all-day="true"] {
  border-left-style: double; border-left-width: 4px;
  background: repeating-linear-gradient(135deg, color-mix(in oklab, var(--cc-accent) 8%, var(--cc-elevated)) 0 6px, var(--cc-elevated) 6px 12px);
}
.cc-calendar-event[aria-pressed="true"] {
  border-color: var(--cc-accent); box-shadow: inset 0 0 0 1px var(--cc-accent);
  background: color-mix(in oklab, var(--cc-accent) 18%, var(--cc-card)); font-weight: 600;
}
.cc-calendar-event-time, .cc-calendar-event-span { color: var(--cc-text-muted); font-variant-numeric: tabular-nums; }
.cc-calendar-event[data-all-day="true"] :is(.cc-calendar-event-time, .cc-calendar-event-span) { color: var(--cc-text); }
.cc-calendar-event-title { max-width: 100%; overflow-wrap: anywhere; }
.cc-calendar-empty { color: var(--cc-text-tertiary); font-size: var(--cc-text-meta); }
/* "Now" is a labelled line with a dot, not a tint: the time is written on it. */
.cc-calendar-now { display: flex; align-items: center; gap: var(--cc-space-xs); font-size: var(--cc-text-meta); font-weight: 600; color: var(--cc-danger); }
.cc-calendar-now::before { content: ""; width: 8px; height: 8px; flex: none; border-radius: 50%; background: currentColor; }
.cc-calendar-now::after { content: ""; flex: 1; min-width: 12px; border-top: 2px solid currentColor; }
/* The label never wraps: a wrapped label squeezes the line beside it to a stub. */
.cc-calendar-now > span { white-space: nowrap; }
.cc-calendar-agenda { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-calendar-agenda-day { display: grid; grid-template-columns: 7.5em minmax(0, 1fr); gap: var(--cc-space-sm); align-items: start; }
.cc-calendar-agenda-date { margin: 0; display: flex; flex-direction: column; font-size: var(--cc-text-label); font-variant-numeric: tabular-nums; }
.cc-calendar-event-detail {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-xxs); margin-top: var(--cc-space-xs);
  padding: var(--cc-space-sm); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge);
  background: var(--cc-elevated); overflow-wrap: anywhere;
}
@container (max-width: 560px) {
  .cc-calendar-week { grid-template-columns: minmax(0, 1fr); }
  .cc-calendar-week-label { order: -1; flex-basis: 100%; text-align: center; }
  .cc-calendar-week-head { flex-direction: row; flex-wrap: wrap; gap: var(--cc-space-sm); }
  .cc-calendar-agenda-day { grid-template-columns: minmax(0, 1fr); }
}

/*
 * The activity timeline. Each day heads its entries; each entry is one button with its time, a tone said by a symbol and
 * a word, its title and who did it, so a tone is never told by colour alone. The rail on the left is decoration. The
 * timeline measures its own width, so a narrow column stacks the time above the title instead of squeezing both.
 */
.cc-timeline-root { container-type: inline-size; display: flex; flex-direction: column; gap: var(--cc-space-sm); min-width: 0; }
.cc-timeline-summary { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.cc-timeline-days { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-md); }
.cc-timeline-day { display: flex; flex-direction: column; gap: var(--cc-space-xs); min-width: 0; }
.cc-timeline-day-head { margin: 0; font-size: var(--cc-text-label); font-weight: 600; color: var(--cc-text); }
.cc-timeline-entries {
  list-style: none; margin: 0; padding: 0 0 0 var(--cc-space-sm); display: flex; flex-direction: column; gap: var(--cc-space-xs);
  border-left: 2px solid var(--cc-border);
}
.cc-timeline-entry { display: flex; flex-direction: column; gap: var(--cc-space-xxs); min-width: 0; }
.cc-timeline-entry-button {
  width: 100%; min-width: 0; min-height: 40px; display: grid; grid-template-columns: auto 4.5em auto minmax(0, 1fr); align-items: center;
  gap: var(--cc-space-xxs) var(--cc-space-sm); padding: var(--cc-space-xs) var(--cc-space-sm);
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge); background: var(--cc-card); color: var(--cc-text);
  font: inherit; font-size: var(--cc-text-body-sm); text-align: left; cursor: pointer; transition: background-color var(--cc-motion-micro);
}
.cc-timeline-entry-button:hover { background: var(--cc-elevated); }
.cc-timeline-entry-button:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 1px; }
.cc-timeline-entry-button[aria-pressed="true"] {
  border-color: var(--cc-accent); box-shadow: inset 0 0 0 1px var(--cc-accent);
  background: color-mix(in oklab, var(--cc-accent) 14%, var(--cc-card));
}
/* An all-day entry says "All day" in words and draws its edge doubled, so it is told apart from a timed one without colour. */
.cc-timeline-entry-button[data-all-day="true"] { border-left: 4px double var(--cc-accent); }
.cc-timeline-mark {
  flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: var(--cc-radius-pill);
  font-size: var(--cc-text-label); font-weight: 700; color: var(--cc-text-muted); border: 1px solid var(--cc-border); background: var(--cc-elevated);
}
.cc-timeline-mark[data-tone="info"] { color: var(--cc-accent); border-color: color-mix(in oklab, var(--cc-accent) 45%, transparent); }
.cc-timeline-mark[data-tone="success"] { color: var(--cc-success); border-color: color-mix(in oklab, var(--cc-success) 45%, transparent); }
.cc-timeline-mark[data-tone="warning"] { color: var(--cc-warning); border-color: color-mix(in oklab, var(--cc-warning) 45%, transparent); }
.cc-timeline-mark[data-tone="danger"] { color: var(--cc-danger); border-color: color-mix(in oklab, var(--cc-danger) 45%, transparent); }
.cc-timeline-time { color: var(--cc-text-muted); font-size: var(--cc-text-label); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cc-timeline-tone { justify-self: start; }
.cc-timeline-entry-title { min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.cc-timeline-actor { grid-column: 2 / -1; min-width: 0; font-size: var(--cc-text-label); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-timeline-description { display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-xxs); padding-left: var(--cc-space-sm); }
.cc-timeline-description p {
  margin: 0; font-size: var(--cc-text-body-sm); color: var(--cc-text-muted); white-space: pre-line; overflow-wrap: anywhere; max-width: 100%;
}
.cc-timeline-fold, .cc-timeline-clear, .cc-timeline-pager button {
  min-height: 32px; padding: 0 var(--cc-space-sm); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge);
  background: transparent; color: var(--cc-text); font: inherit; font-size: var(--cc-text-label); cursor: pointer;
}
.cc-timeline-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--cc-space-sm); }
.cc-timeline-pager button:disabled { opacity: 0.5; cursor: not-allowed; }
.cc-timeline-pager span { font-variant-numeric: tabular-nums; }
.cc-timeline-detail {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-xxs);
  padding: var(--cc-space-sm); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge);
  background: var(--cc-elevated); font-size: var(--cc-text-label); overflow-wrap: anywhere; max-width: 100%;
}
.cc-timeline-text summary { cursor: pointer; font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-timeline-text ul { margin: var(--cc-space-xs) 0 0; padding-left: var(--cc-space-lg); font-size: var(--cc-text-label); }
.cc-timeline-text li { overflow-wrap: anywhere; }
@container (max-width: 480px) {
  .cc-timeline-entry-button { display: flex; flex-wrap: wrap; }
  .cc-timeline-entry-title, .cc-timeline-actor { flex: 1 1 100%; }
}
.cc-image { margin: 0; display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-xs); }
.cc-image img { max-width: 100%; height: auto; border-radius: var(--cc-radius-badge); border: var(--cc-line, 1px solid) var(--cc-border); background: var(--cc-elevated); }

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
.cc-gallery-select { display: block; width: 100%; padding: 0; color: inherit; text-align: left; background: transparent; border: 0; border-radius: var(--cc-radius-badge); cursor: pointer; }
/* The chosen picture is ringed with a shadow, so the keyboard focus outline stays visible on top of it. */
.cc-gallery-select[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--cc-accent); }
.cc-gallery img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; }
.cc-carousel { display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-carousel-controls { display: flex; align-items: center; justify-content: center; gap: var(--cc-space-md); }
.cc-carousel-controls button {
  background: var(--cc-elevated); border: var(--cc-line, 1px solid) var(--cc-border); color: inherit; cursor: pointer; font: inherit;
  border-radius: var(--cc-radius-pill); width: 32px; height: 32px; line-height: 1;
  transition-property: transform; transition-duration: var(--cc-motion-micro); transition-timing-function: var(--cc-motion-bounce);
}
.cc-carousel-controls button:hover { border-color: var(--cc-accent); }
.cc-carousel-controls button:active { transform: scale(0.94); }
.cc-embed { position: relative; aspect-ratio: 16 / 9; }
.cc-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: var(--cc-radius-card); }
.cc-video video { width: 100%; display: block; border-radius: var(--cc-radius-card); }
.cc-audio { margin: 0; display: flex; flex-direction: column; gap: var(--cc-space-xxs); }
.cc-audio audio { width: 100%; max-width: 100%; display: block; }
.cc-audio audio:focus-visible, .cc-video video:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
/* A player whose bytes are not read yet: its poster, the host's Play button, and the loading status once pressed. */
.cc-media-wait { display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-xs); }
.cc-media-wait [data-media-loading]:empty { margin: 0; }
/* A waiting video keeps the 16:9 box a player usually fills (as an embed does), so its arrival moves nothing below it. */
.cc-video.cc-media-wait { align-items: stretch; }
.cc-media-stage {
  position: relative; aspect-ratio: 16 / 9; width: 100%; display: grid; place-items: center;
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-card); overflow: hidden; background: var(--cc-card);
}
.cc-media-stage img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.cc-media-stage button { position: relative; }
.cc-audio-transcript summary { cursor: pointer; border-radius: var(--cc-radius-badge); }
.cc-audio-transcript summary:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-audio-transcript-text, .cc-document-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.cc-audio-transcript-text { max-block-size: min(16rem, 50vh); overflow: auto; padding-block-start: var(--cc-space-xs); }
.cc-document-head { display: flex; align-items: baseline; }
.cc-document-page {
  border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-badge);
  background: var(--cc-elevated); padding: var(--cc-space-sm);
}
.cc-document-nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--cc-space-sm); }
.cc-document-nav [data-document-position] { font-variant-numeric: tabular-nums; }
.cc-document-nav button[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }

.cc-cta {
  display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-md);
  border: var(--cc-line, 1px solid) var(--cc-border); background: var(--cc-elevated);
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
/*
 * The note belongs to the whole group, so it sits under the controls rather than under the label: as wide as the
 * row of choices and starting where they start. A note set flush right ran two or three ragged lines that were
 * hard to read from their first word. Containment keeps a long note from widening the column it explains, and the
 * minimum keeps it from becoming one word a line under a choice of two.
 */
.cc-segmented-wrap > .cc-panel-note { margin: 0; align-self: stretch; text-align: start; contain: inline-size; min-width: 20ch; }

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
  /* The off track is drawn as a recess with a visible edge: on a raised surface the plain card fill vanished,
     leaving a lone grey knob that read as a radio button. */
  background: color-mix(in oklab, var(--cc-text) 10%, var(--cc-card));
  border: var(--cc-line, 1px solid) color-mix(in oklab, var(--cc-text) 20%, var(--cc-border)); position: relative;
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
  background: var(--cc-card); color: var(--cc-text); border: var(--cc-line, 1px solid) var(--cc-border);
  border-radius: var(--cc-radius-badge); font: inherit; font-variant-numeric: tabular-nums;
}
.cc-range input[type="number"]:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 1px; }
.cc-range > .cc-setting-desc { align-self: flex-end; }

/*
 * The orb preview: one live renderer, not a grid of them.
 *
 * A WebGL context per preset would be a GPU program each for a difference a swatch already shows. The
 * selected preset feeds this one canvas. Without WebGL the canvas shows a still picture instead: the chosen
 * preset's own palette, set inline by the Orb, or the signature orb's gradient below for the shipped profile.
 */
.cc-orb-preview { display: flex; align-items: center; gap: var(--cc-space-md); padding: var(--cc-space-sm) 0; }
.cc-orb-preview-stage {
  width: 96px; height: 96px; flex: none; border-radius: var(--cc-radius-pill);
  display: flex; align-items: center; justify-content: center;
  background: var(--cc-card); border: var(--cc-line, 1px solid) var(--cc-border);
}
.cc-orb-preview-canvas { display: block; border-radius: var(--cc-radius-pill); }
.cc-orb-preview-canvas[data-orb="fallback"] {
  background:
    radial-gradient(ellipse 78% 11% at 50% 50%, #ffffff 0%, #ffd86b 22%, #82f4ff 40%, #ff7bd5 62%, #8e6cff 82%, transparent 100%),
    radial-gradient(circle at 50% 46%, #2a2350 0%, #161231 45%, #0b0a1c 100%);
}

/*
 * The preset list: a swatch and a name per preset, in equal columns under the row's label.
 *
 * A grid rather than a wrapping flex row, so that when the width does not hold every preset the rows line up
 * column for column from the left edge instead of the last row drifting to one side. auto-fit collapses the
 * columns nobody fills, so a width that holds all seven shares it between them in one row.
 *
 * Buttons rather than a radio group because each one is a single action that saves at once, the same as the
 * theme and motion controls. The selected one is marked by its border, its weight and aria-pressed together,
 * so the state never rests on colour alone. At least 44px tall, so a finger can hit one without its neighbour.
 */
.cc-orb-presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(64px, 1fr)); gap: var(--cc-space-xs); }
.cc-orb-preset {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--cc-space-xxs); min-width: 0; min-height: 44px; width: 100%;
  padding: var(--cc-space-xs) var(--cc-space-xxs);
  border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-badge);
  background: var(--cc-card); color: var(--cc-text-muted);
  font: inherit; font-size: var(--cc-text-label); cursor: pointer;
}
.cc-orb-preset:hover { color: var(--cc-text); border-color: color-mix(in oklab, var(--cc-text) 35%, var(--cc-border)); }
.cc-orb-preset[aria-pressed="true"] {
  color: var(--cc-text); font-weight: 600; border-color: var(--cc-accent);
  box-shadow: inset 0 0 0 1px var(--cc-accent);
  background: color-mix(in oklab, var(--cc-accent) 12%, var(--cc-card));
}
.cc-orb-preset:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-orb-preset-swatch {
  width: 28px; height: 28px; border-radius: var(--cc-radius-pill); flex: none;
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--cc-text) 14%, transparent);
}

/*
 * The theme list.
 *
 * One column of cards. A card is the choose button — name, description and trust lane, which is what a person decides
 * by — and, under it, a disclosure holding the package id, version and full digest. The disclosure is a sibling of the
 * button, not inside it: a button's content is not interactive. Everything may break anywhere, so a long package id or
 * digest never widens the panel on a phone.
 */
.cc-theme-options { display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-theme-option {
  display: flex; flex-direction: column; min-width: 0;
  border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-badge);
  background: var(--cc-card); color: var(--cc-text-muted); font-size: var(--cc-text-label);
}
.cc-theme-option:hover { border-color: color-mix(in oklab, var(--cc-text) 35%, var(--cc-border)); }
.cc-theme-option[data-selected="true"] {
  border-color: var(--cc-accent);
  box-shadow: inset 0 0 0 1px var(--cc-accent);
  background: color-mix(in oklab, var(--cc-accent) 12%, var(--cc-card));
}
.cc-theme-option-choose {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-xxs);
  min-width: 0; min-height: 44px; width: 100%; text-align: start;
  padding: var(--cc-space-sm); border: 0; border-radius: var(--cc-radius-badge);
  background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.cc-theme-option-choose:hover, .cc-theme-option-choose[aria-pressed="true"] { color: var(--cc-text); }
.cc-theme-option-choose:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-theme-option-choose:disabled { cursor: progress; }
.cc-theme-option-name { color: var(--cc-text); font-weight: 600; }
.cc-theme-option-desc { overflow-wrap: anywhere; }
.cc-theme-option-lane { color: var(--cc-text-tertiary); font-size: var(--cc-text-meta); }
.cc-theme-option-provenance { padding: 0 var(--cc-space-sm) var(--cc-space-sm); min-width: 0; }
.cc-theme-option-provenance > summary {
  width: fit-content; min-height: 24px; display: flex; align-items: center; gap: var(--cc-space-xxs);
  cursor: pointer; list-style: none; color: var(--cc-text-muted); font-size: var(--cc-text-meta); border-radius: var(--cc-radius-badge);
}
.cc-theme-option-provenance > summary::-webkit-details-marker { display: none; }
.cc-theme-option-provenance > summary::before { content: "▸"; color: var(--cc-text-tertiary); }
.cc-theme-option-provenance[open] > summary::before { content: "▾"; }
.cc-theme-option-provenance > summary:hover { color: var(--cc-text); }
.cc-theme-option-provenance > summary:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-theme-option-provenance[open] > summary { margin-bottom: var(--cc-space-xs); }
.cc-theme-option-provenance dd { min-width: 0; overflow-wrap: anywhere; }
.cc-theme-option-provenance code {
  font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); color: var(--cc-text);
}
.cc-theme-contrast { margin: var(--cc-space-xxs) 0 0; padding-inline-start: var(--cc-space-lg); }
.cc-theme-contrast li { overflow-wrap: anywhere; }
.cc-theme-contrast li + li { margin-top: var(--cc-space-xxs); }
.cc-theme-notice {
  margin: var(--cc-space-sm) 0 0; padding: var(--cc-space-sm);
  border: var(--cc-line, 1px solid) var(--cc-border); border-left: 3px solid var(--cc-accent); border-radius: var(--cc-radius-badge);
  background: var(--cc-card); font-size: var(--cc-text-label); color: var(--cc-text);
}
.cc-theme-notice p { margin: 0; }
.cc-theme-notice details, .cc-theme-notice-detail { margin-top: var(--cc-space-xs); }
.cc-theme-notice-detail { color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-theme-problems { margin: var(--cc-space-sm) 0 0; font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-theme-problems ul { margin: var(--cc-space-xs) 0 0; padding-inline-start: var(--cc-space-lg); }
.cc-theme-problems li { overflow-wrap: anywhere; }
.cc-theme-problems code { color: var(--cc-text); font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); }

.cc-effect-list { list-style: none; margin: var(--cc-space-sm) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-effect-list li { font-size: var(--cc-text-label); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-effect-list code { color: var(--cc-text); font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); }

/*
 * The personal-instructions field.
 *
 * A textarea rather than a single-line input, because the text is prose the user is writing about how they
 * want to be answered. Disabled while the toggle is off but still visible, so turning it off does not look
 * like it discarded what was typed.
 */
.cc-personal-instructions {
  width: 100%; min-height: 92px; resize: vertical; padding: var(--cc-space-sm);
  background: var(--cc-card); color: var(--cc-text); border: var(--cc-line, 1px solid) var(--cc-border);
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
  /* The backdrop's lit layer follows the pointer: movement on screen that nobody started on purpose. The pattern
     itself, whichever one a theme draws, stays; only the light that tracks the cursor goes. */
  .cc-dot-grid::after { display: none; }
}
/*
 * The same, for the person's own Reduced motion setting. The page marks the body with it, and the token sheet's
 * reduced-motion block already matches the mark, so every duration is none under it; these are the rules the tokens
 * cannot express. The setting means what the operating system's does, whatever the theme asked for.
 */
[data-cc-reduced-motion="true"] .cc-scroll { scroll-behavior: auto; }
[data-cc-reduced-motion="true"] * { transition-duration: var(--cc-motion-micro) !important; animation-duration: var(--cc-motion-micro) !important; }
[data-cc-reduced-motion="true"] .cc-composer-glow::before { animation: none !important; }
[data-cc-reduced-motion="true"] .cc-thinking-dot { animation: none !important; opacity: 0.7; }
[data-cc-reduced-motion="true"] .cc-caret { animation: none !important; }
[data-cc-reduced-motion="true"] .cc-tool-mark[data-status="running"] { animation: none !important; }
[data-cc-reduced-motion="true"] .cc-dot-grid::after { display: none; }

  /*
   * The desktop window's own chrome.
   *
   * A frameless window is dragged by its document, so the strip is the drag handle - and the controls opt out
   * of it, because a button inside a drag region cannot be clicked. In a browser none of this renders at all.
   */
  .cc-desktop-chrome { position: fixed; top: 0; left: 0; right: 0; height: var(--cc-desktop-chrome-height, 34px); display: flex; align-items: center; gap: 6px; padding-right: 8px; z-index: 30; background: var(--cc-canvas); }
  /* The strip owns the top of the window; the shell starts below it instead of drawing its header underneath. */
  :root[data-window-chrome="true"] { --cc-desktop-chrome-height: 34px; }
  :root[data-window-chrome="true"] .cc-shell { padding-top: var(--cc-desktop-chrome-height); }
  .cc-desktop-drag { flex: 1 1 auto; height: 100%; -webkit-app-region: drag; }
  .cc-desktop-controls { display: flex; align-items: center; gap: 2px; -webkit-app-region: no-drag; }
  .cc-desktop-button {
    -webkit-app-region: no-drag; display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 24px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: var(--cc-text-muted); cursor: pointer;
    transition: background-color var(--cc-motion-micro) var(--cc-motion-easing), color var(--cc-motion-micro) var(--cc-motion-easing);
  }
  .cc-desktop-button:hover { background: var(--cc-card); color: var(--cc-text); }
  /* Close is the one control that ends something, so it is the one that turns red, as it does in every title bar. */
  .cc-desktop-button[data-desktop-close="true"]:hover { background: var(--cc-danger); color: var(--cc-on-accent); }
  .cc-desktop-button[data-pinned="true"], .cc-desktop-button[data-fullscreen="true"] { color: var(--cc-accent); background: var(--cc-card); }
  .cc-desktop-separator { width: 1px; height: 14px; margin: 0 4px; background: var(--cc-border); }
  .cc-desktop-mode { -webkit-app-region: no-drag; font-size: 11px; opacity: 0.72; padding-right: 6px; }
  .cc-desktop-problem { -webkit-app-region: no-drag; font-size: 11px; padding-right: 6px; opacity: 0.9; max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
  /* One size for the gallery and a widget's page, so opening a card does not make the surface jump. */
  width: min(1100px, calc(100vw - 24px)); height: calc(100vh - 32px);
  display: flex; flex-direction: column;
  background: var(--cc-elevated); border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-modal);
  box-shadow: var(--cc-shadow-modal, 0 24px 64px color-mix(in oklab, var(--cc-code) 70%, transparent));
  z-index: 81; overflow: hidden;
  animation: cc-panel-in var(--cc-motion-panel) var(--cc-motion-easing);
}
.cc-widget-library:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-widget-library-head { display: flex; align-items: center; gap: var(--cc-space-md); padding: var(--cc-space-lg); border-bottom: var(--cc-line, 1px solid) var(--cc-border); }
.cc-widget-library-head h2 { margin: 0; font-family: var(--cc-font-display, "Plus Jakarta Sans Variable", ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif); font-size: var(--cc-text-heading-md); line-height: var(--cc-leading-heading-md); }
.cc-widget-library-head-left { display: flex; align-items: center; gap: var(--cc-space-sm); }
/* A field you type into, dressed like the other fields rather than left to the operating system's default. */
.cc-widget-library-search {
  flex: 1; min-width: 0; min-height: 36px; padding: var(--cc-space-xs) var(--cc-space-sm); font: inherit; color: inherit;
  background: var(--cc-input-bg, var(--cc-card));
  border: var(--cc-line, 1px solid) var(--cc-border);
  border-color: var(--cc-input-edge, color-mix(in oklab, var(--cc-text) 12%, var(--cc-border)));
  border-radius: var(--cc-input-radius, var(--cc-radius-field, 10px));
}
.cc-widget-library-search:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-widget-library-facets { display: flex; flex-wrap: wrap; gap: var(--cc-space-xs); padding: var(--cc-space-sm) var(--cc-space-lg); border-bottom: var(--cc-line, 1px solid) var(--cc-border); }
.cc-widget-library-facet { cursor: pointer; font: inherit; padding: var(--cc-space-xs) var(--cc-space-sm); border-radius: var(--cc-radius-button); border: var(--cc-line, 1px solid) var(--cc-border); background: transparent; color: inherit; }
.cc-widget-library-facet[data-selected="true"] { border-color: var(--cc-accent); }
.cc-widget-library-body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--cc-space-lg); }
/* Close stays in the corner whether the search field or a widget's name fills the row beside it. */
.cc-widget-library-head > [data-widget-library-close] { margin-left: auto; }
.cc-widget-library-empty { margin: 0; color: var(--cc-text-muted); }
.cc-library-builtin h3, .cc-library-provenance h3 { margin: 0 0 var(--cc-space-sm); font-weight: 600; }
/* Installed packages are separated from the built-in catalog by a rule, so the two lists read as two
   different claims rather than one mixed list. */
.cc-library-provenance { margin-top: var(--cc-space-lg); padding-top: var(--cc-space-lg); border-top: var(--cc-line, 1px solid) var(--cc-border); }
.cc-provenance-retry { display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-sm); }
.cc-provenance-retry button { cursor: pointer; font: inherit; padding: var(--cc-space-xs) var(--cc-space-sm); border-radius: var(--cc-radius-button); border: var(--cc-line, 1px solid) var(--cc-border); background: transparent; color: inherit; }
.cc-provenance-retry button:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
/* Uninstall, roll back and restore sit under the facts they act on, as plain buttons: a pill would read as a suggestion. */
.cc-package-actions { display: flex; flex-wrap: wrap; gap: var(--cc-space-sm); margin-top: var(--cc-space-sm); }
.cc-package-actions button { cursor: pointer; font: inherit; padding: var(--cc-space-xs) var(--cc-space-sm); border-radius: var(--cc-radius-button); border: var(--cc-line, 1px solid) var(--cc-border); background: transparent; color: inherit; transition: border-color var(--cc-motion-micro) var(--cc-motion-easing); }
.cc-package-actions button:hover:not(:disabled) { border-color: var(--cc-accent); }
.cc-package-actions button:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-package-actions button:disabled { opacity: 0.45; cursor: default; }
.cc-panel-note[data-package-status="failed"], .cc-panel-note[data-capability-status="failed"] { color: var(--cc-danger); }
/* What could not be shown from an installed package, kept beside the installed list rather than inside the grid. */
.cc-library-notes { margin-top: var(--cc-space-lg); padding-top: var(--cc-space-lg); border-top: var(--cc-line, 1px solid) var(--cc-border); }
.cc-library-notes h3 { margin: 0 0 var(--cc-space-sm); font-weight: 600; }
.cc-library-notes ul { margin: 0; padding-left: var(--cc-space-lg); color: var(--cc-text-muted); }
/* Host-owned cards: described, not previewed. Separated by a rule like the installed list, and the item is an
   article rather than a button because there is nothing to open from here. */
.cc-library-host { margin-top: var(--cc-space-lg); padding-top: var(--cc-space-lg); border-top: var(--cc-line, 1px solid) var(--cc-border); }
.cc-library-host h3 { margin: 0 0 var(--cc-space-xs); font-weight: 600; }
.cc-library-host-intro { margin: 0 0 var(--cc-space-md); color: var(--cc-text-muted); }
.cc-host-card-item { display: flex; flex-direction: column; gap: var(--cc-space-sm); padding: var(--cc-space-md); border: 1px dashed var(--cc-border); border-radius: var(--cc-radius-card); }
.cc-host-card-figure { margin: 0; display: flex; flex-direction: column; gap: var(--cc-space-xxs); }
.cc-host-card-terminal { margin: 0; min-height: 96px; padding: var(--cc-space-sm); border-radius: var(--cc-radius-button); background: var(--cc-code); font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); line-height: 1.5; white-space: pre-wrap; overflow: hidden; }
.cc-host-card-terminal-prompt, .cc-host-card-caption { color: var(--cc-text-muted); }
.cc-host-card-terminal-ok { color: var(--cc-success); }
.cc-host-card-caption { font-size: var(--cc-text-label); font-style: italic; }
.cc-host-card-open { color: inherit; }
.cc-widget-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--cc-space-md); grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
/* Cards in one row share its height, so the row reads as a row and every source line sits on the same baseline. */
.cc-widget-card { margin: 0; display: flex; }
.cc-widget-card-btn { flex: 1; display: flex; flex-direction: column; gap: var(--cc-space-sm); width: 100%; text-align: left; cursor: pointer; font: inherit; color: inherit; padding: var(--cc-space-md); border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-card); background: transparent; transition: border-color var(--cc-motion-micro) var(--cc-motion-easing); }
.cc-widget-card-btn:hover { border-color: color-mix(in oklab, var(--cc-text) 24%, var(--cc-border)); }
.cc-widget-card-btn:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-widget-card-preview { display: block; min-height: 96px; overflow: hidden; pointer-events: none; }
.cc-widget-card-text { display: block; color: var(--cc-text-muted); }
.cc-widget-card-meta { flex: 1; display: flex; flex-direction: column; gap: var(--cc-space-xxs); }
.cc-widget-card-name { font-weight: 600; }
.cc-widget-card-family { color: var(--cc-text-muted); }
.cc-widget-card-desc { color: var(--cc-text-muted); }
.cc-widget-card-source { margin-top: auto; padding-top: var(--cc-space-xs); color: var(--cc-text-muted); font-size: var(--cc-text-label); }
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
.cc-widget-preview-frame { border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-card); padding: var(--cc-space-sm); overflow: auto; background: var(--cc-window); color: var(--cc-text); }
.cc-widget-inspector { display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-widget-inspector-panel { border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-button); padding: var(--cc-space-sm); }
.cc-widget-inspector-panel summary { cursor: pointer; font-weight: 600; }
.cc-widget-inspector-rows { display: flex; flex-direction: column; gap: var(--cc-space-xxs); margin: var(--cc-space-xs) 0 0; }
.cc-widget-inspector-row { display: grid; grid-template-columns: max-content 1fr; gap: var(--cc-space-sm); }
.cc-widget-inspector-row dt { color: var(--cc-text-muted); }
.cc-widget-inspector-row dd { margin: 0; overflow-wrap: anywhere; }
.cc-widget-props { display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-widget-props-raw textarea { width: 100%; min-height: 120px; font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
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
  background: var(--cc-window); border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-button);
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
.cc-tabpanel .cc-chip-row > .cc-chip, .cc-tabpanel .cc-panel-row > .cc-chip {
  justify-content: center; min-height: 32px; padding: var(--cc-space-xs) var(--cc-space-lg);
  font-size: var(--cc-text-body-sm); border-radius: var(--cc-radius-button);
  background: var(--cc-button-bg, color-mix(in oklab, var(--cc-text) 5%, var(--cc-elevated)));
  border-color: var(--cc-button-edge, color-mix(in oklab, var(--cc-text) 16%, var(--cc-border)));
}
.cc-tabpanel :is(.cc-chip-row, .cc-panel-row) > .cc-chip:hover:not(:disabled) { border-color: var(--cc-accent); }
.cc-tabpanel .cc-chip-row, .cc-tabpanel .cc-panel-section > .cc-panel-row { margin-top: var(--cc-space-sm); }
/* Each stored key is its own small form; a hairline between them keeps one key's buttons from reading as the next's. */
.cc-credential-form p { margin: 0; }
.cc-credential-form + .cc-credential-form { margin-top: var(--cc-space-md); padding-top: var(--cc-space-md); border-top: var(--cc-line, 1px solid) var(--cc-border); }
.cc-tabpanel .cc-chip:disabled { opacity: 0.45; cursor: default; border-color: var(--cc-border); }

/* A wide table scrolls inside its own box instead of widening the dialog. */
.cc-table-scroll { overflow-x: auto; max-width: 100%; }
.cc-model-pool { width: 100%; border-collapse: collapse; font-size: var(--cc-text-label); font-variant-numeric: tabular-nums; }
.cc-model-pool th, .cc-model-pool td { text-align: left; padding: var(--cc-space-xs) var(--cc-space-sm); border-bottom: var(--cc-line, 1px solid) var(--cc-border); white-space: nowrap; }
.cc-model-pool th { color: var(--cc-text-muted); font-weight: 500; }

/* The guarded categories are a list of checkboxes; they wrap as a group instead of pushing past the edge. */
.cc-guard-classes { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--cc-space-xs) var(--cc-space-md); }
.cc-guard-classes label { display: inline-flex; align-items: center; gap: var(--cc-space-xs); cursor: pointer; font-size: var(--cc-text-label); color: var(--cc-text); }
.cc-guard-classes input { accent-color: var(--cc-accent); margin: 0; }
.cc-setting-row[data-layout="stacked"] .cc-guard-classes { justify-content: flex-start; }

/* A definition list's value may be a path or an id; it wraps rather than pushing the column off the page. */
.cc-fields { grid-template-columns: max-content minmax(0, 1fr); }
.cc-fields dd { min-width: 0; overflow-wrap: anywhere; }
/* Settings sets its labels at the small body size; a card there kept the reply size and read a step louder than its row. */
.cc-tabpanel .cc-fields { font-size: var(--cc-text-body-sm); line-height: var(--cc-leading-body-sm); }

/* In this layer rather than beside .cc-setup-card, because the voice layer's .cc-chip padding comes later and wins. */
.cc-setup-card > .cc-chip { padding: var(--cc-space-xs) var(--cc-space-lg); }

/*
 * A free-text setting takes the width the row gives it and looks like the other prose fields, rather than the
 * browser's default box at its intrinsic twenty columns.
 */
.cc-setting-control > textarea {
  width: 100%; min-width: 16rem; min-height: 92px; resize: vertical; padding: var(--cc-space-sm);
  background: var(--cc-card); color: var(--cc-text); border: var(--cc-line, 1px solid) var(--cc-border);
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
  .cc-segmented-wrap > .cc-panel-note, .cc-toggle-wrap > .cc-panel-note { text-align: left; max-width: none; contain: none; min-width: 0; }
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
