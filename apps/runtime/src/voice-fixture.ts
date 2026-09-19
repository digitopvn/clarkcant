import {
  type Instant,
  type VoiceState,
  type VoiceTranscriptFragment,
  nowInstant,
  voiceTranscriptFragmentSchema,
} from "@clarkcant/contracts";
import type { VoiceProviderAdapter } from "@clarkcant/voice-adapters";

/**
 * A provider that answers on a script instead of over the network.
 *
 * This exists so the whole path from a real microphone in a real browser, through the real node
 * and the real socket, can be verified without a provider account and without spending quota on
 * every CI run. It mirrors what `FakePiAdapter` does for the model path: the provider is the one
 * substituted part, and everything around it is the real thing.
 *
 * It is deliberately **not** a fake that pretends to be Gemini. A node running this says so at
 * startup, and it emits audio and transcripts that are plainly scripted, so an operator who sees
 * this behaviour knows a fixture is loaded rather than concluding the model is broken.
 *
 * It is also not a mock in the testing sense: it drives the same interface the real adapter does,
 * including the parts that are awkward to fake — audio arriving in chunks, state changes ordered
 * around the audio, and a disconnect that has to be idempotent.
 */

/** How much audio it waits for before answering. One second of 16 kHz PCM16. */
const ANSWER_AFTER_BYTES = 32_000;

/** The tone it sends back, at the provider's output rate. */
const OUTPUT_SAMPLE_RATE_HZ = 24000;
const TONE_DURATION_MS = 400;

/** What it says when nobody has scripted it. */
const DEFAULT_USER_WORDS = "audio giả lập từ thiết bị micro";
const ASSISTANT_WORDS = "node đã nhận được audio và trả lời bằng fixture";

export class FixtureLiveAdapter implements VoiceProviderAdapter {
  readonly provider = "fixture-live";

  #sessionId = "";
  #state: VoiceState = "idle";
  #muted = false;
  #received = 0;
  #turns = 0;
  #disconnected = false;
  #sequence = 0;
  readonly #spoken: string[] = [];
  readonly #now: () => Instant;
  /**
   * The sentence this session will be understood to have heard, or a function answering with it.
   *
   * The node passes a string: the script is for the next session and is consumed when that session opens, because the
   * value lives on the node and the node outlives a session. The function form is for a test that wants to change the
   * sentence between utterances, which a browser journey cannot do because it cannot pause the capture stream.
   */
  readonly #words: () => string | undefined;

  readonly #transcriptListeners = new Set<(fragment: VoiceTranscriptFragment) => void>();
  readonly #stateListeners = new Set<(state: VoiceState) => void>();
  readonly #audioListeners = new Set<(pcm16: Uint8Array) => void>();

  constructor(options: { now?: () => Instant; words?: string | (() => string | undefined) } = {}) {
    this.#now = options.now ?? nowInstant;
    const source = options.words ?? DEFAULT_USER_WORDS;
    this.#words = typeof source === "string" ? () => source : source;
  }

  /** Bytes of audio this fixture has accepted, so a caller can see whether capture worked. */
  get receivedBytes(): number {
    return this.#received;
  }

  async connect(input: { sessionId: string }): Promise<void> {
    this.#sessionId = input.sessionId;
    this.#setState("listening");
  }

  async disconnect(): Promise<void> {
    // Idempotent, because both a polite end and a dropped socket call this.
    if (this.#disconnected) return;
    this.#disconnected = true;
    this.#setState("ended");
  }

  /**
   * Accept capture and answer once there is enough of it.
   *
   * The threshold is the point: a browser that is not actually capturing sends nothing, so the
   * absence of a reply is a failing signal rather than a passing one.
   */
  sendAudio(frame: Uint8Array): void {
    if (this.#muted || this.#disconnected) return;
    this.#received += frame.byteLength;
    if (this.#received < ANSWER_AFTER_BYTES) return;

    this.#received = 0;
    this.#turns += 1;
    const words = (this.#words() ?? "").trim();
    this.#emit("user", words === "" ? DEFAULT_USER_WORDS : words);
    this.#emit("assistant", ASSISTANT_WORDS);
    this.#sendTone();
    this.#setState("listening");
  }

  /**
   * Read the agent's reply out loud.
   *
   * Recorded as the fixture's own transcript of what it said and answered with a tone, so a caller
   * cannot pass by sending nothing: `spoken` is what it was asked to say, and the tone proves the
   * playback path received something to play.
   */
  speak(text: string): void {
    if (this.#disconnected || text.trim() === "") return;
    this.#spoken.push(text);
    this.#turns += 1;
    this.#emit("assistant", text);
    this.#sendTone();
    this.#setState("listening");
  }

  /** Everything this session was asked to say, in order. */
  get spoken(): readonly string[] {
    return this.#spoken;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  onTranscript(listener: (fragment: VoiceTranscriptFragment) => void): () => void {
    this.#transcriptListeners.add(listener);
    return () => this.#transcriptListeners.delete(listener);
  }

  onAudio(listener: (pcm16: Uint8Array) => void): () => void {
    this.#audioListeners.add(listener);
    return () => this.#audioListeners.delete(listener);
  }

  onStateChange(listener: (state: VoiceState) => void): () => void {
    this.#stateListeners.add(listener);
    listener(this.#state);
    return () => this.#stateListeners.delete(listener);
  }

  #emit(role: "user" | "assistant", text: string): void {
    // Parsed through the contract so a fixture cannot emit something the real adapter could not:
    // a test that passes on a shape the product cannot produce is a test that proves nothing.
    const fragment = voiceTranscriptFragmentSchema.parse({
      voiceSessionId: this.#sessionId,
      utteranceId: `${this.#sessionId}:${role === "user" ? "u" : "a"}${this.#turns}`,
      fragmentIndex: 0,
      isFinal: true,
      text,
      role,
      at: this.#now(),
      sequence: this.#sequence,
    });
    this.#sequence += 1;
    for (const listener of this.#transcriptListeners) listener(fragment);
  }

  /**
   * A short tone, so playback is exercised rather than merely wired.
   *
   * Silence would let a broken playback path pass: nothing to play and nothing to hear are the
   * same result in a headless test.
   */
  #sendTone(): void {
    const samples = Math.round((OUTPUT_SAMPLE_RATE_HZ * TONE_DURATION_MS) / 1000);
    const pcm = new Uint8Array(samples * 2);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < samples; index += 1) {
      const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / OUTPUT_SAMPLE_RATE_HZ) * 6000);
      view.setInt16(index * 2, value, true);
    }

    this.#setState("speaking");
    // Sent in chunks, because that is how the real provider sends it and a caller that only works
    // with one big frame would fail in production.
    const chunk = 4096;
    for (let offset = 0; offset < pcm.byteLength; offset += chunk) {
      const slice = pcm.subarray(offset, Math.min(offset + chunk, pcm.byteLength));
      for (const listener of this.#audioListeners) listener(slice);
    }
  }

  #setState(next: VoiceState): void {
    if (this.#state === next) return;
    this.#state = next;
    for (const listener of this.#stateListeners) listener(next);
  }
}
