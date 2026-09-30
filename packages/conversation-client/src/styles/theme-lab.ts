export const THEME_LAB_CSS = `
@layer panels {
.cc-theme-lab { min-width: 0; }
.cc-theme-lab-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-md); margin-bottom: var(--cc-space-lg); }
.cc-theme-lab-canvas { position: relative; transform: translateZ(0); color-scheme: dark; box-sizing: border-box; padding: var(--cc-space-md); color: var(--cc-text); background: var(--cc-canvas); border: var(--cc-line, 1px solid) var(--cc-border); border-radius: var(--cc-radius-card); overflow: hidden; margin-inline: auto; }
.cc-theme-lab-canvas[data-cc-theme="light"] { color-scheme: light; }
.cc-theme-lab-canvas > * + * { margin-top: var(--cc-space-md); }
.cc-theme-lab-canvas .cc-composer-wrap { position: relative; width: 100%; margin-inline: auto; padding-inline: 0; }
.cc-theme-lab-canvas .cc-settings-row { min-width: 0; }
.cc-theme-lab-canvas .cc-modal { max-width: calc(100% - var(--cc-space-lg)); }
.cc-theme-lab pre { max-width: 100%; overflow: auto; font-size: var(--cc-text-mono-sm); }
.cc-theme-gallery-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--cc-space-lg); }
.cc-theme-gallery-layout .cc-theme-options { max-height: 18rem; overflow-y: auto; }
.cc-theme-recent { display: flex; gap: var(--cc-space-sm); flex-wrap: wrap; }
.cc-theme-accent { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-md); }
.cc-theme-accent label { display: flex; align-items: center; gap: var(--cc-space-sm); }
.cc-theme-accent input { width: 7rem; min-height: 2.75rem; color: var(--cc-text); background: var(--cc-card); border: var(--cc-line, 1px solid) var(--cc-border); font: inherit; padding: var(--cc-space-sm); }
}
`;
