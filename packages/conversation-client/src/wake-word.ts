import type { AgentState } from "./input-modality.ts";

/**
 * A local wake-word listener.
 *
 * The interface exists before any detector does, deliberately. Choosing a detector is a platform decision —
 * which microphone API a given OS exposes, and whether its on-device model is any good — and a decision made by
 * writing code against one vendor's SDK first is a decision nobody can revisit.
 *
 * Three rules travel with the interface, and each is a way a wake word could become a privacy problem rather
 * than a convenience:
 *
 *   - **Ambient audio is never sent to a provider.** Detection happens on this machine. A detector that had to
 *     stream the room to a model would mean the microphone is always open to somebody else, which is the thing
 *     a wake word is supposed to avoid — the point is that nothing listens remotely until you speak to it.
 *   - **The listener's state is visible.** "Hey Clark" is either off, or on and waiting, and the interface says
 *     which. A microphone that is listening with no indication is the worst state this feature can be in.
 *   - **Waking opens the same session a button opens.** A wake word is a way to start talking, not a second
 *     path into the agent: it calls the same start-voice intent the microphone button calls.
 */

/** What the wake listener is doing, as a surface can report it. */
export const WAKE_STATUSES = ["unavailable", "off", "starting", "listening", "failed"] as const;
export type WakeStatus = (typeof WAKE_STATUSES)[number];

export interface WakeWordDetector {
  /** The detector's own name, so a surface can say which one is in use. */
  readonly id: string;
  /**
   * Begin listening locally.
   *
   * Resolves once the detector is actually listening rather than once it was asked to, so a caller cannot
   * report "đang nghe" for a listener that failed to start.
   */
  start(onWake: () => void): Promise<void>;
  stop(): Promise<void>;
  status(): WakeStatus;
}

/**
 * Why no wake word is available on this platform.
 *
 * The honest state, and the one this build ships: there is no local detector wired in yet, and the fallback —
 * streaming ambient audio to a provider so it can listen for a phrase — is the thing the plan forbids outright.
 * A toggle that could only turn on that fallback would be a privacy decision disguised as a preference.
 *
 * A surface shows this as a disabled control with the reason, which is what AGENTS.md asks for: disable it with
 * a visible reason or omit it, never a control that looks usable and changes nothing.
 */
export const WAKE_UNAVAILABLE_REASON =
  "Chưa có bộ nhận diện chạy trên máy này. Không dùng cách gửi âm thanh liên tục lên provider thay thế.";

export interface WakeAvailability {
  available: boolean;
  /** The detector when there is one. */
  detector?: WakeWordDetector;
  /** Why there is not, in words a surface can show. */
  reason?: string;
}

/**
 * Whether a wake word can be offered here.
 *
 * A function rather than a constant because the answer is a property of the platform and of what the
 * installation provides, and a constant would freeze whichever machine it was written on. It takes what the
 * caller knows rather than reading globals itself, so the answer is testable without a browser: the environment
 * is "does this build have a detector to hand", and everything else follows.
 */
export function wakeAvailability(input: { detector?: WakeWordDetector } = {}): WakeAvailability {
  const detector = input.detector;
  if (detector === undefined) {
    return { available: false, reason: WAKE_UNAVAILABLE_REASON };
  }
  return { available: true, detector };
}

/**
 * A detector whose callbacks arrive when a test says so.
 *
 * The fixture the browser suite drives, and the reason the interface takes a callback rather than exposing an
 * event stream: a test can hold the wake, assert that nothing has happened yet, and then fire it.
 */
export function createFixtureWakeDetector(): WakeWordDetector & {
  /** Fire the wake phrase, as the microphone would. */
  trigger(): void;
  /** How many times the microphone was opened. */
  starts(): number;
} {
  let status: WakeStatus = "off";
  let onWake: (() => void) | undefined;
  let starts = 0;

  return {
    id: "fixture-wake",
    async start(listener: () => void): Promise<void> {
      starts += 1;
      status = "starting";
      onWake = listener;
      // Listening only once this resolves, so a caller cannot report a listener that never started.
      status = "listening";
    },
    async stop(): Promise<void> {
      onWake = undefined;
      status = "off";
    },
    status: () => status,
    trigger: () => onWake?.(),
    starts: () => starts,
  };
}

/**
 * The agent state a wake listener implies, so a surface publishes it the same way it publishes everything else.
 *
 * `listening` while the detector waits, and nothing at all while it is off: a wake listener is not an active
 * session, and reporting it as one would make the orb look like it is already in a conversation.
 */
export function agentStateForWake(status: WakeStatus): AgentState | undefined {
  return status === "listening" ? "listening" : undefined;
}
