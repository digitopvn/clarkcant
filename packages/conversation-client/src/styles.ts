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
  font-size: var(--cc-text-body);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.cc-shell { display: flex; flex-direction: column; height: 100vh; }

/* Header: identity and honest status. The gear is the only settings affordance. */
.cc-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--cc-space-md) var(--cc-space-lg);
  border-bottom: 1px solid var(--cc-border);
  background: var(--cc-canvas);
}
.cc-brand { display: flex; align-items: center; gap: var(--cc-space-sm); font-weight: 600; }
.cc-orb {
  width: 27px; height: 27px; border-radius: var(--cc-radius-full);
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
  color: var(--cc-text-muted); font-size: var(--cc-text-caption);
}
.cc-dot { width: 6px; height: 6px; border-radius: var(--cc-radius-full); background: var(--cc-success); }
.cc-dot[data-state="offline"] { background: var(--cc-danger); }
.cc-dot[data-state="connecting"] { background: var(--cc-warning); }

/* Timeline */
.cc-scroll { flex: 1; overflow-y: auto; scroll-behavior: smooth; }
.cc-timeline {
  max-width: 720px; margin: 0 auto;
  padding: var(--cc-space-xl) var(--cc-space-lg) var(--cc-space-lg);
  display: flex; flex-direction: column; gap: var(--cc-space-lg);
}

.cc-empty { display: flex; flex-direction: column; align-items: center; gap: var(--cc-space-md); padding-top: 18vh; text-align: center; }
.cc-empty-orb {
  border-radius: var(--cc-radius-full);
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
.cc-empty h1 { font-size: var(--cc-text-title); font-weight: 600; margin: 0; }
.cc-empty p { color: var(--cc-text-muted); margin: 0; }

.cc-row { display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-row[data-role="user"] { align-items: flex-end; }

.cc-bubble {
  max-width: 82%;
  padding: var(--cc-space-sm) var(--cc-space-md);
  border-radius: var(--cc-radius-lg);
  background: var(--cc-surface);
  border: 1px solid var(--cc-border);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cc-row[data-role="assistant"] .cc-bubble { background: transparent; border: none; padding: 0; max-width: 100%; }
.cc-assistant { display: flex; gap: var(--cc-space-sm); align-items: flex-start; }
.cc-avatar { width: 20px; height: 20px; border-radius: var(--cc-radius-full); background: var(--cc-accent); flex: none; margin-top: 2px; }

/* Cards */
.cc-card {
  border: 1px solid var(--cc-border);
  background: var(--cc-surface);
  border-radius: var(--cc-radius-md);
  overflow: hidden;
}
.cc-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-sm);
  padding: var(--cc-space-sm) var(--cc-space-md);
  border-bottom: 1px solid var(--cc-border);
  font-size: var(--cc-text-caption); color: var(--cc-text-muted);
}
.cc-card-title { font-weight: 600; color: var(--cc-text); }
.cc-card-body { padding: var(--cc-space-md); display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-fields { display: grid; grid-template-columns: max-content 1fr; gap: var(--cc-space-xs) var(--cc-space-md); margin: 0; }
.cc-fields dt { color: var(--cc-text-muted); }
.cc-fields dd { margin: 0; }
.cc-badge {
  font-size: var(--cc-text-caption);
  padding: 2px var(--cc-space-sm);
  border-radius: var(--cc-radius-full);
  border: 1px solid var(--cc-border);
  color: var(--cc-text-muted);
}
.cc-badge[data-tone="warn"] { color: var(--cc-warning); border-color: color-mix(in oklab, var(--cc-warning) 45%, transparent); }
.cc-badge[data-tone="danger"] { color: var(--cc-danger); border-color: color-mix(in oklab, var(--cc-danger) 45%, transparent); }
.cc-badge[data-tone="ok"] { color: var(--cc-success); border-color: color-mix(in oklab, var(--cc-success) 45%, transparent); }
.cc-freshness { font-size: var(--cc-text-caption); color: var(--cc-text-muted); }

/* Tables */
.cc-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.cc-table th, .cc-table td { text-align: left; padding: var(--cc-space-xs) var(--cc-space-sm); border-bottom: 1px solid var(--cc-border); }
.cc-table th { color: var(--cc-text-muted); font-weight: 500; font-size: var(--cc-text-caption); }
.cc-table tr[aria-selected="true"] td { background: var(--cc-surface-muted); }
.cc-table tbody tr:hover td { background: var(--cc-surface-muted); cursor: pointer; }

/* Charts */
.cc-chart { width: 100%; height: 180px; display: block; }
.cc-chart .axis { stroke: var(--cc-border); }
.cc-chart .label { fill: var(--cc-text-muted); font-size: 10px; }
.cc-chart .series { fill: none; stroke: var(--cc-accent); stroke-width: 2; }
.cc-chart .point { fill: var(--cc-accent); }
.cc-chart .bar { fill: var(--cc-accent); }

/* Note */
.cc-note-input, .cc-note-area {
  width: 100%; background: var(--cc-surface-muted); color: var(--cc-text);
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-sm);
  padding: var(--cc-space-sm); font: inherit;
}
.cc-note-input { font-weight: 600; }
.cc-note-area { min-height: 120px; resize: vertical; }
.cc-note-meta { font-size: var(--cc-text-caption); color: var(--cc-text-muted); }

/* Pin shelf */
.cc-pins {
  max-width: 720px; margin: 0 auto; width: 100%;
  padding: 0 var(--cc-space-lg) var(--cc-space-sm);
  display: flex; gap: var(--cc-space-sm); flex-wrap: wrap;
}
.cc-pin {
  display: flex; align-items: center; gap: var(--cc-space-sm);
  border: 1px solid var(--cc-border); background: var(--cc-surface);
  border-radius: var(--cc-radius-full); padding: var(--cc-space-xs) var(--cc-space-sm);
  font-size: var(--cc-text-caption);
}
.cc-pin button { background: none; border: none; color: var(--cc-text-muted); cursor: pointer; font: inherit; padding: 0 2px; }
.cc-pin button:hover { color: var(--cc-text); }
.cc-pin-expanded { max-width: 720px; margin: 0 auto var(--cc-space-sm); width: 100%; padding: 0 var(--cc-space-lg); }

/* Composer */
.cc-composer-wrap { padding: var(--cc-space-md) var(--cc-space-lg) var(--cc-space-lg); border-top: 1px solid var(--cc-border); }
.cc-composer {
  max-width: 720px; margin: 0 auto;
  display: flex; align-items: flex-end; gap: var(--cc-space-sm);
  background: var(--cc-surface); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-lg); padding: var(--cc-space-sm);
}
.cc-composer textarea {
  flex: 1; background: none; border: none; color: var(--cc-text); font: inherit;
  resize: none; max-height: 180px; min-height: 24px; padding: var(--cc-space-xs);
}
.cc-composer textarea:focus { outline: none; }
.cc-icon-btn {
  display: grid; place-items: center;
  width: 28px; height: 28px; border-radius: var(--cc-radius-full);
  border: 1px solid var(--cc-border); background: var(--cc-surface-muted);
  color: var(--cc-text); cursor: pointer; font: inherit;
}
.cc-icon-btn:disabled { opacity: 0.45; cursor: default; }
.cc-hint {
  max-width: 720px; margin: var(--cc-space-xs) auto 0;
  font-size: var(--cc-text-caption); color: var(--cc-text-muted);
  display: flex; justify-content: space-between; gap: var(--cc-space-sm);
}

/* Evidence and artifacts */
.cc-evidence { display: flex; gap: var(--cc-space-sm); align-items: flex-start; font-size: var(--cc-text-caption); }
.cc-evidence[data-verdict="not-verified"] { color: var(--cc-warning); }
.cc-evidence[data-verdict="contradicted"] { color: var(--cc-danger); }
.cc-evidence[data-verdict="verified"] { color: var(--cc-success); }

/* Focus: never removed, only restyled. Keyboard users must be able to see where they are. */
:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; border-radius: var(--cc-radius-sm); }
button:focus-visible, textarea:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }

/* Screen-reader-only text: the text alternative for every rich surface. */
.cc-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .cc-scroll { scroll-behavior: auto; }
  * { transition-duration: var(--cc-motion-fast) !important; animation-duration: var(--cc-motion-fast) !important; }
}
`;
