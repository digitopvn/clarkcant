import type { VoiceState, VoiceTranscriptFragment } from "@clarkcant/contracts";

/**
 * The seam every voice provider sits behind.
 *
 * Deliberately small, and deliberately unaware of any provider: the adapter owns the wire, the
 * session owns durable intent, and the two meet here. A provider swap is a new implementation of
 * this interface and nothing else, which is what makes the decision in
 * `docs/research/adr-001-gemini-live-provider.md` reversible rather than permanent.
 *
 * `tokenProvider` rather than a token, because a credential that is passed once at construction
 * tends to end up in a field a logger can reach. Asking for it at connect time keeps the window
 * in which it exists as short as the caller wants it to be.
 */
export interface VoiceProviderAdapter {
  readonly provider: string;
  connect(input: { sessionId: string; tokenProvider: () => Promise<string> }): Promise<void>;
  disconnect(): Promise<void>;
  sendAudio(frame: Uint8Array): void;
  /**
   * Audio coming back from the provider, as PCM16 at the provider's output rate.
   *
   * A callback rather than a queue the caller polls: the caller is a socket that has to forward
   * each chunk as it arrives, and a queue would add a polling interval to the one path where
   * latency is the whole experience.
   */
  onAudio(listener: (pcm16: Uint8Array) => void): () => void;
  /** Provider events, already normalised to app shapes by this adapter. */
  onTranscript(listener: (fragment: VoiceTranscriptFragment) => void): () => void;
  onStateChange(listener: (state: VoiceState) => void): () => void;
  setMuted(muted: boolean): void;
}
