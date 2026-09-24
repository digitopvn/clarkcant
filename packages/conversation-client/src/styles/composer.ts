/**
 * Composer styles.
 *
 * Composer shell, attachment chips, drop target and inline attachment cards.
 *
 * Wrapped in its own CSS `@layer` so the concatenation order in styles.ts stays the visible,
 * intentional cascade order rather than an accident of import order.
 */
export const COMPOSER_CSS = `
@layer composer {
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
 * The files waiting to be sent.
 *
 * Above the pill rather than inside it, because the pill is a fixed stadium whose height is the design's,
 * and chips that made it grow would move the send button away from where the eye left it. The row is inside
 * the drop target, though: a file dropped anywhere on the composer - including on a chip - is the same
 * gesture.
 */
.cc-chip-row {
  display: flex; flex-wrap: wrap; gap: var(--cc-space-xs);
  list-style: none; margin: 0 auto var(--cc-space-xs); padding: 0;
  max-width: var(--cc-composer-max-width);
}
.cc-chip {
  display: inline-flex; align-items: center; gap: var(--cc-space-xs);
  padding: 2px var(--cc-space-xs); border-radius: var(--cc-radius-pill);
  background: var(--cc-elevated); border: 1px solid var(--cc-border);
  font-size: var(--cc-text-label); color: var(--cc-text);
  max-width: 100%;
}
.cc-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.cc-chip-size, .cc-chip-reason { color: var(--cc-text-muted); }
/* A refusal is stated in words next to the file it is about, and in the warning colour rather than red:
   the file was not sent, which is not the same as the app having failed. */
.cc-chip[data-attachment-state="failed"] { border-color: var(--cc-warning); }
.cc-chip[data-attachment-state="failed"] .cc-chip-reason { color: var(--cc-warning); }
/* Still on its way. The chip is visible and removable the whole time, so an upload that is slow or stuck is
   never a click that did nothing. */
.cc-chip[data-attachment-state="checking"] { opacity: 0.7; }
.cc-chip-remove {
  background: none; border: none; color: var(--cc-text-muted); cursor: pointer;
  font: inherit; line-height: 1; padding: 0 2px;
}
.cc-chip-remove:hover { color: var(--cc-text); }
/* The drop target. A dashed outline appears only while a file is over it, so the composer is not permanently
   claiming a state the person is not in. */
.cc-composer-wrap[data-composer-drop="true"]::after {
  content: ""; position: absolute; inset: var(--cc-space-xs) var(--cc-space-md);
  border: 1px dashed var(--cc-accent); border-radius: var(--cc-radius-pill);
  pointer-events: none; z-index: 3;
}

/* An attachment in the timeline: a picture at its own size, or a card that can be opened. */
.cc-attachment {
  display: flex; align-items: center; gap: var(--cc-space-sm);
  margin: var(--cc-space-xs) 0; padding: var(--cc-space-xs) var(--cc-space-sm);
  border: 1px solid var(--cc-border); border-radius: var(--cc-radius-card);
  background: var(--cc-elevated); max-width: 100%;
}
figure.cc-attachment { display: block; }
.cc-attachment img { display: block; max-width: 100%; max-height: 320px; border-radius: var(--cc-radius-button); }
figure.cc-attachment figcaption { margin-top: var(--cc-space-xs); color: var(--cc-text-muted); font-size: var(--cc-text-label); }
.cc-attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-attachment-size, .cc-attachment-missing { color: var(--cc-text-muted); font-size: var(--cc-text-label); }
.cc-attachment-open { margin-left: auto; color: var(--cc-accent); }
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
 * The statusline reads as data rather than as prose, because it is data: a tabular figure, a separator, and
 * no sentence. Monospaced numbers keep the line from shifting as they change, and the gaps are wide enough
 * that two figures never read as one.
 */
.cc-hint[data-statusline="true"] {
  display: flex; flex-wrap: wrap; gap: var(--cc-space-md);
  font-variant-numeric: tabular-nums; letter-spacing: 0.01em;
}
.cc-statusline-part { white-space: nowrap; }
/* The model line is two facts - which model, and how to change it - so they get the statusline's gap rather than
   running together as one word. */
.cc-model-switch { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--cc-space-sm); }
.cc-model-switch [data-model-note="true"] { color: var(--cc-text-tertiary); }

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
/*
 * The canvas is drawn at ORB_DRAW_SIZE, which is larger than the box the dock arithmetic uses, so it has
 * to be centred on that box explicitly. Left to itself it overflows to the right and downwards, which
 * puts the ball 24 pixels right of and below the point the component measured - the lean a person sees.
 * A grid track is not the way: the track grows to the canvas, so centring an item inside it moves nothing.
 */
.cc-stage-orb > .cc-empty-orb {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  transition: opacity var(--cc-motion-orb) var(--cc-motion-easing), filter var(--cc-motion-orb) var(--cc-motion-easing);
}
.cc-stage-orb[data-docked="true"] > .cc-empty-orb { opacity: 0.5; filter: blur(1px) brightness(0.85); }

/*
 * The docked orb reports what the agent is doing.
 *
 * One ring, coloured by the single state the shell publishes, rather than each panel growing its own
 * indicator: the orb is already where the eye goes, and a second spinner somewhere else would be a second
 * thing to keep in sync. The idle state draws nothing, because a ring that is always there stops meaning anything.
 */
.cc-stage-orb::after {
  content: ""; position: absolute; inset: 12%; border-radius: var(--cc-radius-pill);
  pointer-events: none; opacity: 0;
  transition: opacity var(--cc-motion-normal) var(--cc-motion-easing);
}
.cc-shell[data-agent-state="thinking"] .cc-stage-orb::after,
.cc-shell[data-agent-state="tooling"] .cc-stage-orb::after,
.cc-shell[data-agent-state="listening"] .cc-stage-orb::after,
.cc-shell[data-agent-state="responding"] .cc-stage-orb::after {
  opacity: 1;
  box-shadow: 0 0 26px color-mix(in oklab, var(--cc-accent) 30%, transparent);
}
/*
 * A tool call and a reply are different amounts of activity, so they are different strengths of the same
 * signal rather than different signals. The listening state is the brightest, because that is where the
 * user is being recorded and should be able to see it without reading anything.
 */
.cc-shell[data-agent-state="listening"] .cc-stage-orb::after {
  box-shadow: 0 0 34px color-mix(in oklab, var(--cc-success) 46%, transparent);
}
.cc-shell[data-agent-state="responding"] .cc-stage-orb::after {
  box-shadow: 0 0 30px color-mix(in oklab, var(--cc-accent) 40%, transparent);
}
.cc-shell[data-agent-state="error"] .cc-stage-orb::after {
  opacity: 1;
  box-shadow: 0 0 30px color-mix(in oklab, var(--cc-danger, var(--cc-accent)) 42%, transparent);
}

/*
 * Keyboard interaction gets a visible focus ring on the orb's own button.
 *
 * The global :focus-visible rule already covers this, so the modality attribute is not what draws the
 * ring — it only removes the pointer's own affordance, so a mouse hovering the wordmark does not look
 * like a keyboard focus. That is the honest use of the attribute: it says which input is in play, and the
 * focus ring stays a function of focus rather than of the last thing that moved.
 */
.cc-shell[data-input-modality="keyboard"] .cc-brand:hover { opacity: 1; }
.cc-shell[data-input-modality="touch"] .cc-brand:hover { opacity: 1; }

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
 * The reasoning block, while the model is still writing it.
 *
 * The words are the whole indicator and they carry no animation of their own: the mark already spins while a
 * block is running, and that animation is switched off in the reduced-motion block. A second endless animation
 * making the same statement would be one more thing that has to be remembered there, and one more chance for
 * the two to disagree about whether the block is finished.
 */
.cc-reasoning-writing {
  flex: none; font-size: var(--cc-text-meta); color: var(--cc-text-muted);
}
}
`;
