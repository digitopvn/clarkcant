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
.cc-table [data-numeric="true"] { text-align: right; }
.cc-table tr[aria-selected="true"] td { background: color-mix(in oklab, var(--cc-accent) 12%, var(--cc-card)); }
.cc-table tr[aria-selected="true"] td:first-child { box-shadow: inset 2px 0 0 var(--cc-accent); }
/* Only a row that does something on click says so; the table alternative under a chart is read-only. */
.cc-table tbody tr[data-selectable="true"]:hover td { background: var(--cc-elevated); cursor: pointer; }
.cc-table tbody tr[data-selectable="true"]:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: -2px; }
.cc-table tbody tr:last-child td { border-bottom: none; }
.cc-table-scroll { overflow: auto; max-height: 360px; border-radius: var(--cc-radius-badge); }
.cc-table-scroll:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-table-scroll thead th { position: sticky; top: 0; background: var(--cc-card); z-index: 1; }

/* Charts */
/*
 * The SVG is drawn at its measured width, so these sizes are real pixels at every card width.
 * Gridlines stay quieter than the axis, and the axis quieter than the data.
 */
.cc-chart-box { width: 100%; min-width: 0; }
.cc-chart { width: 100%; height: 180px; display: block; overflow: visible; }
.cc-chart .axis { stroke: var(--cc-border); }
.cc-chart .grid { stroke: var(--cc-border); stroke-dasharray: 2 4; opacity: 0.7; }
.cc-chart .label { fill: var(--cc-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.cc-chart .value { fill: var(--cc-text); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cc-chart .series { fill: none; stroke: var(--cc-accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.cc-chart .area { fill: var(--cc-accent); opacity: 0.1; stroke: none; }
.cc-chart .point { fill: var(--cc-card); stroke: var(--cc-accent); stroke-width: 2; }
.cc-chart .bar { fill: var(--cc-accent); }
.cc-chart .datum:hover .point { fill: var(--cc-accent); }
.cc-chart .datum:hover .bar { fill: color-mix(in oklab, var(--cc-accent) 80%, var(--cc-text)); }

/* Note */
.cc-note-input, .cc-note-area {
  width: 100%; background: var(--cc-elevated); color: var(--cc-text);
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge);
  padding: var(--cc-space-sm); font: inherit;
}
.cc-note-area { min-height: 120px; resize: vertical; line-height: var(--cc-leading-body-md); }
.cc-note-area:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 1px; }
.cc-note-meta[data-note-status="draft"] { color: var(--cc-warning); }
.cc-note-meta[data-note-status="saved"] { color: var(--cc-success); }
.cc-note-meta[data-note-status="conflict"] { color: var(--cc-danger); }
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
}
`;
