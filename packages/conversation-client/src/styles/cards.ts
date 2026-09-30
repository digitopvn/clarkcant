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
  border: var(--cc-line, 1px solid) var(--cc-border);
  border-color: var(--cc-card-edge, var(--cc-border));
  background: var(--cc-surface-fill, var(--cc-card));
  background-image: var(--cc-surface-image, none);
  background-size: var(--cc-surface-size, auto);
  -webkit-backdrop-filter: var(--cc-surface-filter, none);
  backdrop-filter: var(--cc-surface-filter, none);
  box-shadow: var(--cc-card-shadow, none);
  border-radius: var(--cc-radius-card);
  overflow: hidden;
}
/*
 * The host's own cards — an approval, a credential, a connection, a task the host runs — keep their edge whatever a
 * card recipe says. A theme may draw widget cards flat; it may not make the card that asks for consent look like one
 * of them, or disappear into the page. The width follows the theme's line, which is never less than a pixel.
 */
.cc-card[data-owner="host"] { border-color: var(--cc-border); }
.cc-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-sm);
  padding: var(--cc-space-sm) var(--cc-space-md);
  border-bottom: var(--cc-line, 1px solid) var(--cc-border);
  font-size: var(--cc-text-label); color: var(--cc-text-muted);
}
.cc-card-title { font-family: var(--cc-font-display, "Plus Jakarta Sans Variable", ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif); font-weight: var(--cc-weight-heading, 600); color: var(--cc-text); }
.cc-card-body { padding: var(--cc-space-md); display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-fields { display: grid; grid-template-columns: max-content 1fr; gap: var(--cc-space-xs) var(--cc-space-md); margin: 0; }
.cc-fields dt { color: var(--cc-text-muted); }
.cc-fields dd { margin: 0; }
.cc-badge {
  font-size: var(--cc-text-label);
  padding: 2px var(--cc-space-sm);
  border-radius: var(--cc-badge-radius, var(--cc-radius-pill));
  border: var(--cc-line, 1px solid) var(--cc-border);
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
.cc-widget-frame-document { display: block; width: 100%; border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-card); }
.cc-widget-frame-document[hidden] { display: none; }
/* A frame that could not load again: in place of the document, with the one way forward beside what failed. */
.cc-widget-frame-failure { display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-sm); padding: var(--cc-space-sm) var(--cc-space-md); border: 1px solid color-mix(in oklab, var(--cc-danger) 45%, var(--cc-border)); border-radius: var(--cc-radius-card); color: var(--cc-text); overflow-wrap: anywhere; }
.cc-widget-frame-failure p { margin: 0; }
.cc-widget-frame-failure [data-frame-failure-reason] { font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-widget-frame-failure button { cursor: pointer; font: inherit; min-height: 40px; padding: var(--cc-space-xs) var(--cc-space-md); border-radius: var(--cc-radius-button); border: var(--cc-line, 1px solid) var(--cc-border); background: transparent; color: inherit; }
.cc-widget-frame-failure button:hover { border-color: var(--cc-focus); background: var(--cc-elevated); }
.cc-widget-frame-failure button:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
/*
 * A widget's file request, answered in host chrome beside the frame. The widget cannot draw here: the buttons are the
 * host's, and so is the file input they open. Nothing animates, so reduced motion needs no override.
 */
.cc-artifact-prompt {
  position: relative; display: flex; flex-direction: column; gap: var(--cc-space-sm); min-width: 0; margin-top: var(--cc-space-sm);
  padding: var(--cc-space-sm) var(--cc-space-md); border: 1px solid var(--cc-focus); border-radius: var(--cc-radius-card);
  background: var(--cc-elevated); color: var(--cc-text); overflow-wrap: anywhere;
}
.cc-artifact-prompt[data-artifact-prompt="notice"] { border-color: var(--cc-border); background: transparent; }
.cc-artifact-prompt p { margin: 0; }
.cc-artifact-prompt-title { font-weight: 600; }
.cc-artifact-prompt-detail { font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-artifact-prompt-actions { display: flex; flex-wrap: wrap; gap: var(--cc-space-xs); }
.cc-artifact-notice { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--cc-space-xs); }
.cc-artifact-notice p { flex: 1 1 16ch; min-width: 0; }
.cc-artifact-notice[data-tone="error"] p { color: var(--cc-danger); }
.cc-artifact-notice p:focus-visible, .cc-artifact-prompt-title:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
/* The browser's own file input, opened by the host's button: kept in the page for the browser, out of the tab order. */
.cc-artifact-file-input { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.cc-artifact-button, .cc-viewer-file-button {
  cursor: pointer; font: inherit; min-height: 40px; padding: var(--cc-space-xs) var(--cc-space-md); border-radius: var(--cc-radius-button);
  border: 1px solid var(--cc-border); background: transparent; color: inherit; max-width: 100%; overflow-wrap: anywhere;
}
.cc-artifact-button[data-primary="true"] { border-color: var(--cc-accent); font-weight: 600; }
.cc-artifact-button:hover:not(:disabled), .cc-viewer-file-button:hover:not(:disabled) { border-color: var(--cc-focus); background: var(--cc-card); }
.cc-artifact-button:focus-visible, .cc-viewer-file-button:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-artifact-button:disabled, .cc-viewer-file-button:disabled { cursor: default; opacity: 0.6; }
/* Tables */
.cc-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.cc-table th, .cc-table td { text-align: left; padding: var(--cc-space-xs) var(--cc-space-sm); border-bottom: var(--cc-line, 1px solid) var(--cc-border); }
.cc-table th { color: var(--cc-text-muted); font-weight: 500; font-size: var(--cc-text-label); }
.cc-table [data-numeric="true"] { text-align: right; }
.cc-table tr[aria-selected="true"] td { background: color-mix(in oklab, var(--cc-accent) 12%, var(--cc-card)); }
.cc-table tr[aria-selected="true"] td:first-child { box-shadow: inset 2px 0 0 var(--cc-accent); }
/* Only a row that does something on click says so; the table alternative under a chart is read-only. */
.cc-table tbody tr[data-selectable="true"]:hover td { background: var(--cc-elevated); cursor: pointer; }
.cc-table tbody tr[data-selectable="true"]:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: -2px; }
.cc-table tbody tr:last-child td { border-bottom: none; }
/* Tall enough for a ten-row page with its header and totals; a longer page scrolls inside the table. */
/*
 * A shadow shows at whichever side still has columns to scroll to, so a table cut off at the edge of a phone says so
 * instead of looking finished. The card-coloured covers scroll with the content and hide the shadow once that side is
 * reached; the shadows themselves stay fixed to the edges. No script: it follows the scroll position by itself.
 */
.cc-table-scroll {
  overflow: auto; max-height: min(28rem, 70vh); border-radius: var(--cc-radius-badge);
  background:
    linear-gradient(to right, var(--cc-card) 40%, transparent) left / 24px 100% no-repeat local,
    linear-gradient(to left, var(--cc-card) 40%, transparent) right / 24px 100% no-repeat local,
    radial-gradient(farthest-side at 0 50%, color-mix(in oklab, var(--cc-text) 22%, transparent), transparent) left / 12px 100% no-repeat scroll,
    radial-gradient(farthest-side at 100% 50%, color-mix(in oklab, var(--cc-text) 22%, transparent), transparent) right / 12px 100% no-repeat scroll,
    var(--cc-card);
}
.cc-table-scroll:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-table-scroll thead th { position: sticky; top: 0; background: var(--cc-card); z-index: 1; }
.cc-table [data-align="end"] { text-align: right; }
.cc-table [data-align="center"] { text-align: center; }
/*
 * A number or a date reads as one unit, so it never breaks across lines, and a text cell keeps a readable width
 * rather than folding a short name onto three lines. A table wider than its card scrolls inside its own region.
 */
.cc-table td[data-type]:not([data-type="text"]) { white-space: nowrap; }
.cc-table td[data-type="text"] { min-width: 12ch; }
/*
 * A sortable header is a real button filling its cell, so the whole header is the target and the focus ring is on
 * the thing that acts. The arrow says which way it sorts; aria-sort says it to a screen reader.
 */
.cc-table th[aria-sort] { padding: 0; }
.cc-table-sort {
  display: inline-flex; align-items: center; gap: var(--cc-space-xxs); width: 100%; min-height: 32px;
  padding: var(--cc-space-xs) var(--cc-space-sm); background: transparent; border: 0; border-radius: var(--cc-radius-badge);
  color: inherit; font: inherit; font-weight: 500; text-align: inherit; white-space: nowrap; cursor: pointer;
}
.cc-table th[data-align="end"] .cc-table-sort { justify-content: flex-end; }
.cc-table th[data-align="center"] .cc-table-sort { justify-content: center; }
.cc-table-sort:hover { color: var(--cc-text); }
.cc-table-sort:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: -2px; }
.cc-table th[aria-sort="ascending"], .cc-table th[aria-sort="descending"] { color: var(--cc-text); }
.cc-table-sort-icon { font-size: 0.75em; color: var(--cc-text-tertiary); }
.cc-table-sort-icon[data-sorted="ascending"], .cc-table-sort-icon[data-sorted="descending"] { color: var(--cc-accent); }
.cc-table { --cc-table-check-width: 36px; }
.cc-table .cc-table-check-cell { width: var(--cc-table-check-width); min-width: var(--cc-table-check-width); padding: 0; text-align: center; }
/*
 * The checkbox and the column that names a row stay at the start edge while the rest scroll under them, with a rule
 * where they end. They carry the card's colour so the scrolled cells pass beneath; a selected or hovered row's own
 * colour still wins, being more specific.
 */
.cc-table-scroll .cc-table-check-cell, .cc-table-scroll .cc-table-sticky {
  position: sticky; inset-inline-start: 0; z-index: 1; background: var(--cc-card);
}
.cc-table-scroll .cc-table[data-multi="true"] .cc-table-sticky { inset-inline-start: var(--cc-table-check-width); }
/* The edge is drawn by a pseudo-element: a collapsed-border table does not paint a cell's own shadow. */
.cc-table-scroll .cc-table-sticky::after {
  content: ""; position: absolute; top: 0; bottom: 0; inset-inline-end: -6px; width: 6px; pointer-events: none;
  border-inline-start: var(--cc-line, 1px solid) var(--cc-border);
  background: linear-gradient(to right, color-mix(in oklab, var(--cc-text) 12%, transparent), transparent);
}
.cc-table-scroll thead :is(.cc-table-check-cell, .cc-table-sticky), .cc-table-scroll tfoot :is(.cc-table-check-cell, .cc-table-sticky) { z-index: 2; }
.cc-table-check { display: inline-flex; align-items: center; justify-content: center; min-width: 36px; min-height: 32px; cursor: pointer; }
.cc-table-check input { width: 16px; height: 16px; margin: 0; accent-color: var(--cc-accent); cursor: pointer; }
.cc-table-check input:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-table td.cc-table-empty { color: var(--cc-text-muted); text-align: center; padding: var(--cc-space-md); }
/* Totals stay in view at the bottom of a long page, as the header does at the top. */
.cc-table tfoot td { border-top: 2px solid var(--cc-border); border-bottom: none; font-weight: 600; }
.cc-table-scroll tfoot td { position: sticky; bottom: 0; background: var(--cc-card); z-index: 1; }
.cc-table-total { display: block; white-space: nowrap; }
.cc-table-total-fn { color: var(--cc-text-muted); font-weight: 500; font-size: var(--cc-text-label); }
.cc-table-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-sm); margin-bottom: var(--cc-space-sm); }
.cc-table-search { flex: 1 1 200px; min-width: 0; display: flex; }
.cc-table-search input {
  flex: 1; min-width: 0; min-height: 32px; font: inherit; font-size: var(--cc-text-body-sm); color: var(--cc-text);
  background: var(--cc-input-bg, var(--cc-elevated)); border: var(--cc-line, 1px solid) var(--cc-border);
  border-color: var(--cc-input-edge, var(--cc-border)); border-radius: var(--cc-input-radius, var(--cc-radius-badge));
  padding: var(--cc-space-xs) var(--cc-space-sm);
}
.cc-table-search input:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 1px; }
.cc-table-selected { font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-table-export { margin-inline-start: auto; }
.cc-table-note { margin: 0 0 var(--cc-space-sm); font-size: var(--cc-text-label); }
.cc-table-note[role="alert"] { color: var(--cc-danger); }
.cc-table-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--cc-space-sm); margin-top: var(--cc-space-sm); }
.cc-table-page-status { font-size: var(--cc-text-label); color: var(--cc-text-muted); font-variant-numeric: tabular-nums; }
/* On a narrow screen the page status takes its own line, with previous and next under it at either edge. */
@media (max-width: 480px) {
  .cc-table-pager { justify-content: space-between; }
  .cc-table-page-status { order: -1; flex-basis: 100%; text-align: center; }
}
/* Touch: every table control grows to the 44 px a thumb needs, the visible shape with it. */
@media (pointer: coarse) {
  .cc-table-sort, .cc-table-check, .cc-table-search input, .cc-table-toolbar .cc-action, .cc-table-pager .cc-action { min-height: 44px; }
  .cc-table-check { min-width: 44px; }
  .cc-table { --cc-table-check-width: 44px; }
}

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
/*
 * Area and scatter charts. Each series reads its tone from data-slice-tone and is told apart by its line pattern and
 * point shape too, so no series is known by colour alone. A point is a button: the focused one takes the focus colour,
 * the selected one is filled and larger. Past a few dozen rows an area draws only the points a person is on.
 */
.cc-chart .xy-area { fill: var(--cc-slice, var(--cc-accent)); opacity: 0.12; stroke: none; }
.cc-chart[data-stacked="true"] .xy-area { opacity: 0.32; }
.cc-chart .xy-line, .cc-xy-key line { fill: none; stroke: var(--cc-slice, var(--cc-accent)); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.cc-chart .marker, .cc-xy-key .marker { fill: var(--cc-card); fill-rule: evenodd; stroke: var(--cc-slice, var(--cc-accent)); stroke-width: 1.75; }
.cc-chart .marker { cursor: pointer; }
.cc-chart .marker:hover { fill: var(--cc-slice, var(--cc-accent)); }
.cc-chart .marker[aria-pressed="true"] { fill: var(--cc-slice, var(--cc-accent)); stroke: var(--cc-text); stroke-width: 2; }
.cc-chart .marker:focus { outline: none; }
.cc-chart .marker:focus-visible { stroke: var(--cc-focus); stroke-width: 3; opacity: 1; }
.cc-chart[data-dense="true"] .marker { opacity: 0; }
.cc-chart[data-dense="true"] .marker:hover, .cc-chart[data-dense="true"] .marker[aria-pressed="true"] { opacity: 1; }
.cc-xy-legend { list-style: none; margin: 0 0 var(--cc-space-xs); padding: 0; display: flex; flex-wrap: wrap; gap: var(--cc-space-xs); }
.cc-xy-legend button {
  display: inline-flex; align-items: center; gap: var(--cc-space-xs); min-height: 32px; max-width: 100%;
  padding: 0 var(--cc-space-sm); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge);
  background: var(--cc-elevated); color: var(--cc-text); font: inherit; font-size: var(--cc-text-label); cursor: pointer;
}
.cc-xy-legend button[aria-pressed="false"] { background: transparent; color: var(--cc-text-muted); }
.cc-xy-legend button[aria-pressed="false"] .cc-xy-legend-name { text-decoration: line-through; }
.cc-xy-legend button[aria-pressed="false"] .cc-xy-key { opacity: 0.45; }
.cc-xy-legend button:focus-visible, .cc-xy-clear:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-xy-legend-name { min-width: 0; overflow-wrap: anywhere; }
.cc-xy-key { width: 26px; height: 12px; flex: none; overflow: visible; }
.cc-xy-selected { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-sm); min-height: 0; font-size: var(--cc-text-label); overflow-wrap: anywhere; }
.cc-xy-selected:empty { display: none; }
.cc-xy-axis { margin: 0; font-size: var(--cc-text-label); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-xy-axis-x { text-align: end; }
.cc-xy-clear {
  min-height: 28px; padding: 0 var(--cc-space-sm); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge);
  background: transparent; color: var(--cc-text); font: inherit; font-size: var(--cc-text-label); cursor: pointer;
}

/* Note */
.cc-note-area {
  width: 100%; background: var(--cc-input-bg, var(--cc-elevated)); color: var(--cc-text);
  border: var(--cc-line, 1px solid) var(--cc-border); border-color: var(--cc-input-edge, var(--cc-border));
  border-radius: var(--cc-input-radius, var(--cc-radius-badge));
  padding: var(--cc-space-sm); font: inherit;
}
.cc-note-area { min-height: 120px; resize: vertical; line-height: var(--cc-leading-body-md); }
.cc-note-area:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 1px; }
.cc-note-meta[data-note-status="draft"] { color: var(--cc-warning); }
.cc-note-meta[data-note-status="conflict"] { color: var(--cc-danger); }
/* "saved" stays muted: the save is optimistic until the host confirms it, so it is not shown as a success. */
.cc-note-meta { font-size: var(--cc-text-label); color: var(--cc-text-muted); }

/*
 * Code, diff and file viewers.
 *
 * A long line scrolls inside its own block, never across the page, and a long block scrolls inside a bounded height. The
 * scroll is focusable, so it is ringed from the inside: the rounded card around it clips anything drawn outside. Diff
 * hunks take their own class rather than the host card's .cc-diff-hunk, whose later composer layer scrolls each hunk on
 * its own and would leave a keyboard in the outer scroll unable to reach a long line.
 */
.cc-viewer-head { flex-wrap: wrap; gap: var(--cc-space-xxs) var(--cc-space-sm); }
.cc-viewer-name { flex: 1 1 auto; min-width: 0; color: var(--cc-text); overflow-wrap: anywhere; }
.cc-viewer-meta { font-variant-numeric: tabular-nums; }
/* The head is monospace for the path; the button is a control and keeps the interface's own face. */
.cc-viewer-copy { font-family: var(--cc-font-body, "Plus Jakarta Sans Variable", ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif); }
.cc-viewer-scroll { max-block-size: min(24rem, 60vh); overflow: auto; overscroll-behavior: contain; }
.cc-viewer-code .cc-viewer-scroll { display: grid; grid-template-columns: max-content minmax(max-content, 1fr); }
/*
 * The block itself takes the code's size and leading, not only the <code> inside it: a line box is never shorter than
 * its block's own line height, so a larger one here would space the lines apart from the numbers beside them.
 */
.cc-viewer-code .cc-code-body {
  overflow: visible;
  font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm);
}
.cc-viewer-gutter {
  position: sticky; left: 0; margin: 0; padding: var(--cc-space-sm) var(--cc-space-xs) var(--cc-space-sm) var(--cc-space-sm);
  background: var(--cc-code); border-inline-end: var(--cc-line, 1px solid) var(--cc-border); color: var(--cc-text-tertiary); text-align: end;
  font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm);
  font-variant-numeric: tabular-nums; user-select: none;
}
/*
 * The copy status is always in the page, so a screen reader is already listening when a result is written into it. With
 * nothing to say it takes no room and draws nothing, but stays in the accessibility tree, which display:none would not.
 */
.cc-viewer-copy-status { margin: 0; }
.cc-viewer-copy-status[data-copy-state="idle"] {
  position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0;
}
/*
 * A hidden character drawn as its code point. Only horizontal room is added, so a marked line is exactly as tall as any
 * other and the numbers beside the code stay on their lines.
 */
.cc-hidden-char {
  padding-inline: 2px; border-radius: 3px; color: var(--cc-text);
  background: color-mix(in oklab, var(--cc-warning) 22%, transparent);
  outline: 1px solid color-mix(in oklab, var(--cc-warning) 55%, transparent); outline-offset: -1px;
}
.cc-viewer-hidden { color: var(--cc-text); border-inline-start: 3px solid var(--cc-warning); padding-inline-start: var(--cc-space-xs); }
.cc-viewer-copy-status[data-copy-state="failed"] { color: var(--cc-danger); }
.cc-viewer-diff-file { display: flex; flex-direction: column; gap: var(--cc-space-xxs); min-width: 0; }
/* A long path wraps; the counts beside it do not, so "+2 −0" never splits across two lines. */
.cc-viewer-diff-counts { flex: none; white-space: nowrap; }
.cc-viewer-diff-scroll { background: var(--cc-code); border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-badge); }
.cc-viewer-hunk { min-inline-size: max-content; }
.cc-viewer-hunk + .cc-viewer-hunk { border-top: var(--cc-line, 1px solid) var(--cc-border); }
.cc-viewer-num {
  flex: none; min-inline-size: 4ch; text-align: end; color: var(--cc-text-tertiary); user-select: none;
  font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); font-variant-numeric: tabular-nums;
}
.cc-viewer-file { display: flex; align-items: flex-start; gap: var(--cc-space-sm); min-width: 0; }
.cc-viewer-file-mark {
  flex: none; display: inline-grid; place-items: center; min-inline-size: 44px; block-size: 44px; padding: 0 var(--cc-space-xxs);
  border-radius: var(--cc-radius-button); border: var(--cc-line, 1px solid) var(--cc-border); background: var(--cc-elevated);
  font-size: var(--cc-text-label); font-weight: 700; color: var(--cc-text-muted); letter-spacing: 0.04em;
}
.cc-viewer-file-text { display: flex; flex-direction: column; gap: var(--cc-space-xs); min-width: 0; flex: 1 1 auto; }
.cc-viewer-file-name { margin: 0; font-weight: 600; color: var(--cc-text); overflow-wrap: anywhere; }
.cc-viewer-file-summary { margin: 0; font-size: var(--cc-text-body-sm); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-viewer-file-artifact { display: flex; flex-direction: column; gap: var(--cc-space-xs); min-width: 0; }
.cc-viewer-file-actions { display: flex; flex-wrap: wrap; gap: var(--cc-space-xs); }
.cc-viewer-file-preview {
  margin: 0; max-block-size: 320px; overflow: auto; padding: var(--cc-space-sm); background: var(--cc-code);
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge); white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); color: var(--cc-text);
}
.cc-viewer-file-preview:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-viewer-file-image { display: block; max-inline-size: 100%; block-size: auto; max-block-size: 320px; border-radius: var(--cc-radius-badge); }.cc-viewer-facts {
  display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: var(--cc-space-xxs) var(--cc-space-md); margin: 0;
  font-size: var(--cc-text-body-sm);
}
/* Each pair is a row of the parent grid, so a label and its value line up whatever their lengths. */
.cc-viewer-fact { display: contents; }
.cc-viewer-facts dt { color: var(--cc-text-muted); }
.cc-viewer-facts dd { margin: 0; min-width: 0; color: var(--cc-text); overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .cc-viewer-facts { grid-template-columns: minmax(0, 1fr); row-gap: 0; }
  .cc-viewer-facts dd { margin-bottom: var(--cc-space-xs); }
}

/* Fields, forms, search and lists */
/*
 * Every field is at least 44 px tall so a thumb can hit it (a button grows to it on a touch screen, in the voice layer
 * where its size is set), and every control shows the same focus ring. A problem is said in text under the field; the
 * red border is a second signal, never the only one.
 */
.cc-form { display: flex; flex-direction: column; gap: var(--cc-space-md); margin: 0; }
.cc-field { display: flex; flex-direction: column; gap: var(--cc-space-xxs); min-width: 0; margin: 0; padding: 0; border: none; }
.cc-field-label { font-size: var(--cc-text-body-sm); font-weight: 600; color: var(--cc-text); padding: 0; }
.cc-field-required { color: var(--cc-danger); }
.cc-field-help { margin: 0; font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-field-error { margin: 0; font-size: var(--cc-text-label); color: var(--cc-danger); }
.cc-field-input {
  width: 100%; min-width: 0; min-height: 44px; font: inherit; font-size: var(--cc-text-body-sm); color: var(--cc-text);
  background: var(--cc-input-bg, var(--cc-elevated)); border: var(--cc-line, 1px solid) var(--cc-border);
  border-color: var(--cc-input-edge, var(--cc-border)); border-radius: var(--cc-input-radius, var(--cc-radius-badge));
  padding: var(--cc-space-xs) var(--cc-space-sm);
}
textarea.cc-field-input { resize: vertical; line-height: var(--cc-leading-body-md); }
.cc-field-input[aria-invalid="true"], .cc-field [aria-invalid="true"].cc-field-chip { border-color: var(--cc-danger); }
.cc-field-input:focus-visible, .cc-field input:focus-visible, .cc-field-chip:focus-visible, .cc-switch:focus-visible {
  outline: 2px solid var(--cc-focus); outline-offset: 2px;
}
.cc-field-input:disabled { color: var(--cc-text-tertiary); cursor: not-allowed; }
.cc-field-slider { display: flex; align-items: center; gap: var(--cc-space-sm); min-height: 44px; }
.cc-field-slider input { flex: 1; min-width: 0; accent-color: var(--cc-accent); }
.cc-field-slider input[data-field-unset="true"] { opacity: 0.6; }
.cc-field-output { min-width: 4ch; text-align: end; font-variant-numeric: tabular-nums; font-size: var(--cc-text-body-sm); }
.cc-field-range { display: flex; flex-wrap: wrap; gap: var(--cc-space-sm); }
.cc-field-range-part { flex: 1 1 140px; display: flex; flex-direction: column; gap: var(--cc-space-xxs); min-width: 0; }
.cc-field-options { display: flex; flex-direction: column; gap: 0; }
.cc-field-check { display: inline-flex; align-items: center; gap: var(--cc-space-sm); min-height: 44px; cursor: pointer; font-size: var(--cc-text-body-sm); }
.cc-field-check input { width: 18px; height: 18px; margin: 0; flex: none; accent-color: var(--cc-accent); cursor: pointer; }
.cc-field-chips { display: flex; flex-wrap: wrap; gap: var(--cc-space-xs); }
.cc-field-chip {
  min-height: 44px; padding: 0 var(--cc-space-md); font: inherit; font-size: var(--cc-text-body-sm); color: var(--cc-text);
  background: var(--cc-elevated); border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-pill); cursor: pointer;
  transition: background var(--cc-motion-micro), border-color var(--cc-motion-micro);
}
/* Pressed is said by a check mark as well as by colour. */
.cc-field-chip[aria-pressed="true"] { background: var(--cc-accent); border-color: var(--cc-accent); color: var(--cc-on-accent); font-weight: 600; }
/* The empty alternative keeps a screen reader from reading the mark out on top of "pressed". */
.cc-field-chip[aria-pressed="true"]::before { content: "✓ "; content: "✓ " / ""; }
.cc-field-chip:disabled { cursor: not-allowed; color: var(--cc-text-tertiary); }
.cc-switch {
  align-self: flex-start; display: inline-flex; align-items: center; gap: var(--cc-space-sm); min-height: 44px; padding: 0;
  font: inherit; font-size: var(--cc-text-body-sm); color: var(--cc-text); background: none; border: none; cursor: pointer;
}
.cc-switch-track {
  position: relative; width: 40px; height: 24px; flex: none; border-radius: var(--cc-radius-pill);
  background: var(--cc-elevated); border: var(--cc-line, 1px solid) var(--cc-border); transition: background var(--cc-motion-micro);
}
.cc-switch-thumb {
  position: absolute; top: 3px; inset-inline-start: 3px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--cc-text-muted); transition: transform var(--cc-motion-micro), background var(--cc-motion-micro);
}
.cc-switch[data-on="true"] .cc-switch-track { background: var(--cc-accent); border-color: var(--cc-accent); }
.cc-switch[data-on="true"] .cc-switch-thumb { background: var(--cc-on-accent); transform: translateX(16px); }
[dir="rtl"] .cc-switch[data-on="true"] .cc-switch-thumb { transform: translateX(-16px); }
.cc-switch:disabled { cursor: not-allowed; opacity: 0.6; }
.cc-form-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--cc-space-sm); }
.cc-form-foot > p { flex: 1 1 200px; margin: 0; }
.cc-form-foot [data-form-result="refused"], .cc-form-foot [data-form-result="invalid"] { color: var(--cc-danger); }
.cc-search-row { display: flex; gap: var(--cc-space-sm); align-items: center; }
.cc-search-row .cc-action { flex: none; }
/* The page draws its own clear button, which every browser shows the same way and a screen reader can name. */
.cc-search-row input::-webkit-search-cancel-button { appearance: none; }
.cc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.cc-list-item {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-xs) var(--cc-space-sm);
  padding: var(--cc-space-xs) 0; border-bottom: var(--cc-line, 1px solid) var(--cc-border);
}
.cc-list-item:last-child { border-bottom: none; }
.cc-list-item[data-selected="true"] { background: color-mix(in oklab, var(--cc-accent) 10%, transparent); }
.cc-list-main { flex: 1 1 180px; display: flex; align-items: center; gap: var(--cc-space-sm); min-width: 0; min-height: 44px; }
label.cc-list-main { cursor: pointer; }
.cc-list-main input { width: 18px; height: 18px; margin: 0; flex: none; accent-color: var(--cc-accent); cursor: pointer; }
.cc-list-main input:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-list-text { display: flex; flex-direction: column; min-width: 0; }
.cc-list-title { font-size: var(--cc-text-body-sm); overflow-wrap: anywhere; }
.cc-list-subtitle { font-size: var(--cc-text-label); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-list-meta { font-size: var(--cc-text-label); color: var(--cc-text-muted); font-variant-numeric: tabular-nums; }
.cc-list-item .cc-action { margin-inline-start: auto; }

/* Status, progress and details cards. Tone is said in words and a symbol; the colour only repeats it. */
.cc-badge[data-tone="info"] { color: var(--cc-accent); border-color: color-mix(in oklab, var(--cc-accent) 45%, transparent); }
.cc-status-card { display: flex; align-items: flex-start; gap: var(--cc-space-sm); min-width: 0; }
.cc-status-card-mark {
  flex: none; display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: var(--cc-radius-pill);
  font-weight: 700; color: var(--cc-text-muted); border: var(--cc-line, 1px solid) var(--cc-border); background: var(--cc-elevated);
}
.cc-status-card[data-status-tone="info"] .cc-status-card-mark { color: var(--cc-accent); border-color: color-mix(in oklab, var(--cc-accent) 45%, transparent); }
.cc-status-card[data-status-tone="success"] .cc-status-card-mark { color: var(--cc-success); border-color: color-mix(in oklab, var(--cc-success) 45%, transparent); }
.cc-status-card[data-status-tone="warning"] .cc-status-card-mark { color: var(--cc-warning); border-color: color-mix(in oklab, var(--cc-warning) 45%, transparent); }
.cc-status-card[data-status-tone="danger"] .cc-status-card-mark { color: var(--cc-danger); border-color: color-mix(in oklab, var(--cc-danger) 45%, transparent); }
.cc-status-card-text { display: flex; flex-direction: column; gap: var(--cc-space-xs); min-width: 0; }
.cc-status-card-label { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-xs) var(--cc-space-sm); }
.cc-status-card-value { font-weight: 600; color: var(--cc-text); overflow-wrap: anywhere; }
.cc-status-card-detail { margin: 0; font-size: var(--cc-text-body-sm); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-status-card-asof { margin: 0; }
.cc-progress-subject { margin: 0; font-size: var(--cc-text-body-sm); color: var(--cc-text); overflow-wrap: anywhere; }
.cc-progress-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-xs) var(--cc-space-sm); }
.cc-progress-track {
  flex: 1 1 160px; height: 8px; border-radius: var(--cc-radius-pill); overflow: hidden;
  background: color-mix(in oklab, var(--cc-text-muted) 22%, transparent);
}
.cc-progress-fill { display: block; height: 100%; background: var(--cc-accent); border-radius: inherit; }
.cc-progress-figure { font-size: var(--cc-text-label); color: var(--cc-text); font-variant-numeric: tabular-nums; }
/* Named apart from the composer's .cc-steps plan list, whose later layer would otherwise restyle these. */
.cc-progress-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.cc-progress-step {
  display: flex; align-items: flex-start; gap: var(--cc-space-sm); padding: var(--cc-space-xs) 0;
  border-bottom: var(--cc-line, 1px solid) var(--cc-border);
}
.cc-progress-step:last-child { border-bottom: none; }
.cc-progress-step-mark {
  flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: var(--cc-radius-pill);
  font-size: var(--cc-text-label); font-weight: 700; color: var(--cc-text-muted); border: var(--cc-line, 1px solid) var(--cc-border);
}
.cc-progress-step[data-step-status="done"] .cc-progress-step-mark { color: var(--cc-success); border-color: color-mix(in oklab, var(--cc-success) 45%, transparent); }
.cc-progress-step[data-step-status="current"] .cc-progress-step-mark { color: var(--cc-accent); border-color: var(--cc-accent); }
.cc-progress-step[data-step-status="failed"] .cc-progress-step-mark { color: var(--cc-danger); border-color: color-mix(in oklab, var(--cc-danger) 45%, transparent); }
.cc-progress-step-text { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.cc-progress-step-label { font-size: var(--cc-text-body-sm); color: var(--cc-text); overflow-wrap: anywhere; }
.cc-progress-step[data-step-status="current"] .cc-progress-step-label { font-weight: 600; }
.cc-progress-step[data-step-status="skipped"] .cc-progress-step-label { color: var(--cc-text-muted); }
.cc-progress-step-detail { font-size: var(--cc-text-label); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-progress-step-status { flex: none; font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-progress-step[data-step-status="failed"] .cc-progress-step-status { color: var(--cc-danger); }
/* Its own grid rather than .cc-fields, whose columns the later panels layer sets and would win over these.
   Sized by the card's own width, not the window's: a details card in one column of a layout grid is narrow on a wide
   screen. Labels take at most 40% so a long one wraps instead of pushing the values into a sliver, and a card too
   narrow for two readable columns puts each value under its label. */
.cc-details-box { container-type: inline-size; min-width: 0; }
.cc-details { display: grid; grid-template-columns: fit-content(40%) minmax(0, 1fr); gap: var(--cc-space-xs) var(--cc-space-md); margin: 0; }
.cc-details dt { color: var(--cc-text-muted); min-width: 0; }
.cc-details dd { margin: 0; min-width: 0; }
/* Each pair is a row of the parent grid, so a label and its value line up whatever their lengths. */
.cc-details-row { display: contents; }
.cc-details dt, .cc-details dd { overflow-wrap: anywhere; font-size: var(--cc-text-body-sm); }
@container (max-width: 360px) {
  .cc-details { grid-template-columns: minmax(0, 1fr); row-gap: 0; }
  .cc-details dd { margin-bottom: var(--cc-space-sm); }
}

/* Pin shelf */
.cc-pins {
  max-width: var(--cc-conversation-max-width); margin: 0 auto; width: 100%;
  padding: 0 var(--cc-space-lg) var(--cc-space-sm);
  display: flex; gap: var(--cc-space-sm); flex-wrap: wrap;
}
.cc-pin {
  display: flex; align-items: center; gap: var(--cc-space-sm);
  border: var(--cc-line, 1px solid) var(--cc-border); background: var(--cc-card);
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
.cc-terminal-cwd { font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); color: var(--cc-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cc-terminal-line { margin: 0; }
.cc-terminal-line code { font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); overflow-wrap: anywhere; }
.cc-terminal-label { color: var(--cc-text-muted); font-size: var(--cc-text-label); }
.cc-terminal-viewing { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--cc-space-sm); margin: 0; padding: var(--cc-space-xs) var(--cc-space-md); font-size: var(--cc-text-label); color: var(--cc-warning); border-bottom: var(--cc-line, 1px solid) var(--cc-border); }
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
  border-top: var(--cc-line, 1px solid) var(--cc-border);
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
.cc-terminal-panel li { display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-sm); padding: var(--cc-space-xs) 0; border-bottom: var(--cc-line, 1px solid) var(--cc-border); }
.cc-terminal-panel-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--cc-space-sm); min-width: 0; }
.cc-terminal-panel-main code { font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: var(--cc-text-mono-sm); overflow-wrap: anywhere; }
.cc-terminal-panel-meta { font-size: var(--cc-text-meta); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-terminal-panel-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex-shrink: 0; max-width: 45%; text-align: end; }

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
