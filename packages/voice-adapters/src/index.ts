import {
  type MediaFocusState,
  type VoiceIntent,
  type VoiceState,
  type VoiceTiming,
  type VoiceTranscriptFragment,
  assembleUtterance,
  releaseMediaFocus,
  requestMediaFocus,
  routeVoiceIntent,
  voiceFallbackRequired,
} from "@clarkcant/contracts";

/**
 * Voice adapters.
 *
 * The provider is an adapter and never the source of truth. Durable state lives in
 * the application, so a provider reconnect does not lose task context and a worker
 * reload does not drop the media session.
 *
 * Two behaviours are settled here rather than in the provider:
 *
 * - Barge-in yields audio only. It never cancels a running job, because "stop
 *   talking" and "stop working" are different instructions (acceptance test T64).
 * - Mute and end release the device locally, without a round trip. A mute button
 *   that depends on a remote node acknowledging it is not a mute button.
 */

export type { VoiceProviderAdapter } from "./provider.ts";
export {
  GeminiLiveAdapter,
  globalSocketFactory,
  type GeminiLiveOptions,
  type LiveSocket,
  type LiveSocketFactory,
} from "./gemini-live.ts";


export interface VoiceSessionState {
  sessionId: string;
  state: VoiceState;
  mediaFocus: MediaFocusState;
  /** Fragments accumulated for the utterance currently being spoken. */
  pending: Map<string, VoiceTranscriptFragment[]>;
  timings: VoiceTiming[];
}

export function createVoiceSessionState(sessionId: string): VoiceSessionState {
  return {
    sessionId,
    state: "idle",
    mediaFocus: {
      speakerOwners: [],
      ducked: false,
      assistantMuted: false,
    },
    pending: new Map(),
    timings: [],
  };
}

/**
 * Begin capture.
 *
 * Capture is granted only if the microphone is actually free. Two owners of a live
 * microphone is the failure this prevents, and the refusal names the holder so the
 * UI can say which surface has it rather than going silent (acceptance test T67).
 */
export function beginListening(
  state: VoiceSessionState,
): { ok: true; state: VoiceSessionState } | { ok: false; code: string; heldBy: string; message: string } {
  const focus = requestMediaFocus(state.mediaFocus, {
    owner: "assistant-voice",
    device: "microphone",
    intent: "exclusive",
  });
  if (!focus.granted) {
    return { ok: false, code: focus.code, heldBy: focus.heldBy, message: focus.message };
  }
  return {
    ok: true,
    state: { ...state, state: "listening", mediaFocus: focus.resulting },
  };
}

/**
 * Mute. Local, immediate, and it actually releases the device.
 *
 * The capture session is stopped here rather than being signalled to stop, so a
 * network problem cannot leave a microphone open.
 */
export function mute(state: VoiceSessionState): VoiceSessionState {
  const focus = releaseMediaFocus(state.mediaFocus, { owner: "assistant-voice", device: "microphone" });
  return {
    ...state,
    state: state.state === "ended" ? "ended" : "idle",
    mediaFocus: { ...focus, assistantMuted: true },
  };
}

export function unmute(state: VoiceSessionState): VoiceSessionState {
  return { ...state, mediaFocus: { ...state.mediaFocus, assistantMuted: false } };
}

/** End the session and release every device, including the speaker. */
export function end(state: VoiceSessionState): VoiceSessionState {
  const afterMic = releaseMediaFocus(state.mediaFocus, { owner: "assistant-voice", device: "microphone" });
  const afterSpeaker = releaseMediaFocus(afterMic, { owner: "assistant-voice", device: "speaker" });
  return { ...state, state: "ended", mediaFocus: afterSpeaker, pending: new Map() };
}

export interface TranscriptUpdate {
  state: VoiceSessionState;
  /** Present once the utterance is complete; `undefined` while still partial. */
  intent: VoiceIntent | undefined;
  text: string;
  duplicateFragments: number;
}

/**
 * Fold a transcript fragment into the session.
 *
 * Fragments are keyed by utterance and index, so a repeated fragment cannot
 * duplicate text and a late partial cannot overwrite a final. Only when the whole
 * utterance is final does an intent emerge, which is what makes a self-correction
 * one task revision rather than two tasks (acceptance test T65).
 */
export function ingestTranscript(
  state: VoiceSessionState,
  fragment: VoiceTranscriptFragment,
  classify: (text: string) => VoiceIntent["kind"],
): TranscriptUpdate {
  const existing = state.pending.get(fragment.utteranceId) ?? [];
  existing.push(fragment);
  const assembly = assembleUtterance(existing);

  const pending = new Map(state.pending);
  if (assembly.complete) pending.delete(fragment.utteranceId);
  else pending.set(fragment.utteranceId, existing);

  const nextState: VoiceSessionState = { ...state, pending };

  if (!assembly.complete) {
    return { state: nextState, intent: undefined, text: assembly.text, duplicateFragments: assembly.duplicateFragments };
  }

  const kind = classify(assembly.text);
  return {
    state: nextState,
    duplicateFragments: assembly.duplicateFragments,
    text: assembly.text,
    intent: {
      intentId: `intent-${fragment.utteranceId}`,
      voiceSessionId: state.sessionId,
      utteranceId: fragment.utteranceId,
      kind,
      text: assembly.text,
      at: fragment.at,
    },
  };
}

/**
 * Apply an intent.
 *
 * The returned `cancelsJob` flag is the whole point: a spoken interruption must not
 * reach the task scheduler unless the user actually asked to cancel.
 */
export function applyIntent(
  state: VoiceSessionState,
  intent: VoiceIntent,
): { state: VoiceSessionState; routing: ReturnType<typeof routeVoiceIntent> } {
  const routing = routeVoiceIntent(intent);
  if (routing.effect === "audio-only") {
    return { state: { ...state, state: routing.cancelsJob ? state.state : "listening" }, routing };
  }
  return { state, routing };
}

export function fallbackFor(state: VoiceSessionState): { required: boolean; message: string } {
  return voiceFallbackRequired(state.state);
}
