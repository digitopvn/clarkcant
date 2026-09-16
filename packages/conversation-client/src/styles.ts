/**
 * Component stylesheet.
 *
 * One string rather than a CSS file so a host can inject it without a bundler plugin, and
 * so the desktop shell and the web client cannot drift into two different looks. Every
 * colour and duration is a token variable, which means the WCAG audit in
 * `@clarkcant/design-tokens` is auditing the values this sheet actually uses.
 */
export const APP_CSS = `
* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--cc-canvas);
  color: var(--cc-text);
  /*
   * Plus Jakarta Sans first, with the previous system stack kept behind it.
   *
   * The font is not bundled here. This package is a component library and ships no font files, so
   * the host loads them and this names the family it should load. A host that does not is not
   * broken: the stack falls through to the system faces, which is what this sheet used before.
   * The family name is "...Variable" because that is what the variable-weight files register.
   */
  font-family: "Plus Jakarta Sans Variable", ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
  font-size: var(--cc-text-body-md);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.cc-shell { display: flex; flex-direction: column; height: 100vh; }

/* Header: identity and honest status. The gear is the only settings affordance. */
.cc-header {
  display: flex; align-items: center; justify-content: space-between;
  min-height: var(--cc-topbar-height);
  padding: var(--cc-space-md) var(--cc-space-lg);
  border-bottom: 1px solid var(--cc-border);
  background: var(--cc-canvas);
}
.cc-brand { display: flex; align-items: center; gap: var(--cc-space-sm); font-weight: 600; }
.cc-header-end { display: flex; align-items: center; gap: var(--cc-space-md); }
.cc-orb {
  width: 27px; height: 27px; border-radius: var(--cc-radius-pill);
  display: block; flex: none;
  /*
   * The fallback is scoped to the fallback state. The canvas is transparent so it can composite
   * over any surface, which means background painted on the element shows *through* a working orb
   * rather than being covered by it — a band of gradient across the middle of a sphere that
   * already has its own.
   */
}
.cc-orb[data-orb="fallback"] {
  background: radial-gradient(circle at 32% 28%, var(--cc-accent), color-mix(in oklab, var(--cc-accent) 40%, transparent));
}
.cc-status {
  display: flex; align-items: center; gap: var(--cc-space-xs);
  color: var(--cc-text-muted); font-size: var(--cc-text-label);
}
.cc-dot { width: 6px; height: 6px; border-radius: var(--cc-radius-pill); background: var(--cc-success); }
.cc-dot[data-state="offline"] { background: var(--cc-danger); }
.cc-dot[data-state="connecting"] { background: var(--cc-warning); }

/* Timeline */
.cc-scroll { flex: 1; overflow-y: auto; scroll-behavior: smooth; }
.cc-timeline {
  max-width: var(--cc-conversation-max-width); margin: 0 auto;
  padding: var(--cc-space-xl) var(--cc-space-lg) var(--cc-space-lg);
  display: flex; flex-direction: column; gap: var(--cc-space-lg);
}

.cc-empty { display: flex; flex-direction: column; align-items: center; gap: var(--cc-space-md); padding-top: 18vh; text-align: center; }
.cc-empty-orb {
  border-radius: var(--cc-radius-pill);
  display: block;
  flex: none;
}
/*
 * The same idea at a larger scale, and scoped the same way: a dark glass ball with a spectral band
 * across it, so the fallback is recognisably the same object the shader draws. It must not be the
 * element's ordinary background, because the working canvas is transparent where the glow is and
 * would let this show through. No blur filter either — it would soften the WebGL output rather
 * than the fallback.
 */
.cc-empty-orb[data-orb="fallback"] {
  background:
    radial-gradient(ellipse 78% 11% at 50% 50%, #ffffff 0%, #ffd86b 22%, #82f4ff 40%, #ff7bd5 62%, #8e6cff 82%, transparent 100%),
    radial-gradient(circle at 50% 46%, #2a2350 0%, #161231 45%, #0b0a1c 100%);
}
.cc-empty h1 { font-size: var(--cc-text-heading-md); font-weight: 600; margin: 0; }
.cc-empty p { color: var(--cc-text-muted); margin: 0; }

.cc-row { display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-row[data-role="user"] { align-items: flex-end; }

.cc-bubble {
  max-width: 82%;
  padding: var(--cc-space-sm) var(--cc-space-md);
  border-radius: var(--cc-radius-response);
  background: var(--cc-card);
  border: 1px solid var(--cc-border);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cc-row[data-role="assistant"] .cc-bubble { background: transparent; border: none; padding: 0; max-width: 100%; }
.cc-assistant { display: flex; gap: var(--cc-space-sm); align-items: flex-start; }
.cc-avatar { width: 20px; height: 20px; border-radius: var(--cc-radius-pill); background: var(--cc-accent); flex: none; margin-top: 2px; }

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

/* Composer */
.cc-composer-wrap { padding: var(--cc-space-md) var(--cc-space-lg) var(--cc-space-lg); border-top: 1px solid var(--cc-border); }
.cc-composer {
  /* Deliberately wider than the column above it, so the input a message is typed into reads as
     the control it is rather than as one more line of the transcript. */
  max-width: var(--cc-composer-max-width); margin: 0 auto;
  min-height: var(--cc-composer-min-height);
  display: flex; align-items: flex-end; gap: var(--cc-space-sm);
  background: var(--cc-card); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-response); padding: var(--cc-space-sm);
}
.cc-composer textarea {
  flex: 1; background: none; border: none; color: var(--cc-text); font: inherit;
  resize: none; max-height: 180px; min-height: 24px; padding: var(--cc-space-xs);
}
.cc-composer textarea:focus { outline: none; }
.cc-icon-btn {
  display: grid; place-items: center;
  width: 28px; height: 28px; border-radius: var(--cc-radius-pill);
  border: 1px solid var(--cc-border); background: var(--cc-elevated);
  color: var(--cc-text); cursor: pointer; font: inherit;
}
.cc-icon-btn:disabled { opacity: 0.45; cursor: default; }
.cc-hint {
  max-width: var(--cc-composer-max-width); margin: var(--cc-space-xs) auto 0;
  font-size: var(--cc-text-label); color: var(--cc-text-muted);
  display: flex; justify-content: space-between; gap: var(--cc-space-sm);
}

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
.cc-panel-row { display: flex; flex-wrap: wrap; gap: var(--cc-space-sm); align-items: center; }
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

@media (prefers-reduced-motion: reduce) {
  .cc-scroll { scroll-behavior: auto; }
  * { transition-duration: var(--cc-motion-micro) !important; animation-duration: var(--cc-motion-micro) !important; }
}
`;
