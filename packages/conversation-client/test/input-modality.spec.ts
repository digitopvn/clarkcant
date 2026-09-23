import { describe, expect, it, vi } from "vitest";

import {
  AGENT_STATES,
  INPUT_MODALITIES,
  WINDOW_MODES,
  agentStateAttribute,
  agentStateFrom,
  attachInputModality,
  isAgentState,
  modalityFor,
  windowModeFrom,
  type InputModalityTarget,
} from "../src/input-modality.ts";

/**
 * Input modality and agent state (V19).
 *
 * Two claims matter here. The modality is about the last thing the user did rather than about what the
 * machine can do, so a laptop with a touchscreen reports the one in use — otherwise a tap turns on the
 * hover styles. And only changes are reported, so a pointer crossing the shell is one state write rather
 * than a thousand, which is the difference between an attribute and a re-render storm.
 *
 * The state derivation is asserted as a priority order, because "a turn that is streaming text while a
 * tool still runs" has to resolve to exactly one value and the choice should be visible in one place.
 */

/** A stand-in for `window`, so this suite needs no DOM. */
function fakeTarget() {
  const listeners = new Map<string, Set<EventListener>>();
  const target: InputModalityTarget = {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set<EventListener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  const emit = (type: string, event: unknown = {}): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event as Event);
  };
  return { target, emit, count: (type: string) => listeners.get(type)?.size ?? 0 };
}

describe("the vocabularies are closed", () => {
  it("names four modalities and seven states", () => {
    expect([...INPUT_MODALITIES]).toEqual(["pointer", "keyboard", "touch", "voice"]);
    expect([...AGENT_STATES]).toEqual([
      "idle",
      "listening",
      "thinking",
      "tooling",
      "responding",
      "success",
      "error",
    ]);
  });

  it("recognizes a state and refuses anything else", () => {
    expect(isAgentState("thinking")).toBe(true);
    expect(isAgentState("vibing")).toBe(false);
  });

  it("publishes the state under its own name", () => {
    // One place, so the stylesheet selector and the code cannot drift apart.
    expect(agentStateAttribute("tooling")).toBe("tooling");
  });
});

describe("a signal means the modality the user is actually using", () => {
  it("reads a pointer event by its own pointer type", () => {
    expect(modalityFor("pointer", "mouse")).toBe("pointer");
    expect(modalityFor("pointer", "pen")).toBe("pointer");
    // A finger is a touch even though the browser reports it as a pointer event: without this, a tap on a
    // phone would turn on the hover styles.
    expect(modalityFor("pointer", "touch")).toBe("touch");
  });

  it("reads the signals that have no pointer type", () => {
    expect(modalityFor("key")).toBe("keyboard");
    expect(modalityFor("touch")).toBe("touch");
    expect(modalityFor("voice")).toBe("voice");
  });
});

describe("modality is reported once per change", () => {
  it("reports a change and stays quiet while it repeats", () => {
    const { target, emit } = fakeTarget();
    const onChange = vi.fn();
    const handle = attachInputModality({ target, onChange });

    emit("pointermove", { pointerType: "mouse" });
    // Already the initial modality, so nothing is published: a pointer crossing the shell is not a
    // thousand state writes.
    expect(onChange).not.toHaveBeenCalled();

    emit("keydown");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(handle.current()).toBe("keyboard");

    emit("keydown");
    emit("keydown");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("notices a voice session, which no input event can report", () => {
    const { target } = fakeTarget();
    const onChange = vi.fn();
    const handle = attachInputModality({ target, onChange });

    handle.noteVoice();
    expect(onChange).toHaveBeenCalledWith("voice");
    expect(handle.current()).toBe("voice");
  });

  it("listens in the capture phase, so a control that stops propagation is still seen", () => {
    const inner = fakeTarget();
    const added: { type: string; capture: boolean }[] = [];
    const spy: InputModalityTarget = {
      addEventListener: (type, listener, options) => {
        added.push({ type, capture: typeof options === "object" && options.capture === true });
        inner.target.addEventListener(type, listener, options);
      },
      removeEventListener: inner.target.removeEventListener,
    };
    attachInputModality({ target: spy, onChange: vi.fn() });

    expect(added.find((entry) => entry.type === "keydown")?.capture).toBe(true);
  });

  it("removes every listener it added", () => {
    const { target, count } = fakeTarget();
    const handle = attachInputModality({ target, onChange: vi.fn() });
    expect(count("pointermove")).toBe(1);
    expect(count("keydown")).toBe(1);
    expect(count("touchstart")).toBe(1);

    handle.dispose();
    expect(count("pointermove")).toBe(0);
    expect(count("keydown")).toBe(0);
    expect(count("touchstart")).toBe(0);
  });

  it("stops reporting after it is disposed", () => {
    const { target, emit } = fakeTarget();
    const onChange = vi.fn();
    const handle = attachInputModality({ target, onChange });
    handle.dispose();
    handle.noteVoice();
    emit("keydown");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("one state is published, chosen in a visible order", () => {
  it("is idle when nothing is happening", () => {
    expect(agentStateFrom({})).toBe("idle");
  });

  it("prefers a failure over everything else", () => {
    // Whatever else is true, the turn did not succeed, and the surface should say so rather than show
    // activity that is no longer happening.
    expect(
      agentStateFrom({ failed: true, listening: true, busy: true, tooling: true, responding: true }),
    ).toBe("error");
  });

  it("prefers the microphone over work in progress", () => {
    expect(agentStateFrom({ listening: true, busy: true, responding: true })).toBe("listening");
  });

  it("prefers a running tool over streamed text", () => {
    // A turn can be doing both, and the one still in progress is the one worth drawing.
    expect(agentStateFrom({ busy: true, tooling: true, responding: true })).toBe("tooling");
    expect(agentStateFrom({ busy: true, responding: true })).toBe("responding");
    expect(agentStateFrom({ busy: true })).toBe("thinking");
  });

  it("never reports success on its own", () => {
    // There is no real completion signal yet. A state published without one would be the interface
    // claiming to know something it does not, so `success` is reachable only by a caller that has it.
    const reachable = new Set(
      [
        {},
        { busy: true },
        { tooling: true },
        { responding: true },
        { listening: true },
        { failed: true },
      ].map((input) => agentStateFrom(input)),
    );
    expect(reachable.has("success")).toBe(false);
  });
});

describe("windowModeFrom", () => {
  it("is normal when nothing else is true", () => {
    expect(windowModeFrom({ compactSurface: false, voiceOpen: false, hasFocusedPin: false })).toBe("normal");
  });

  it("is expanded when a pin is focused and the window is not compact", () => {
    expect(windowModeFrom({ compactSurface: false, voiceOpen: false, hasFocusedPin: true })).toBe("expanded");
  });

  it("is compact when the window has shrunk and voice has not opened yet", () => {
    expect(windowModeFrom({ compactSurface: true, voiceOpen: false, hasFocusedPin: false })).toBe("compact");
  });

  it("is orb once the compact window's own voice session opens", () => {
    expect(windowModeFrom({ compactSurface: true, voiceOpen: true, hasFocusedPin: false })).toBe("orb");
  });

  it("prefers the compact/orb distinction over a focused pin", () => {
    expect(windowModeFrom({ compactSurface: true, voiceOpen: false, hasFocusedPin: true })).toBe("compact");
    expect(windowModeFrom({ compactSurface: true, voiceOpen: true, hasFocusedPin: true })).toBe("orb");
  });

  it("only ever reports one of the declared window modes", () => {
    for (const compactSurface of [false, true]) {
      for (const voiceOpen of [false, true]) {
        for (const hasFocusedPin of [false, true]) {
          expect(WINDOW_MODES).toContain(windowModeFrom({ compactSurface, voiceOpen, hasFocusedPin }));
        }
      }
    }
  });
});
