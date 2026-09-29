/**
 * Base styles.
 *
 * Reset, shell layout, hero/start-screen, select and search-select controls, orb sizing tokens.
 *
 * Wrapped in its own CSS `@layer` so the concatenation order in styles.ts stays the visible,
 * intentional cascade order rather than an accident of import order.
 */
export const BASE_CSS = `
@layer base {
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

.cc-shell { display: flex; flex-direction: column; height: 100vh; position: relative; overflow: hidden; isolation: isolate; }

/*
 * The dotted field behind everything in the shell. The shell isolates its own stacking so the field can sit at -1:
 * under every child, including the ones that are not positioned, and still above the page's background.
 *
 * The lit layer is the same grid in a brighter colour, masked to a circle at the pointer. The dots stay exactly
 * where they are; only which of them are bright changes, so nothing on screen moves with the mouse.
 */
.cc-dot-grid, .cc-dot-grid::after {
  position: absolute; inset: 0; pointer-events: none;
  background-image: radial-gradient(circle, var(--cc-grid-dot) 1px, transparent 1.6px);
  background-size: 22px 22px;
  background-position: center;
}
.cc-dot-grid { z-index: -1; --cc-grid-dot: color-mix(in srgb, var(--cc-text-tertiary) 14%, transparent); }
.cc-dot-grid::after {
  content: "";
  --cc-grid-dot: color-mix(in srgb, var(--cc-accent) 55%, transparent);
  mask-image: radial-gradient(circle 190px at var(--cc-grid-x, -999px) var(--cc-grid-y, -999px), #000 0%, rgba(0, 0, 0, 0.45) 45%, transparent 100%);
  -webkit-mask-image: radial-gradient(circle 190px at var(--cc-grid-x, -999px) var(--cc-grid-y, -999px), #000 0%, rgba(0, 0, 0, 0.45) 45%, transparent 100%);
  opacity: 0;
  transition: opacity var(--cc-motion-normal) var(--cc-motion-easing);
}
.cc-dot-grid[data-lit="true"]::after { opacity: 1; }

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
 * The first-run screen can be taller than the window - this machine's catalogue alone lists a provider with more models
 * than fit on a screen - and a screen that cannot be scrolled leaves its own controls unreachable. That is not a
 * hypothesis: the model list was unclickable for exactly this reason, and the browser test said "element is outside of
 * the viewport" rather than anything a reader would have guessed from the source.
 */
.cc-shell[data-view="hero"][data-onboarding="true"] { overflow-y: auto; }

/* Built for choosing from a long list, and dressed so it belongs to this surface rather than to the operating system. */
.cc-select {
  background: var(--cc-elevated);
  color: inherit;
  border: 1px solid var(--cc-border);
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
  max-width: 100%;
}
.cc-select:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
/*
 * A focusable diff needs a ring that survives a long page: the outline has to sit outside the card and stay
 * visible while the diff is scrolled, and it must not be the accent colour alone.
 */
.cc-card[data-diff-keyboard="true"]:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-card[data-diff-keyboard="true"] [data-diff-path]:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }

/*
 * A field that opens a list, and the list itself.
 *
 * Positioned rather than pushed into the layout, because a panel that grows by several hundred rows every time somebody
 * clicks a field is a panel that jumps under the pointer.
 */
.cc-search-select { position: relative; }
.cc-search-select input {
  width: 100%;
  background: var(--cc-elevated);
  color: inherit;
  border: 1px solid var(--cc-border);
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
}
.cc-search-select input:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-search-list {
  position: absolute;
  z-index: 5;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--cc-elevated);
  border: 1px solid var(--cc-border);
  border-radius: 10px;
  box-shadow: var(--cc-shadow-soft, 0 12px 32px rgb(0 0 0 / 35%));
}
.cc-search-list li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 7px;
  cursor: pointer;
}
.cc-search-list li[data-active="true"] { background: var(--cc-card); }
.cc-search-list li[aria-selected="true"] { color: var(--cc-accent); }
.cc-search-list li em { opacity: 0.6; font-style: normal; font-size: var(--cc-text-label); }
.cc-search-empty { cursor: default; opacity: 0.7; }

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

/*
 * Header: identity and honest status. The gear is the only settings affordance.
 *
 * No border and no solid fill: a bar with an edge under it makes the page two surfaces, and the wordmark
 * does not need a bar to sit on. What is left is a gradient that is opaque where the identity is and
 * transparent by the bottom, so the transcript reads as continuing behind it.
 */
.cc-header {
  display: flex; align-items: center; justify-content: space-between;
  min-height: var(--cc-topbar-height);
  padding: var(--cc-space-md) var(--cc-space-lg);
  background: linear-gradient(to bottom, var(--cc-canvas) 0%, transparent 100%);
  position: relative; z-index: 3;
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

/*
 * A secret being typed.
 *
 * The field is a password input and the form is a column, because the thing being typed is not part of the
 * conversation and should not look like it is: one field per name, a save button, and a status line that says
 * what happened without saying what was typed.
 */
.cc-credential-form { display: flex; flex-direction: column; gap: var(--cc-space-sm); margin: var(--cc-space-sm) 0; }

/*
 * The microphone check.
 *
 * The bar is a reading rather than a decoration: a muted microphone and a broken one look identical from the
 * outside, and the level is the difference. It is drawn from the same measurement the voice session uses, so a
 * level that moves here is a level that will move there.
 */
.cc-mic-check { display: flex; flex-direction: column; gap: var(--cc-space-sm); align-items: flex-start; }
.cc-mic-level {
  width: 100%; height: 6px; overflow: hidden;
  background: var(--cc-elevated); border-radius: var(--cc-radius-pill);
}
/*
 * Full width always; the level itself is drawn with 'transform: scaleX()' set inline (microphone-check.tsx)
 * rather than by animating 'width', a layout property AGENTS.md's motion rules forbid animating every frame.
 * Scaled from the left edge so a quiet reading stays pinned to where the bar starts.
 */
.cc-mic-level > span {
  display: block; width: 100%; height: 100%; background: currentColor; opacity: 0.7;
  transform-origin: left; transition: transform var(--cc-motion-micro) var(--cc-motion-easing);
}

/*
 * The background mark in the header.
 *
 * The list appears on hover or on focus, which is why the mark is focusable at all: a count that can only be inspected
 * with a pointer is a count half the people cannot inspect. The list is positioned below the mark so it does not cover
 * the connection status beside it.
 */
.cc-bg-mark {
  position: relative; display: flex; align-items: center; gap: var(--cc-space-xs);
  font-size: var(--cc-text-label); outline: none;
}
.cc-bg-list {
  position: absolute; top: 100%; right: 0; margin: var(--cc-space-xs) 0 0; padding: var(--cc-space-sm);
  min-width: 220px; max-width: 360px; list-style: none;
  background: var(--cc-elevated); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-card);
  box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
  opacity: 0; visibility: hidden; transition: opacity var(--cc-motion-micro) ease;
}
.cc-bg-mark:hover .cc-bg-list, .cc-bg-mark:focus-within .cc-bg-list { opacity: 1; visibility: visible; }
.cc-bg-list li { padding: 2px 0; }

/*
 * The menu that appears over a highlighted passage.
 *
 * Fixed rather than absolute, because it is placed from the range's own rectangle in viewport coordinates, and it
 * sits above the transcript: a menu that scrolled away with the text would be a menu that is gone by the time
 * somebody reaches for it.
 */
.cc-selection-menu {
  position: fixed; transform: translate(-50%, -100%); z-index: 5;
  display: flex; gap: var(--cc-space-xs); padding: var(--cc-space-xs);
  background: var(--cc-elevated); border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-pill); box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
}
.cc-selection-menu button {
  background: none; border: 0; color: inherit; font: inherit; cursor: pointer;
  padding: var(--cc-space-xs) var(--cc-space-sm); border-radius: var(--cc-radius-pill);
}
.cc-selection-menu button:hover { background: var(--cc-card); }
.cc-credential-field { display: flex; flex-direction: column; gap: var(--cc-space-xs); font-size: var(--cc-text-label); }
.cc-credential-field input {
  font: inherit; color: inherit; padding: var(--cc-space-sm);
  background: var(--cc-elevated); border: 1px solid var(--cc-border); border-radius: var(--cc-radius-card);
}
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
.cc-dot[data-state="waiting"] { background: var(--cc-warning); }

/*
 * The inbox mark and the inbox panel.
 *
 * The mark is a pill-shaped button rather than a hover list like the background mark: it opens a surface with
 * decisions in it, so it is a control, and a control is reached by Tab and Enter like any other. The warning edge is
 * for "something is waiting on you", not for "something is new" — a result nobody has read is not an alarm.
 */
.cc-inbox-mark {
  display: flex; align-items: center; gap: var(--cc-space-xs);
  font: inherit; font-size: var(--cc-text-label); color: var(--cc-text);
  background: transparent; border: 1px solid var(--cc-border); border-radius: var(--cc-radius-pill);
  padding: 2px var(--cc-space-sm); min-height: 26px; cursor: pointer; white-space: nowrap;
  transition-property: transform; transition-duration: var(--cc-motion-micro); transition-timing-function: var(--cc-motion-bounce);
}
.cc-inbox-mark[data-inbox-mark="waiting"] { border-color: color-mix(in oklab, var(--cc-warning) 55%, transparent); }
.cc-inbox-mark:hover { background: var(--cc-elevated); }
.cc-inbox-mark:active { transform: scale(0.97); }
.cc-inbox-mark:focus-visible { outline: 2px solid var(--cc-focus); outline-offset: 2px; }
.cc-inbox { display: flex; flex-direction: column; gap: var(--cc-space-md); }
.cc-inbox-section { display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-inbox-heading { margin: 0; font-size: var(--cc-text-label); font-weight: 600; color: var(--cc-text-muted); }
.cc-inbox-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cc-space-sm); }
.cc-inbox-command {
  margin: 0; padding: var(--cc-space-sm); overflow-x: auto; max-height: 160px;
  background: var(--cc-code); border-radius: var(--cc-radius-button); font-size: var(--cc-text-body-sm);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.cc-inbox-notice { padding: var(--cc-space-sm) 0; border-bottom: 1px solid var(--cc-border); display: flex; flex-direction: column; gap: var(--cc-space-xs); }
.cc-inbox-notice:last-child { border-bottom: 0; }
.cc-inbox-notice-head { display: flex; align-items: center; gap: var(--cc-space-sm); flex-wrap: wrap; }
.cc-inbox-unread { display: inline-flex; align-items: center; gap: var(--cc-space-xs); font-size: var(--cc-text-label); color: var(--cc-text); font-weight: 600; }
.cc-inbox-notice-title { margin: 0; overflow-wrap: anywhere; }
.cc-inbox-notice[data-unread="true"] .cc-inbox-notice-title { font-weight: 600; }
.cc-inbox-notice-body { margin: 0; color: var(--cc-text-muted); font-size: var(--cc-text-body-sm); overflow-wrap: anywhere; }
@media (max-width: 520px) {
  /* The count words go on a narrow header; the dot and the button stay, and the label keeps the count. */
  .cc-inbox-mark > span:last-child { max-width: 9em; overflow: hidden; text-overflow: ellipsis; }
}
}
`;
