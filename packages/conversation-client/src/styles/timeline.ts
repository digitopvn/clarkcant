/**
 * Timeline styles.
 *
 * Transcript rows, message bubbles, tool/reasoning blocks, streaming caret and thinking indicator.
 *
 * Wrapped in its own CSS `@layer` so the concatenation order in styles.ts stays the visible,
 * intentional cascade order rather than an accident of import order.
 */
export const TIMELINE_CSS = `
@layer timeline {
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
}
`;
