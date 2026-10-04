export const THEME_LAB_CSS = `
@layer panels {
.cc-theme-lab { min-width: 0; }
.cc-theme-lab-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-md); margin-bottom: var(--cc-space-lg); }
.cc-theme-lab-canvas { position: relative; transform: translateZ(0); color-scheme: dark; box-sizing: border-box; padding: var(--cc-space-md); color: var(--cc-text); background: var(--cc-canvas); border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-card); overflow: hidden; margin-inline: auto; }
.cc-theme-lab-canvas[data-cc-theme="light"] { color-scheme: light; }
.cc-theme-lab-canvas { isolation: isolate; font-family: var(--cc-font-body, "Plus Jakarta Sans Variable", ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif); }
.cc-theme-lab-canvas h3 { font-family: var(--cc-font-display, "Plus Jakarta Sans Variable", ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif); font-weight: var(--cc-weight-heading, 600); }
.cc-theme-lab-canvas .cc-dot-grid::after { background-image: inherit; }
.cc-theme-lab-canvas > * + * { margin-top: var(--cc-space-md); }
.cc-theme-lab-canvas .cc-composer-wrap { position: relative; width: 100%; margin-inline: auto; padding-inline: 0; }
.cc-theme-lab-canvas .cc-settings-row { min-width: 0; }
.cc-theme-lab-canvas .cc-modal { max-width: calc(100% - var(--cc-space-lg)); }
.cc-theme-lab pre { max-width: 100%; overflow: auto; font-size: var(--cc-text-mono-sm); }
.cc-theme-gallery-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--cc-space-lg); }
.cc-theme-gallery-layout .cc-theme-options { max-height: 18rem; overflow-y: auto; }
.cc-theme-picker { display: flex; flex-direction: column; align-items: stretch; gap: var(--cc-space-sm); }
.cc-theme-picker > [data-theme-browse] { align-self: flex-start; }
.cc-theme-recent { display: flex; align-items: center; gap: var(--cc-space-sm); flex-wrap: wrap; }
.cc-theme-recent > span { font-size: var(--cc-text-label); line-height: var(--cc-leading-label); color: var(--cc-text-muted); }
.cc-theme-accent { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-md); }
.cc-theme-accent label { display: flex; align-items: center; gap: var(--cc-space-sm); }
.cc-theme-accent label { color: var(--cc-text-muted); font-size: var(--cc-text-body-sm); }
.cc-theme-accent input {
  width: 7rem; min-height: 2.75rem; box-sizing: border-box; color: var(--cc-text); font: inherit;
  font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); padding: var(--cc-space-xs) var(--cc-space-sm);
  background: var(--cc-input-bg, var(--cc-card)); border: var(--cc-line, 1px solid) var(--cc-border);
  border-color: var(--cc-input-edge, color-mix(in oklab, var(--cc-text) 12%, var(--cc-border))); border-radius: var(--cc-input-radius, var(--cc-radius-button));
}
.cc-theme-accent input:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 1px; }
/*
 * The customisation block opens a new group under the theme, so it is headed like one. The theme row above already
 * ends on a hairline; a second one here drew two rules a few pixels apart.
 */
[data-theme-customization] > h4 {
  margin: var(--cc-space-lg) 0 var(--cc-space-sm);
  font-size: var(--cc-text-label); line-height: var(--cc-leading-label);
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--cc-text-muted); font-weight: 600;
}
/*
 * A typeface choice is a row of specimens. Each tile sets its sample large and its name small in its own face (the
 * face arrives inline, from the same stack the compiler would write), so the row reads as a type sheet rather than a
 * list of names. The chosen tile carries fill, border and weight together, like a segmented choice.
 */
.cc-font-picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(6.25rem, 1fr)); gap: var(--cc-space-sm); }
.cc-font-picker[data-pending="true"] { opacity: 0.6; }
.cc-font-option {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--cc-space-xxs); min-width: 0;
  padding: var(--cc-space-sm) var(--cc-space-sm) var(--cc-space-xs); cursor: pointer; text-align: left; color: var(--cc-text-muted);
  background: var(--cc-window); border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-button);
  transition: background-color var(--cc-motion-micro) var(--cc-motion-easing), color var(--cc-motion-micro) var(--cc-motion-easing), border-color var(--cc-motion-micro) var(--cc-motion-easing);
}
.cc-font-option:hover { color: var(--cc-text); border-color: color-mix(in oklab, var(--cc-text) 22%, var(--cc-border)); }
.cc-font-option[data-selected="true"] {
  color: var(--cc-text);
  background: color-mix(in oklab, var(--cc-accent) 14%, var(--cc-elevated));
  border-color: color-mix(in oklab, var(--cc-accent) 55%, transparent);
}
.cc-font-option:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-font-option-sample { font-size: 1.5rem; line-height: 1.1; font-weight: 500; color: var(--cc-text); }
.cc-font-option-name {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--cc-text-label); line-height: var(--cc-leading-label);
}
.cc-font-option[data-selected="true"] .cc-font-option-name { font-weight: 600; }
}
`;
