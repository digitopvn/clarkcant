/**
 * Voice styles.
 *
 * Voice overlay: scrim, collapsed bar, waveform, transcript and controls.
 *
 * Wrapped in its own CSS `@layer` so the concatenation order in styles.ts stays the visible,
 * intentional cascade order rather than an accident of import order.
 */
export const VOICE_CSS = `
@layer voice {
/*
 * Voice mode.
 *
 * A screen rather than a panel: speaking and reading are different modes, and half of each is worse than
 * either. The waveform is driven by the loudness of real frames in both directions, so its movement means
 * something — a decorative equaliser would be a picture of a microphone, which is exactly what the
 * disabled button it replaces was.
 */
.cc-voice-scrim { position: fixed; inset: 0; z-index: 66; background: var(--cc-canvas); }
/*
 * Collapsed.
 *
 * A voice session that hides the conversation is the wrong trade while the agent is answering into it:
 * the person is talking about what they are looking at, and the answer belongs to the same
 * conversation. Collapsed keeps the session running and takes only the composer's height, and the scrim
 * stops swallowing clicks so the transcript above stays readable and scrollable.
 */
/*
 * While voice is open.
 *
 * The panel is narrower than the input beneath it, so the input showed at both ends - and a mode where two things
 * look ready to receive the same sentence is a mode nobody can read. Hidden rather than covered: opacity keeps the
 * element focusable, which matters because leaving voice focuses the composer again.
 */
.cc-shell[data-voice-open="true"] .cc-composer-wrap { opacity: 0; pointer-events: none; }

.cc-voice-scrim[data-voice-collapsed="true"] {
  display: flex; align-items: flex-end; justify-content: center;
  background: transparent; pointer-events: none;
}
.cc-voice-scrim[data-voice-collapsed="true"] .cc-voice {
  position: static; inset: auto; pointer-events: auto;
  width: min(100%, var(--cc-composer-max-width));
  /* The composer's own spacing, so the bar sits exactly where the input it replaces sits. */
  margin: 0 auto var(--cc-space-lg);
  border: 1px solid color-mix(in oklab, var(--cc-accent) 34%, transparent);
  border-radius: var(--cc-radius-lg);
  background: var(--cc-card);
  /* Clipped: the bar is smaller than the screen it replaces, and a stray pixel outside the curve reads as a bug. */
  overflow: hidden;
}
/*
 * Everything the full screen shows, except the one thing that has to keep moving.
 *
 * The waveform is the reason a collapsed bar is not just a status line: it is the only evidence on screen
 * that the microphone is live, and hiding it with the rest of the body left a silent-looking session.
 */
.cc-voice-scrim[data-voice-collapsed="true"] .cc-voice-body > *:not(.cc-voice-wave) { display: none; }
/*
 * One line, and nothing cut in half.
 *
 * The word beside the orb and the labels under the buttons are the first things to go: a status reading "Đang
 * nghâ¦" and a brand reading "Age" are worse than their absence, because they look like a rendering fault.
 */
.cc-voice-scrim[data-voice-collapsed="true"] .cc-brand span { display: none; }
.cc-voice-scrim[data-voice-collapsed="true"] .cc-voice-status {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46%;
}
.cc-voice-scrim[data-voice-collapsed="true"] .cc-voice-action-text { display: none; }
.cc-voice-scrim[data-voice-collapsed="true"] .cc-voice-head {
  min-height: 0; padding: var(--cc-space-sm) var(--cc-space-md) 0; border-bottom: none;
}
.cc-voice-scrim[data-voice-collapsed="true"] .cc-voice-body {
  flex: 0 0 auto; padding: var(--cc-space-xs) var(--cc-space-md);
}
.cc-voice-scrim[data-voice-collapsed="true"] .cc-voice-wave { height: 22px; width: 100%; }
.cc-voice-scrim[data-voice-collapsed="true"] .cc-voice-controls {
  padding: 0 var(--cc-space-sm) var(--cc-space-sm); gap: var(--cc-space-md);
  /* Icon buttons are narrower than labelled ones, and the row still has to hold three of them. */
  flex-wrap: nowrap;
}
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
/*
 * The orb grows a little with the voice, which is the one reaction the design's sphere has.
 *
 * Uses the raw micro duration rather than the 'press'/'release' helper: this is a continuous ambient
 * reaction to audio level, not feedback for something the user just did, and AGENTS.md reserves the
 * bounce for press/release/pin-drop/panel settle so an ambient effect stays subtle rather than springy.
 */
.cc-voice-orb {
  border-radius: var(--cc-radius-pill); transition: transform var(--cc-motion-micro) var(--cc-motion-easing);
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
  width: 4px; height: 100%; border-radius: var(--cc-radius-pill); background: var(--cc-accent);
  /*
   * Full height always; the level itself is drawn with 'transform: scaleY()' set inline per bar
   * (VoiceOverlay.tsx) rather than by animating 'height', which is a layout property AGENTS.md's
   * motion rules forbid animating every frame. Scaling from the bottom keeps a quiet bar pinned to
   * the baseline instead of shrinking from the middle.
   */
  transform-origin: bottom;
  /* Short, so the bars follow the voice rather than lagging behind it. */
  transition: transform var(--cc-motion-micro) var(--cc-motion-easing);
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
}
`;
