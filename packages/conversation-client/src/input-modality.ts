/**
 * One vocabulary for how the user is interacting and what the agent is doing.
 *
 * Both are published as attributes on the shell root rather than guessed by each component from
 * unrelated DOM state. That is the whole reason this module exists: a stylesheet rule like "the docked
 * orb is larger while a pointer is in use" needs to know the input modality, and the alternative to one
 * declared state is every component attaching its own listener and drawing its own conclusion.
 *
 * The modality is about the *last* thing the user did, not about capability: a laptop with a touchscreen
 * has both, and the one that matters is the one being used right now.
 *
 * Detection belongs at the shell root, in one place. A listener per button would be a listener per
 * button to keep in sync, and the state would flicker as the pointer crossed controls.
 */

/** How the user is interacting right now. */
export const INPUT_MODALITIES = ["pointer", "keyboard", "touch", "voice"] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];

/**
 * What the agent is doing right now.
 *
 * `success` and `error` are outcomes rather than activity, and they are in the same vocabulary because a
 * surface that shows state should not have to hold two parallel ones. A caller that has no real
 * completion signal leaves them unused rather than inventing the transition: a state published without
 * evidence is the interface claiming something it does not know.
 */
export const AGENT_STATES = [
  "idle",
  "listening",
  "thinking",
  "tooling",
  "responding",
  "success",
  "error",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export function isAgentState(value: string): value is AgentState {
  return (AGENT_STATES as readonly string[]).includes(value);
}

/** What produced a modality change. Named rather than a raw DOM event, so a test needs no DOM. */
export type InputSignal = "pointer" | "key" | "touch" | "voice";

/**
 * The modality a signal means.
 *
 * A `pointermove` from a finger is a touch, which is why the DOM event's own pointer type is passed
 * through here instead of being folded into "pointer" upstream: on a phone the hover styles would
 * otherwise be the ones a tap turns on.
 */
export function modalityFor(signal: InputSignal, pointerType?: string): InputModality {
  if (signal === "touch") return "touch";
  if (signal === "key") return "keyboard";
  if (signal === "voice") return "voice";
  return pointerType === "touch" ? "touch" : "pointer";
}

export interface InputModalityHandle {
  current(): InputModality;
  /** A voice session started or spoke: the modality nobody can detect from an input event. */
  noteVoice(): void;
  dispose(): void;
}

/** The part of a listener target this needs, so a test can pass a stand-in instead of a window. */
export interface InputModalityTarget {
  addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: boolean | EventListenerOptions): void;
}

/**
 * Watch for the four signals and report changes.
 *
 * Only changes are reported, so a pointer crossing the shell a thousand times is one attribute write
 * rather than a thousand React state updates — the same reason the orb reads pointer samples outside
 * React state.
 */
export function attachInputModality(input: {
  target: InputModalityTarget;
  onChange: (modality: InputModality) => void;
  initial?: InputModality;
}): InputModalityHandle {
  let current: InputModality = input.initial ?? "pointer";
  let disposed = false;

  const note = (modality: InputModality): void => {
    if (disposed || modality === current) return;
    current = modality;
    input.onChange(modality);
  };

  const onPointerMove: EventListener = (event) => {
    note(modalityFor("pointer", (event as PointerEvent).pointerType));
  };
  const onKeyDown: EventListener = () => {
    note(modalityFor("key"));
  };
  const onTouchStart: EventListener = () => {
    note(modalityFor("touch"));
  };

  input.target.addEventListener("pointermove", onPointerMove);
  // Capture, because a key pressed inside a focused control still has to reach this: a handler on the
  // bubble phase would miss anything that stops propagation, which is most inputs and editors.
  input.target.addEventListener("keydown", onKeyDown, { capture: true });
  input.target.addEventListener("touchstart", onTouchStart, { passive: true });

  return {
    current: () => current,
    noteVoice: () => note(modalityFor("voice")),
    dispose: () => {
      disposed = true;
      input.target.removeEventListener("pointermove", onPointerMove);
      input.target.removeEventListener("keydown", onKeyDown, { capture: true });
      // No options on the way out: the touch listener was registered with `passive`, which implies the bubble
      // phase, so removing it with `{ capture: false }` is the matching call. Only `capture` affects which
      // registration is removed, and `passive` is not part of that identity.
      input.target.removeEventListener("touchstart", onTouchStart);
    },
  };
}

/** The attribute value for an agent state. One place, so the stylesheet and the code agree. */
export function agentStateAttribute(state: AgentState): string {
  return state;
}

/**
 * Which single state to publish, from the states a turn can be in at once.
 *
 * One value rather than a set, because this is one attribute: a turn that is streaming text while a tool is
 * still running is doing both, and the one worth drawing is the one still in progress. A surface that
 * wanted to show all of it would need a different, richer signal than an attribute.
 *
 * Nothing here is invented: every input is a state the caller actually holds, and a caller with no
 * completion signal leaves `failed` false rather than marking a turn successful.
 */
export function agentStateFrom(input: {
  failed?: boolean;
  listening?: boolean;
  busy?: boolean;
  tooling?: boolean;
  responding?: boolean;
}): AgentState {
  if (input.failed === true) return "error";
  if (input.listening === true) return "listening";
  if (input.tooling === true) return "tooling";
  if (input.responding === true) return "responding";
  if (input.busy === true) return "thinking";
  return "idle";
}
