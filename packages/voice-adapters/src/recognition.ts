import type {
  RecognitionContext,
  RecognizedUtterance,
  SpeechRecognitionCapabilities,
  VoiceState,
} from "@clarkcant/contracts";

/**
 * The ears, as a seam of their own.
 *
 * `VoiceProviderAdapter` is a live, bidirectional session: it hears and it speaks, and its transcript is a side effect
 * of the conversation it holds. That made the live model's own input transcription the only source of what the person
 * said, and a conversational model is not tuned for Vietnamese sentences that carry English identifiers. Recognition
 * is therefore its own contract, so a dedicated recognizer can produce the words while the live session keeps the
 * voice - and so a second or a local recognizer can be measured against the first without touching the runtime.
 *
 * A recognizer never decides anything. It reports utterances, interim and final, with whatever confidence and
 * language metadata its provider really returns; turning a final utterance into the canonical text is the
 * normaliser's job, and deciding what that text means is the application's.
 *
 * Like the live seam, the credential is asked for at start through `tokenProvider` rather than handed over at
 * construction, so it does not sit in a field a logger can reach.
 */
export interface SpeechRecognitionAdapter {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: SpeechRecognitionCapabilities;
  /**
   * Open the recognizer. Resolves when audio sent afterwards will be recognized; rejects when it cannot open.
   *
   * `context` is the bounded, redacted vocabulary for this session; an adapter that cannot use one ignores it and
   * reports `contextApplied: false` on what it emits rather than pretending.
   */
  start(input: { sessionId: string; tokenProvider: () => Promise<string>; context?: RecognitionContext }): Promise<void>;
  stop(): Promise<void>;
  /** PCM16, 16 kHz, mono, little-endian: the format the voice socket already carries. */
  sendAudio(frame: Uint8Array): void;
  /**
   * Tell the recognizer the audio stream has paused, so it finalizes what it holds.
   *
   * Optional because not every provider has the signal. Used when one completed utterance is recognized again on its
   * own, where there is no following silence to close it.
   */
  endAudio?(): void;
  setMuted(muted: boolean): void;
  /** Replace the context. Applied as `capabilities.contextUpdate` says, never silently dropped while claiming otherwise. */
  updateContext(context: RecognitionContext): void;
  onUtterance(listener: (utterance: RecognizedUtterance) => void): () => void;
  onStateChange(listener: (state: VoiceState) => void): () => void;
}

/**
 * The mouth, as a request/response seam.
 *
 * Deliberately not a session: synthesis that returns a finished clip is a single call, and forcing it through a
 * connect/disconnect interface would be a session that lies about what it is. The live session's `speak` stays the
 * voice of a live conversation; this seam is for speech produced without one.
 */
export interface SpeechSynthesisAdapter {
  readonly provider: string;
  synthesize(input: {
    text: string;
    /** The provider's own voice name. Omitted: the provider's default. */
    voice?: string;
    tokenProvider: () => Promise<string>;
  }): Promise<{
    audio: Uint8Array;
    mimeType: string;
    /** The rate the clip is actually in, as the provider reported it; callers needing another rate resample. */
    sampleRateHz: number;
  }>;
}
