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

.cc-shell { display: flex; flex-direction: column; height: 100vh; position: relative; overflow: hidden; }

/*
 * Everything between the header and the foot of the window.
 *
 * Two shapes, and the difference between them is where the composer sits. On the start screen the
 * group — the orb, the heading, the four suggestions and the input — is centred as one thing, so the
 * input is directly under the chips rather than at the foot of the page. Once there is a conversation
 * the transcript takes the space instead and the composer goes to the bottom.
 */
.cc-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cc-shell[data-view="hero"] .cc-body { justify-content: center; }
.cc-shell[data-view="hero"] .cc-scroll { flex: 0 0 auto; overflow: visible; }

/*
 * Entrances.
 *
 * One movement, used by everything that arrives: an element comes up a little and settles, with the
 * overshoot carried by the easing token rather than by keyframes, so the amount of bounce is one
 * decision in the token set. The delay is a custom property because the only caller that needs one is
 * a list, where the stagger is what turns four arrivals into a sequence.
 */
@keyframes cc-enter {
  from { opacity: 0; transform: translateY(12px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
.cc-empty > *,
.cc-row,
.cc-card,
.cc-chip,
.cc-pin {
  animation: cc-enter var(--cc-motion-enter) var(--cc-motion-bounce) both;
  animation-delay: var(--cc-enter-delay, 0ms);
}
/* The four suggestions land one after another instead of all at once. */
.cc-chip-row > .cc-chip { animation-delay: calc(var(--cc-chip-index, 0) * 70ms + 120ms); }

/* Header: identity and honest status. The gear is the only settings affordance. */
.cc-header {
  display: flex; align-items: center; justify-content: space-between;
  min-height: var(--cc-topbar-height);
  padding: var(--cc-space-md) var(--cc-space-lg);
  border-bottom: 1px solid var(--cc-border);
  background: var(--cc-canvas);
}
.cc-brand {
  display: flex; align-items: center; gap: var(--cc-space-sm); font-weight: 600;
  /*
   * A button, so that it can be reached by keyboard and announced by a screen reader — but reset
   * back to the wordmark it looks like. A control that announces itself as a button in the header
   * would change the layout the design asked for, and the focus ring it needs is already provided
   * by the global :focus-visible rule.
   */
  background: none; border: 0; padding: 0; margin: 0; font: inherit; color: inherit; cursor: pointer;
}
.cc-brand:hover { opacity: 0.82; }
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
.cc-scroll {
  flex: 1; min-height: 0; overflow-y: auto; scroll-behavior: smooth;
  /* Positioned so the leaving hero can be taken out of the flow inside it, and below the orb layer
     so the transcript is never drawn over the orb's light. */
  position: relative; z-index: 0;
}
.cc-timeline {
  max-width: var(--cc-conversation-max-width); margin: 0 auto;
  padding: var(--cc-space-xl) var(--cc-space-lg) var(--cc-space-lg);
  display: flex; flex-direction: column; gap: var(--cc-space-lg);
}
/*
 * Room at the foot of the transcript for the part of the orb that shows above the composer. The orb is
 * large and dim, so the room is proportionate to what is actually visible rather than to its full size:
 * padding equal to the whole diameter would push the last message most of a screen away.
 */
.cc-shell[data-view="conversation"] .cc-timeline {
  padding-bottom: calc(var(--cc-orb-dock, 0px) / 6 + var(--cc-space-xl));
}

.cc-empty {
  display: flex; flex-direction: column; align-items: center; gap: var(--cc-space-md);
  padding: var(--cc-space-lg) var(--cc-space-lg) var(--cc-space-xl); text-align: center;
}
/*
 * Leaving.
 *
 * The hero stays mounted for a moment after the first message, out of the flow: it has to be able to
 * fade and slide as its own thing while the message that replaced it is already at the top of the
 * transcript. Interactivity is off from the first frame of the exit — a chip that could still be
 * clicked while it is on its way out is a control that would send a message from a screen the user
 * has left.
 */
.cc-shell[data-view="conversation"] .cc-empty {
  position: absolute; inset: 0; justify-content: center; z-index: 1;
  pointer-events: none;
}
@keyframes cc-hero-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes cc-chip-out {
  from { opacity: 1; transform: none; }
  to { opacity: 0; transform: translateY(-30px) scale(0.94); }
}
.cc-empty[data-leaving="true"] { animation: cc-hero-out var(--cc-hero-exit, 320ms) var(--cc-motion-easing) both; }
.cc-empty[data-leaving="true"] > * {
  animation: cc-chip-out var(--cc-hero-exit, 320ms) var(--cc-motion-easing) both;
}
/* The chips go one at a time, which is the whole reason the hero is held on screen for the exit. */
.cc-empty[data-leaving="true"] .cc-chip-row > .cc-chip {
  animation: cc-chip-out var(--cc-motion-exit) var(--cc-motion-bounce) both;
  animation-delay: calc(var(--cc-chip-index, 0) * var(--cc-chip-stagger, 90ms));
}
/*
 * The space the orb is placed against while the start screen is up. Reserved rather than drawn: the
 * orb itself lives in the layer behind the composer, because one element that moves between two
 * places cannot also be a layout child of both.
 */
/* The ball is drawn at 0.54 of the canvas, so a 197 pixel anchor reserves the space a 148 pixel ball
   occupied before the canvas grew. */
.cc-hero-orb { width: 197px; height: 197px; flex: none; visibility: hidden; }
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

/*
 * Message frame.
 *
 * The two sides are deliberately not symmetrical. The user's message is a bubble, right-aligned: it is
 * their own words coming back at a glance, and the frame is what makes it skippable when scrolling for
 * the answer. A reply is full width with the agent's mark beside it, because it is the agent speaking
 * rather than an utterance to be skimmed.
 */
.cc-bubble {
  max-width: 82%;
  padding: var(--cc-space-sm) var(--cc-space-md);
  border-radius: var(--cc-radius-response);
  background: var(--cc-card);
  border: 1px solid var(--cc-border);
  overflow-wrap: anywhere;
}
.cc-row[data-role="assistant"] .cc-bubble { background: transparent; border: none; padding: 0; max-width: 100%; }
.cc-assistant { display: flex; gap: var(--cc-space-sm); align-items: flex-start; }
/* The agent's mark: the same orb as the header and the dock, at the size a reply can carry. */
.cc-avatar {
  width: 28px; height: 28px; border-radius: var(--cc-radius-pill);
  display: block; flex: none; margin-top: 2px;
  /* The canvas is transparent so its glow composites over the page; only the fallback paints a
     background, and painting one under a working orb would show a disc behind its own glow. */
}
.cc-avatar[data-orb="fallback"] {
  background:
    radial-gradient(ellipse 78% 11% at 50% 50%, #ffffff 0%, #ffd86b 22%, #82f4ff 40%, #ff7bd5 62%, #8e6cff 82%, transparent 100%),
    radial-gradient(circle at 50% 46%, #2a2350 0%, #161231 45%, #0b0a1c 100%);
}
.cc-assistant-body { display: flex; flex-direction: column; gap: var(--cc-space-sm); min-width: 0; flex: 1; }

/*
 * Markdown.
 *
 * Sizes are relative to the message text, so a heading in a reply is a heading in the same scale as the
 * paragraph under it rather than the page's own display sizes. The first and last child lose their
 * margins: a message is one block of prose, and its outer edges should sit flush in the row.
 */
.cc-md > *:first-child { margin-top: 0; }
.cc-md > *:last-child { margin-bottom: 0; }
.cc-md p { margin: 0 0 var(--cc-space-sm); }
.cc-md h1, .cc-md h2, .cc-md h3, .cc-md h4, .cc-md h5, .cc-md h6 {
  margin: var(--cc-space-md) 0 var(--cc-space-xs); line-height: 1.3;
}
.cc-md h1 { font-size: var(--cc-text-heading-md); }
.cc-md h2 { font-size: var(--cc-text-body-lg, var(--cc-text-body-md)); font-weight: 600; }
.cc-md h3, .cc-md h4, .cc-md h5, .cc-md h6 { font-size: var(--cc-text-body-md); font-weight: 600; }
.cc-md-list { margin: 0 0 var(--cc-space-sm); padding-left: var(--cc-space-lg); display: flex; flex-direction: column; gap: var(--cc-space-xxs); }
.cc-md-list li[data-task] { list-style: none; display: flex; gap: var(--cc-space-sm); align-items: baseline; }
.cc-md-list { list-style-position: outside; }
.cc-md-check { color: var(--cc-success); flex: none; }
.cc-md blockquote {
  margin: 0 0 var(--cc-space-sm); padding: var(--cc-space-xs) var(--cc-space-md);
  border-left: 2px solid var(--cc-border); color: var(--cc-text-muted);
}
.cc-md hr { border: none; border-top: 1px solid var(--cc-border); margin: var(--cc-space-md) 0; }
.cc-md a { color: var(--cc-accent); }
.cc-md-inline-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm);
  background: var(--cc-elevated); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-badge); padding: 0 4px;
}
.cc-md-literal { color: var(--cc-text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); }
.cc-md-table-wrap { overflow-x: auto; margin: 0 0 var(--cc-space-sm); }
.cc-md-table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
.cc-md-table th, .cc-md-table td { text-align: left; padding: var(--cc-space-xs) var(--cc-space-sm); border-bottom: 1px solid var(--cc-border); }
.cc-md-table th { color: var(--cc-text-muted); font-weight: 500; font-size: var(--cc-text-label); }
.cc-md-table [data-align="center"] { text-align: center; }
.cc-md-table [data-align="right"] { text-align: right; }

/*
 * Fenced code.
 *
 * The header names the language, which is what tells a reader whether the block is theirs to run, and
 * the body scrolls sideways rather than wrapping: a wrapped line of code is a line that no longer reads
 * as code.
 */
.cc-code {
  border: 1px solid var(--cc-border); background: var(--cc-code);
  border-radius: var(--cc-radius-card); overflow: hidden;
}
.cc-code-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--cc-space-xxs) var(--cc-space-sm);
  border-bottom: 1px solid var(--cc-border);
  font-size: var(--cc-text-meta); color: var(--cc-text-tertiary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.cc-code-body { margin: 0; padding: var(--cc-space-sm); overflow-x: auto; }
.cc-code-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm);
  white-space: pre; color: var(--cc-text);
}
/*
 * Highlight tokens.
 *
 * Derived from the theme's own colours with color-mix rather than taken from one of the
 * highlighter's themes: those themes are fixed palettes that ignore this product's contrast work, and
 * a hand-picked hex here would be a colour nothing audits.
 */
.hljs-comment, .hljs-quote { color: var(--cc-text-tertiary); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-doctag, .hljs-name { color: var(--cc-accent); }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-attribute, .hljs-meta .hljs-string { color: color-mix(in oklab, var(--cc-success) 82%, var(--cc-text)); }
.hljs-number, .hljs-symbol, .hljs-bullet, .hljs-link { color: color-mix(in oklab, var(--cc-warning) 80%, var(--cc-text)); }
.hljs-title, .hljs-title.function_, .hljs-function .hljs-title { color: color-mix(in oklab, var(--cc-accent) 55%, var(--cc-text)); }
.hljs-variable, .hljs-template-variable, .hljs-params, .hljs-property, .hljs-attr { color: color-mix(in oklab, var(--cc-text) 92%, var(--cc-accent)); }
.hljs-type, .hljs-class .hljs-title, .hljs-built_in, .hljs-builtin-name { color: color-mix(in oklab, var(--cc-success) 60%, var(--cc-accent)); }
.hljs-deletion { color: var(--cc-danger); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }

/*
 * The caret that follows a streamed reply.
 *
 * A separate element rather than a pseudo-element after the text, because the reply is now a tree of elements
 * and there is no single node to hang it from.
 */
.cc-caret {
  display: inline-block; width: 0.5em; height: 1em; margin-left: 2px;
  background: var(--cc-accent); vertical-align: text-bottom;
  animation: cc-caret calc(var(--cc-motion-orb) / 1.2) step-end infinite;
}

/*
 * The thinking marker, and the caret that replaces it.
 *
 * Both are the same statement at two moments: something is being written. The dots stop as soon as
 * there is text, because an indicator that outlives the first token is claiming the opposite of what
 * the screen shows.
 */
.cc-thinking { display: flex; align-items: center; gap: 5px; min-height: 24px; }
.cc-thinking-dot {
  width: 7px; height: 7px; border-radius: var(--cc-radius-pill);
  background: var(--cc-accent); opacity: 0.35;
  animation: cc-thinking var(--cc-motion-orb) var(--cc-motion-easing) infinite;
}
.cc-thinking-dot:nth-child(2) { animation-delay: calc(var(--cc-motion-orb) / 4); }
.cc-thinking-dot:nth-child(3) { animation-delay: calc(var(--cc-motion-orb) / 2); }
@keyframes cc-thinking {
  0%, 100% { opacity: 0.3; transform: translateY(0) scale(0.9); }
  45% { opacity: 1; transform: translateY(-3px) scale(1); }
}
.cc-text[data-streaming="true"]::after { content: none; }
@keyframes cc-caret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }

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

/* Composer */
.cc-composer-wrap {
  padding: var(--cc-space-md) var(--cc-space-lg) var(--cc-space-lg);
  /*
   * Floating, with no bar and no divider.
   *
   * The design puts the composer in the middle of the page as a pill, and a divider across the whole width
   * turns it into a toolbar instead. The trade is that the orb behind it is no longer hidden by an opaque
   * strip, which is why the stage masks its own lower half (see the orb stage rule below).
   */
  position: relative; z-index: 2;
}
/* The start screen has no bar either: the composer floats under the chips as one composition. */
.cc-shell[data-view="hero"] .cc-composer-wrap { padding-bottom: var(--cc-space-md); }
/*
 * The composer's frame, and the light that travels around it.
 *
 * The ring is a square of conic gradient, much larger than the composer and rotating inside a frame
 * that clips it to the composer's outline. Rotating a gradient rather than animating a gradient's
 * angle keeps this working on browsers that have no support for registered custom properties, where
 * an animated angle in a conic-gradient would simply never interpolate.
 */
.cc-composer-shell {
  position: relative;
  max-width: var(--cc-composer-max-width); margin: 0 auto;
  /* A stadium, as the design draws it: the radius is half the height for a single line, and the shape
     stays a pill as it grows because the radius is larger than half of the tallest it gets. */
  border-radius: var(--cc-radius-pill);
}
.cc-composer-glow {
  position: absolute; inset: -1.5px; border-radius: inherit; overflow: hidden;
  pointer-events: none; z-index: 0;
  box-shadow: 0 0 24px color-mix(in oklab, var(--cc-accent) 24%, transparent);
}
.cc-composer-glow::before {
  content: ""; position: absolute; left: 50%; top: 50%; width: 200%; aspect-ratio: 1 / 1;
  transform: translate(-50%, -50%);
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    transparent 214deg,
    color-mix(in oklab, var(--cc-accent) 50%, transparent) 266deg,
    var(--cc-accent) 300deg,
    color-mix(in oklab, var(--cc-accent) 40%, transparent) 332deg,
    transparent 360deg
  );
  animation: cc-glow-orbit var(--cc-motion-glow) linear infinite;
}
@keyframes cc-glow-orbit { to { transform: translate(-50%, -50%) rotate(1turn); } }

.cc-composer {
  /* Deliberately wider than the column above it, so the input a message is typed into reads as
     the control it is rather than as one more line of the transcript. */
  position: relative; z-index: 1;
  min-height: var(--cc-composer-min-height);
  display: flex;
  /*
   * Centred, not bottom-aligned.
   *
   * Bottom-aligned was the shape the buttons took when the field grew: the icons sat on the last line
   * of the text with all the empty height above them, and the control read as though it had come
   * apart. Centring keeps the row as one object at every height.
   */
  align-items: center;
  gap: var(--cc-space-sm);
  background: var(--cc-card); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-pill);
  /* A heavier padding than the composer's own inline spacing, because a pill that floats needs a
     silhouette rather than a box, and a soft shadow is what separates it from the transcript behind. */
  padding: var(--cc-space-sm) var(--cc-space-md);
  box-shadow: 0 12px 32px color-mix(in oklab, var(--cc-code) 42%, transparent);
}
.cc-composer textarea {
  flex: 1; background: none; border: none; color: var(--cc-text); font: inherit;
  /* The height is set from the content by the component, within the five-line ceiling it enforces;
     resizing by hand is off, because a drag handle in the corner of a control that already grows by
     itself is a second, disagreeing way to size it. */
  resize: none; padding: var(--cc-space-xs);
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

/*
 * Task cards.
 *
 * The step marker is a glyph and a status attribute, not a coloured dot: the state has to
 * survive a monochrome screen and a black-and-white screenshot, which a colour alone does not.
 */
.cc-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-steps li { display: flex; align-items: baseline; gap: var(--cc-space-sm); font-size: var(--cc-text-body-md); line-height: var(--cc-leading-body-md); }
.cc-step-mark { flex: none; width: 1em; text-align: center; color: var(--cc-text-tertiary); }
.cc-steps li[data-step-status="active"] .cc-step-mark { color: var(--cc-accent); }
.cc-steps li[data-step-status="done"] .cc-step-mark { color: var(--cc-success); }
.cc-steps li[data-step-status="failed"] .cc-step-mark { color: var(--cc-danger); }
.cc-steps li[data-step-status="active"] .cc-step-label { color: var(--cc-text); font-weight: 600; }
.cc-steps li[data-step-status="done"] .cc-step-label,
.cc-steps li[data-step-status="skipped"] .cc-step-label,
.cc-steps li[data-step-status="pending"] .cc-step-label { color: var(--cc-text-muted); }
.cc-steps li[data-step-status="skipped"] .cc-step-label { text-decoration: line-through; }
.cc-step-label { flex: 1; }

/*
 * The one-line record of which model answered.
 *
 * Small, muted, and closed: it is a footnote to a reply, and a footnote that competes with the text it
 * annotates has been mis-sized. A disclosure element rather than a button with state, so it is keyboard
 * operable and findable as a disclosure without any JavaScript behind it.
 */
.cc-model-note { font-size: var(--cc-text-label); color: var(--cc-text-muted); }
.cc-model-note-summary { cursor: pointer; display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--cc-space-sm); list-style: none; }
.cc-model-note-summary::-webkit-details-marker { display: none; }
.cc-model-note-summary::before { content: "▸"; color: var(--cc-text-tertiary); font-size: var(--cc-text-meta); }
.cc-model-note[open] > .cc-model-note-summary::before { content: "▾"; }
.cc-model-note-summary:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; border-radius: var(--cc-radius-badge); }
.cc-model-note-meta { color: var(--cc-text-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-meta); }
.cc-model-note-body { padding: var(--cc-space-xs) 0 0 var(--cc-space-md); display: flex; flex-direction: column; gap: var(--cc-space-xs); }

.cc-changes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xxs); font-size: var(--cc-text-label); }
.cc-changes li { display: flex; gap: var(--cc-space-sm); align-items: baseline; }
.cc-change-kind { flex: none; width: 5.5rem; color: var(--cc-text-tertiary); text-transform: uppercase; letter-spacing: 0.04em; font-size: var(--cc-text-meta); }
.cc-changes code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm); color: var(--cc-text-muted); overflow-wrap: anywhere; }
.cc-changes li[data-change-kind="deleted"] code { color: var(--cc-danger); }
.cc-changes li[data-change-kind="created"] code { color: var(--cc-success); }

.cc-task-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-task-list li { display: flex; align-items: baseline; gap: var(--cc-space-sm); font-size: var(--cc-text-body-sm); line-height: var(--cc-leading-body-sm); flex-wrap: wrap; }
.cc-task-list li > span:nth-child(2) { flex: 1; min-width: 12rem; }

/*
 * Diffs.
 *
 * Rendered line by line rather than as one pre-coloured block, so the colours come from the theme
 * and the text stays selectable. The gutter glyph repeats what the colour says, so a line's kind
 * survives without colour.
 */
.cc-diff-file { display: flex; flex-direction: column; gap: var(--cc-space-xxs); margin-bottom: var(--cc-space-sm); }
.cc-diff-file-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--cc-space-sm); }
.cc-diff-file-head code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm); color: var(--cc-text); overflow-wrap: anywhere; }
.cc-diff-hunk { background: var(--cc-code); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-badge); overflow-x: auto; }
.cc-diff-header { padding: 0 var(--cc-space-sm); color: var(--cc-text-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-meta); line-height: var(--cc-leading-meta); background: var(--cc-elevated); }
.cc-diff-line { display: flex; gap: var(--cc-space-sm); padding: 0 var(--cc-space-sm); white-space: pre; }
.cc-diff-line code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); line-height: var(--cc-leading-mono-sm); color: var(--cc-text-muted); }
.cc-diff-gutter { flex: none; width: 1ch; color: var(--cc-text-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-mono-sm); }
.cc-diff-line[data-line-kind="add"] { background: color-mix(in oklab, var(--cc-success) 14%, transparent); }
.cc-diff-line[data-line-kind="add"] .cc-diff-gutter { color: var(--cc-success); }
.cc-diff-line[data-line-kind="remove"] { background: color-mix(in oklab, var(--cc-danger) 14%, transparent); }
.cc-diff-line[data-line-kind="remove"] .cc-diff-gutter { color: var(--cc-danger); }

/*
 * The orb, behind the composer.
 *
 * One element for both screens. It is drawn at the docked size and scaled down to the hero's size, so
 * its drawing buffer never changes: a canvas that resized mid-animation would reallocate GPU memory
 * on every frame, and the shader would restart its own motion from wherever the resize caught it.
 * The position is set by the component, because where it belongs is a measurement — the middle of the
 * start screen, or a third of the way above the composer's frame — and neither is expressible in CSS.
 */
@keyframes cc-orb-in { from { opacity: 0; } to { opacity: 1; } }
.cc-orb-stage {
  position: absolute; inset: 0; pointer-events: none; z-index: 1;
  /*
   * Fading towards the bottom, because the composer no longer clips it.
   *
   * When the composer sat on an opaque bar, the bar was the edge the orb disappeared behind. With the
   * composer floating, the orb would otherwise show its whole lower half around and below the pill. A
   * mask says the same thing the bar said — this is where the orb goes away — without a hard line
   * across the page, and it keeps the light only where it reads as light.
   */
  mask-image: linear-gradient(to bottom, #000 0%, #000 58%, transparent 94%);
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 58%, transparent 94%);
}
.cc-stage-orb {
  position: absolute;
  width: var(--cc-orb-dock, 240px); height: var(--cc-orb-dock, 240px);
  animation: cc-orb-in var(--cc-motion-enter) var(--cc-motion-easing) both;
  transition:
    left var(--cc-motion-orb) var(--cc-motion-easing),
    top var(--cc-motion-orb) var(--cc-motion-easing),
    transform var(--cc-motion-orb) var(--cc-motion-easing);
}
/*
 * In the dock the orb is dimmed and slightly out of focus. It is behind the input rather than beside
 * it, and an orb at full strength under the text being typed competes with the text.
 */
.cc-stage-orb > .cc-empty-orb {
  transition: opacity var(--cc-motion-orb) var(--cc-motion-easing), filter var(--cc-motion-orb) var(--cc-motion-easing);
}
.cc-stage-orb[data-docked="true"] > .cc-empty-orb { opacity: 0.5; filter: blur(1px) brightness(0.85); }

/*
 * Tool activity and reasoning.
 *
 * The same disclosure frame for both, because they are the same kind of thing to a reader: work the
 * agent did that is not the reply. The glyph carries the state, and it is a glyph rather than a colour so
 * the state survives a monochrome screen: a ring while it runs, a tick when it finished, a cross when it
 * did not.
 */
.cc-tool {
  border: 1px solid var(--cc-border); background: var(--cc-card);
  border-radius: var(--cc-radius-card); overflow: hidden;
}
.cc-reasoning { background: var(--cc-elevated); }
.cc-tool-head {
  display: flex; align-items: center; gap: var(--cc-space-sm);
  padding: var(--cc-space-sm) var(--cc-space-md);
  cursor: pointer; list-style: none; font-size: var(--cc-text-body-sm);
}
.cc-tool-head::-webkit-details-marker { display: none; }
.cc-tool-head:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: -2px; }
.cc-tool-mark { flex: none; width: 1em; text-align: center; color: var(--cc-text-tertiary); }
.cc-tool-mark[data-status="running"] { color: var(--cc-accent); animation: cc-tool-spin var(--cc-motion-orb) linear infinite; }
.cc-tool-mark[data-status="done"] { color: var(--cc-success); }
.cc-tool-mark[data-status="failed"] { color: var(--cc-danger); }
@keyframes cc-tool-spin { to { transform: rotate(1turn); } }
.cc-tool-label { flex: 1; min-width: 0; color: var(--cc-text); }
.cc-tool-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-meta);
  color: var(--cc-text-muted); overflow-wrap: anywhere;
}
.cc-tool-body { padding: 0 var(--cc-space-md) var(--cc-space-md); display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-tool[open] > .cc-tool-body { border-top: 1px solid var(--cc-border); padding-top: var(--cc-space-sm); }
.cc-reasoning-body { color: var(--cc-text-muted); }

/*
 * Voice mode.
 *
 * A screen rather than a panel: speaking and reading are different modes, and half of each is worse than
 * either. The waveform is driven by the loudness of real frames in both directions, so its movement means
 * something — a decorative equaliser would be a picture of a microphone, which is exactly what the
 * disabled button it replaces was.
 */
.cc-voice-scrim { position: fixed; inset: 0; z-index: 66; background: var(--cc-canvas); }
.cc-voice {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  background: var(--cc-canvas); color: var(--cc-text);
}
.cc-voice-head {
  display: flex; align-items: center; justify-content: space-between;
  min-height: var(--cc-topbar-height);
  padding: var(--cc-space-md) var(--cc-space-lg);
  border-bottom: 1px solid var(--cc-border);
}
.cc-voice-status {
  display: flex; align-items: center; gap: var(--cc-space-xs);
  color: var(--cc-text-muted); font-size: var(--cc-text-label);
}
.cc-voice-body {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--cc-space-md); padding: var(--cc-space-xl) var(--cc-space-lg); text-align: center;
}
/* The orb grows a little with the voice, which is the one reaction the design's sphere has. */
.cc-voice-orb {
  border-radius: var(--cc-radius-pill); transition: transform 90ms linear;
  animation: cc-enter var(--cc-motion-enter) var(--cc-motion-bounce) both;
}
.cc-voice-orb-canvas { border-radius: var(--cc-radius-pill); display: block; }
.cc-voice-headline { margin: 0; font-size: var(--cc-text-heading-md); font-weight: 600; }
.cc-voice-sub { margin: 0; color: var(--cc-text-muted); }
.cc-voice-wave {
  display: flex; align-items: center; justify-content: center; gap: 4px;
  height: 64px; width: min(420px, 100%);
}
.cc-voice-bar {
  width: 4px; border-radius: var(--cc-radius-pill); background: var(--cc-accent);
  /* Short, so the bars follow the voice rather than lagging behind it. */
  transition: height 80ms linear;
}
/* The live transcript of what the user said, as the design quotes it back to them. */
.cc-voice-transcript {
  margin: 0; max-width: 46ch; color: var(--cc-text); font-size: var(--cc-text-body-lg, var(--cc-text-body-md));
  line-height: var(--cc-leading-body-md);
}
.cc-voice-transcript-agent { margin: 0; max-width: 46ch; color: var(--cc-text-muted); font-size: var(--cc-text-body-sm); }
.cc-voice-note { margin: 0; color: var(--cc-text-tertiary); font-size: var(--cc-text-label); }
.cc-voice-problem { margin: 0; max-width: 52ch; color: var(--cc-warning); font-size: var(--cc-text-body-sm); }
.cc-voice-controls {
  display: flex; align-items: flex-start; justify-content: center; gap: var(--cc-space-xl);
  padding: var(--cc-space-lg) var(--cc-space-lg) var(--cc-space-xxl);
}
.cc-voice-action {
  display: flex; flex-direction: column; align-items: center; gap: var(--cc-space-xs);
  background: none; border: 0; cursor: pointer; color: var(--cc-text-muted);
  font: inherit; font-size: var(--cc-text-label);
}
.cc-voice-action-icon {
  display: grid; place-items: center; width: 52px; height: 52px;
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-pill);
  background: var(--cc-elevated); color: var(--cc-text); font-size: 18px;
  transition: border-color var(--cc-motion-micro) var(--cc-motion-easing), color var(--cc-motion-micro) var(--cc-motion-easing);
}
.cc-voice-action:hover:not(:disabled) .cc-voice-action-icon { border-color: var(--cc-accent); }
.cc-voice-action:disabled { cursor: default; opacity: 0.5; }
.cc-voice-action:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; border-radius: var(--cc-radius-badge); }
.cc-voice-action-end .cc-voice-action-icon {
  border-color: color-mix(in oklab, var(--cc-danger) 45%, transparent);
  color: var(--cc-danger); background: color-mix(in oklab, var(--cc-danger) 12%, transparent);
}

/*
 * The modal. The specification's numbers: 700px wide, radius 20. Focus is trapped inside while it
 * is up, and the page behind cannot scroll — a user scrolling a surface they cannot see loses
 * their place.
 */
.cc-modal-scrim { position: fixed; inset: 0; background: color-mix(in oklab, var(--cc-code) 78%, transparent); z-index: 70; }
.cc-modal {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
  width: min(var(--cc-modal-width), calc(100vw - 32px)); max-height: calc(100vh - 64px);
  display: flex; flex-direction: column;
  background: var(--cc-elevated); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-modal);
  box-shadow: 0 24px 64px color-mix(in oklab, var(--cc-code) 70%, transparent);
  animation: cc-modal-in var(--cc-motion-panel) var(--cc-motion-easing);
}
@keyframes cc-modal-in { from { opacity: 0; transform: translate(-50%, -48%); } to { opacity: 1; } }
.cc-modal:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-modal-head { display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-md); padding: var(--cc-space-lg); border-bottom: 1px solid var(--cc-border); }
.cc-modal-head h2 { margin: 0; font-size: var(--cc-text-heading-md); line-height: var(--cc-leading-heading-md); }
.cc-modal-body { padding: var(--cc-space-lg); overflow-y: auto; display: flex; flex-direction: column; gap: var(--cc-space-md); }
.cc-modal-actions { display: flex; justify-content: flex-end; gap: var(--cc-space-sm); padding: var(--cc-space-md) var(--cc-space-lg); border-top: 1px solid var(--cc-border); }

/*
 * Settings tabs. A tab that is selected says so with an underline and with aria-selected, so
 * the state does not depend on colour alone.
 */
.cc-tabs { display: flex; gap: var(--cc-space-lg); border-bottom: 1px solid var(--cc-border); margin: 0 calc(var(--cc-space-lg) * -1); padding: 0 var(--cc-space-lg); }
.cc-tab {
  appearance: none; background: none; border: none; cursor: pointer;
  font: inherit; font-size: var(--cc-text-body-md); color: var(--cc-text-muted);
  padding: var(--cc-space-sm) 0; border-bottom: 2px solid transparent;
  transition: color var(--cc-motion-micro) var(--cc-motion-easing);
}
.cc-tab:hover { color: var(--cc-text); }
.cc-tab[data-selected="true"] { color: var(--cc-text); border-bottom-color: var(--cc-accent); }
.cc-tab:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: -2px; border-radius: var(--cc-radius-badge); }
.cc-tabpanel { display: flex; flex-direction: column; gap: var(--cc-space-md); }
.cc-modal-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-md); padding: var(--cc-space-md) var(--cc-space-lg); border-top: 1px solid var(--cc-border); }
.cc-modal-done { cursor: pointer; font: inherit; padding: var(--cc-space-xs) var(--cc-space-md); }

/* Menu bar popover: the same connection wording the app window uses. */
.cc-menubar {
  display: flex; flex-direction: column; gap: var(--cc-space-sm);
  padding: var(--cc-space-md); min-width: 15rem;
  background: var(--cc-elevated); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-card);
}
.cc-menubar-head { display: flex; align-items: center; gap: var(--cc-space-sm); font-size: var(--cc-text-body-sm); color: var(--cc-text); }
.cc-notification-trigger { display: flex; align-items: center; gap: var(--cc-space-sm); flex-wrap: wrap; }

/*
 * The four starting chips.
 *
 * Each carries a label and a note about whether it needs a model. The note is visible rather than
 * a tooltip, because the question it answers — will this work on this node — is one the user has
 * before they click, not after.
 */
.cc-chip-row { display: flex; gap: var(--cc-space-sm); flex-wrap: wrap; justify-content: center; }
.cc-chip {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  cursor: pointer; font: inherit; text-align: left;
  /* Roomier on the sides than above and below: these are two lines of text in a pill, and the label
     and its note are read as one phrase, so the ends need the space the middle already has. */
  padding: var(--cc-space-sm) var(--cc-space-xl);
  background: var(--cc-card); color: var(--cc-text);
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-pill);
  transition: border-color var(--cc-motion-micro) var(--cc-motion-easing);
}
.cc-chip:hover { border-color: var(--cc-accent); }
.cc-chip:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-chip-label { font-size: var(--cc-text-body-sm); }
.cc-chip-detail { font-size: var(--cc-text-meta); color: var(--cc-text-tertiary); }

/*
 * A card's action row.
 *
 * A disabled action always sits next to the reason it is disabled. A disabled button on its own
 * reads as a bug; the reason turns it into a statement about what the node can do, which is the
 * distinction the whole settings surface is built around.
 */
.cc-card-actions { display: flex; align-items: center; gap: var(--cc-space-sm); flex-wrap: wrap; padding-top: var(--cc-space-xs); }
.cc-action {
  cursor: pointer; font: inherit; font-size: var(--cc-text-body-sm);
  padding: var(--cc-space-xs) var(--cc-space-md);
  background: var(--cc-elevated); color: var(--cc-text);
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-button);
}
.cc-action:hover:not(:disabled) { border-color: var(--cc-accent); }
.cc-action:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-action:disabled { cursor: not-allowed; color: var(--cc-text-tertiary); }

/* Project roots the node has already approved. */
.cc-root-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-root-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-sm); padding: var(--cc-space-xs) 0; border-bottom: 1px solid var(--cc-border); }
.cc-root-list li:last-child { border-bottom: none; }
.cc-root-list code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--cc-text-meta); line-height: var(--cc-leading-meta); overflow-wrap: anywhere; }

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

.cc-donut { width: 160px; height: 160px; transform: rotate(-90deg); }
.cc-donut .wedge {
  fill: none; stroke: var(--cc-accent); stroke-width: 22;
  transform-origin: 80px 80px;
}
.cc-donut .wedge[data-slice-index="1"] { stroke: color-mix(in oklab, var(--cc-accent) 70%, var(--cc-text)); }
.cc-donut .wedge[data-slice-index="2"] { stroke: color-mix(in oklab, var(--cc-accent) 45%, var(--cc-text)); }
.cc-donut .wedge[data-slice-index="3"] { stroke: color-mix(in oklab, var(--cc-accent) 25%, var(--cc-text)); }
.cc-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-xxs); font-size: var(--cc-text-label); }
.cc-legend li { display: flex; gap: var(--cc-space-sm); justify-content: space-between; min-width: 140px; }
.cc-text-alt summary { cursor: pointer; color: var(--cc-text-muted); font-size: var(--cc-text-label); }
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
.cc-calendar-day[aria-pressed="true"] { border-color: var(--cc-accent); background: var(--cc-elevated); }
.cc-calendar-count { font-size: var(--cc-text-meta); color: var(--cc-accent); }
.cc-calendar-detail { font-size: var(--cc-text-label); color: var(--cc-text); }
.cc-calendar-detail ul { margin: 0; padding-left: var(--cc-space-md); }

.cc-image img { max-width: 100%; height: auto; border-radius: var(--cc-radius-badge); border: 1px solid var(--cc-border); }

.cc-cta {
  display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-md);
  border: 1px solid var(--cc-border); background: var(--cc-elevated);
  border-radius: var(--cc-radius-badge); padding: var(--cc-space-sm) var(--cc-space-md);
}
.cc-cta p { margin: 0; }

/* The live view of a pinned instance, and the notice when another surface holds it. */
.cc-live-surface { display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-live-surface[data-ownership="elsewhere"] { opacity: 0.9; }
.cc-live-surface[data-ownership="owner"] .cc-surface-region { border-left: 2px solid transparent; }

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
`;
