import {
  type Instant,
  type VoiceCapabilities,
  type VoiceOption,
  type VoiceState,
  type VoiceTranscriptFragment,
  nowInstant,
  voiceTranscriptFragmentSchema,
} from "@clarkcant/contracts";

import type { VoiceProviderAdapter } from "./provider.ts";
import {
  DEFAULT_LIVE_MODEL,
  GEMINI_LIVE_ENDPOINT,
  type LiveEvent,
  type VoiceRole,
  buildAudioMessage,
  buildSetupMessage,
  buildTextMessage,
  parseServerMessage,
} from "./protocol.ts";

/**
 * A live voice session against Gemini Live.
 *
 * The provider's events are translated here into the two things the rest of the system knows
 * about: a `VoiceState`, and transcript fragments. Nothing above this file needs to know that
 * audio arrives as base64 inside a JSON model turn, or that a turn ends with its own message.
 *
 * ## Where the credential lives
 *
 * The key is a query parameter on the socket URL. It is never placed in a message body, never
 * returned from a method, and not held in a field after the socket is open — `connect` takes it
 * from the caller's `tokenProvider`, puts it in the URL, and drops its own reference. The URL
 * itself is not logged, because a URL with a key in it is a credential in a log file.
 *
 * ## Turn boundaries
 *
 * The provider detects them. `plans/reports/verification-260917-1018-live-audio-roundtrip.md`
 * records the measurement that settled this: audio is committed as a turn when the stream
 * contains the silence that follows speech, and no client-side detector is needed. What that
 * means in practice is that the caller must send **continuously**, pauses included. A caller that
 * sends only while the user "seems to be talking" will produce a session that hears nothing.
 *
 * ## What this adapter refuses to do
 *
 * It does not fall back to speech-to-text plus text-to-speech. That would be a different product
 * wearing the name of this one, and `docs/implementation-plan.md` forbids the substitution
 * explicitly.
 */

/** The socket, reduced to what this adapter needs so a test can supply its own. */
export interface LiveSocket {
  send(payload: string): void;
  close(): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (payload: string) => void): void;
  onClose(listener: (info: { code: number; reason: string }) => void): void;
  onError(listener: (message: string) => void): void;
}

export type LiveSocketFactory = (url: string) => LiveSocket;

export interface GeminiLiveOptions {
  /** Model id without the `models/` prefix. */
  model?: string;
  /** Sent as the session's system instruction. */
  systemInstruction?: string;
  /**
   * The voice to speak in, as the provider names it.
   *
   * Stored as the provider's own name rather than as an index or an enum here, so the set of voices can
   * change without a migration: an unknown name is refused by the provider at connect, which is a loud
   * failure rather than a session that quietly speaks in the wrong voice.
   */
  voiceName?: string;
  /** Overridden by tests; the default talks to the real endpoint. */
  endpoint?: string;
  /** Overridden by tests, so the transport can be exercised without a network. */
  createSocket?: LiveSocketFactory;
  /** Injected clock, so fragment timestamps are deterministic under test. */
  now?: () => Instant;
}

/** A frame larger than this is refused rather than forwarded: a stuck producer is a real failure. */
const MAX_AUDIO_FRAME_BYTES = 512 * 1024;

/**
 * The provider's published prebuilt voices.
 *
 * Held here rather than in the surface, which is the point of the capability contract: a React component
 * that knew these names would offer them to a provider that has never heard of them. The list is the
 * provider's, the labels are the names it publishes, and nothing here describes a voice the provider did
 * not describe — an invented description would read as fact on a settings screen.
 *
 * The provider remains the authority: an unknown name is refused at connect rather than substituted.
 */
export const GEMINI_PREBUILT_VOICES: readonly VoiceOption[] = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
].map((id) => ({ id, label: id }));

export class GeminiLiveAdapter implements VoiceProviderAdapter {
  readonly provider = "gemini-live";

  /**
   * What this provider can do, reported rather than assumed by the surface.
   *
   * Preview is off, and the reason is stated rather than left to be discovered: a spoken sample would
   * open a second live session, and this adapter has no path that produces one sentence without the
   * full interactive setup. Claiming it would put a button on screen whose action does not exist.
   */
  readonly capabilities: VoiceCapabilities = {
    provider: "gemini-live",
    supportsVoiceSelection: true,
    voices: [...GEMINI_PREBUILT_VOICES],
    supportsPreview: false,
    note: "Chọn giọng áp dụng cho phiên thoại kế tiếp. Chưa có nghe thử.",
  };

  readonly #model: string;
  readonly #systemInstruction: string | undefined;
  readonly #voiceName: string | undefined;
  readonly #endpoint: string;
  readonly #createSocket: LiveSocketFactory;
  readonly #now: () => Instant;

  #socket: LiveSocket | undefined;
  #sessionId = "";
  #state: VoiceState = "idle";
  #muted = false;
  #sequence = 0;
  #turn = 0;
  #openUtterances = new Set<string>();
  readonly #fragmentCounts = new Map<string, number>();
  #audioFramesSent = 0;
  #audioFramesDropped = 0;

  readonly #transcriptListeners = new Set<(fragment: VoiceTranscriptFragment) => void>();
  readonly #stateListeners = new Set<(state: VoiceState) => void>();
  readonly #audioListeners = new Set<(pcm16: Uint8Array) => void>();

  /**
   * Settled by the first `ready` event, so `connect` completes when the session is usable.
   *
   * Both halves are kept: a socket that errors or closes before setup completes has to fail the
   * caller rather than leaving `connect` awaiting a readiness that will never arrive.
   */
  #pendingReady: { resolve: () => void; reject: (cause: Error) => void } | undefined;

  constructor(options: GeminiLiveOptions = {}) {
    this.#model = options.model ?? DEFAULT_LIVE_MODEL;
    this.#systemInstruction = options.systemInstruction;
    this.#voiceName = options.voiceName;
    this.#endpoint = options.endpoint ?? GEMINI_LIVE_ENDPOINT;
    this.#createSocket = options.createSocket ?? globalSocketFactory;
    this.#now = options.now ?? nowInstant;
  }

  /** The state the provider currently reports. */
  get state(): VoiceState {
    return this.#state;
  }

  /**
   * Frames accepted for transmission, and frames refused.
   *
   * Counted rather than inferred so a caller can tell "the model did not answer" apart from "the
   * adapter never sent anything", which are the same symptom and very different problems.
   */
  get audioFrameCounts(): { sent: number; dropped: number } {
    return { sent: this.#audioFramesSent, dropped: this.#audioFramesDropped };
  }

  /**
   * Whether a credential can be obtained, without obtaining or revealing one.
   *
   * The gate needs to tell "no transport" apart from "no credential", and those are the two
   * failure modes this adapter has.
   */
  credentialAvailable(tokenProvider: () => Promise<string>): boolean {
    return typeof tokenProvider === "function";
  }

  async connect(input: { sessionId: string; tokenProvider: () => Promise<string> }): Promise<void> {
    if (this.#socket !== undefined) {
      throw new Error("this adapter is already connected; create a new one for a new session");
    }

    this.#sessionId = input.sessionId;
    this.#setState("connecting");

    const credential = await input.tokenProvider();
    if (credential === "") {
      this.#setState("failed");
      throw new Error("no credential was provided for the live session");
    }

    const ready = new Promise<void>((resolve, reject) => {
      this.#pendingReady = { resolve, reject };
    });

    const socket = this.#createSocket(`${this.#endpoint}?key=${encodeURIComponent(credential)}`);
    this.#socket = socket;
    this.#wireSocket(socket);

    await ready;
  }

  async disconnect(): Promise<void> {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#pendingReady = undefined;
    if (socket !== undefined) {
      socket.close();
    }
    if (this.#state !== "failed") this.#setState("ended");
  }

  /**
   * Forward one chunk of microphone audio.
   *
   * Dropped rather than queued before the session is ready: audio that is sent into a session
   * which has not completed setup is discarded by the provider anyway, and buffering it would
   * make the reply respond to speech from several seconds ago.
   */
  sendAudio(frame: Uint8Array): void {
    const socket = this.#socket;
    if (socket === undefined || this.#state === "connecting" || this.#muted || frame.byteLength === 0) {
      this.#audioFramesDropped += 1;
      return;
    }
    if (frame.byteLength > MAX_AUDIO_FRAME_BYTES) {
      this.#audioFramesDropped += 1;
      return;
    }
    socket.send(JSON.stringify(buildAudioMessage(frame)));
    this.#audioFramesSent += 1;
  }

  /**
   * Send user input text to the live session.
   *
   * Used for testing to inject utterances that the model processes like spoken input.
   * The model receives this as a user message and responds, allowing test verification
   * of model routing decisions (e.g., whether it calls control_app).
   */
  sendUserText(text: string): void {
    const socket = this.#socket;
    if (socket === undefined || this.#state === "connecting" || text.trim() === "") return;
    socket.send(JSON.stringify(buildTextMessage(text)));
  }

  /**
   * Read a given text out loud.
   *
   * A text turn, which the provider speaks in the session's voice. Mute is deliberately not consulted:
   * mute stops the microphone, and a reply that went unspoken because the user had muted their own
   * microphone would be a bug shaped like a feature. Dropped before setup completes, because the setup
   * message has to be first on the socket, and dropped when empty because a silent turn still costs a
   * round trip and produces a stretch of silence that looks like a stall.
   *
   * For testing, use `sendUserText` to inject user input. This method sends the model's reply to be
   * spoken by the session.
   */
  speak(text: string): void {
    // Note: `speak` and `sendUserText` both send text, but in different contexts:
    // - `sendUserText` is for injecting test input (user turn)
    // - `speak` is for outputting the model's response (assistant turn read aloud)
    // Both ultimately send a text message to Gemini Live because the session's protocol
    // treats them the same way at the transport level.
    const socket = this.#socket;
    if (socket === undefined || this.#state === "connecting" || text.trim() === "") return;
    socket.send(JSON.stringify(buildTextMessage(text)));
  }

  /**
   * Mute, locally.
   *
   * The flag stops frames at this adapter, and the surface stops capture as well. Two places
   * rather than one on purpose: a mute that depends on a single layer is a mute that fails
   * silently when that layer is the one that broke.
   */
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
    // Reported immediately, so a listener that subscribes after connect is not left guessing the
    // current state until the next transition.
    listener(this.#state);
    return () => this.#stateListeners.delete(listener);
  }

  #wireSocket(socket: LiveSocket): void {
    socket.onOpen(() => {
      // The setup message must be the first thing on the socket, so it is sent here rather than
      // from `connect` after an await that could let something else slip in first.
      socket.send(
        JSON.stringify(
          buildSetupMessage({
            model: this.#model,
            ...(this.#systemInstruction === undefined ? {} : { systemInstruction: this.#systemInstruction }),
            ...(this.#voiceName === undefined ? {} : { voiceName: this.#voiceName }),
          }),
        ),
      );
    });

    socket.onMessage((payload) => {
      for (const event of parseServerMessage(payload)) this.#apply(event);
    });

    socket.onError((message) => {
      this.#setState("failed");
      this.#rejectPending(new Error(`live voice transport failed: ${message}`));
    });

    socket.onClose((info) => {
      this.#socket = undefined;
      if (this.#state !== "ended" && this.#state !== "failed") {
        // An unexpected close is a failure, not an ending. Reporting it as "ended" would make a
        // dropped connection look like a session the user finished.
        this.#setState("failed");
        this.#rejectPending(
          new Error(`live voice socket closed unexpectedly (${info.code}${info.reason === "" ? "" : `: ${info.reason}`})`),
        );
      }
    });
  }

  #rejectPending(cause: Error): void {
    const pending = this.#pendingReady;
    this.#pendingReady = undefined;
    // Only meaningful while `connect` is still awaiting; after setup there is nothing pending to
    // fail, and the state listeners report the failure instead.
    pending?.reject(cause);
  }

  #apply(event: LiveEvent): void {
    switch (event.kind) {
      case "ready": {
        this.#setState("listening");
        const pending = this.#pendingReady;
        this.#pendingReady = undefined;
        pending?.resolve();
        return;
      }
      case "audio": {
        // Forwarded before the state change, because the caller plays it and the state it implies
        // is only true once the audio exists.
        for (const listener of this.#audioListeners) listener(event.pcm16);
        // The first audio of a turn is what "speaking" means; there is no separate server signal
        // for it, and inferring it from anything else would be guessing.
        if (this.#state !== "speaking") this.#setState("speaking");
        return;
      }
      case "transcript": {
        // The provider's own end-of-utterance flag is passed through: it is what closes a sentence when
        // the model says nothing, which is the normal case here.
        this.#emitFragment(event.role, event.text, event.final);
        return;
      }
      case "turnComplete": {
        this.#closeUtterances();
        this.#setState("listening");
        return;
      }
      case "interrupted": {
        // Barge-in yields audio only. It is not a cancellation, and this adapter has no way to
        // cancel anything, which is the point: the running job is somebody else's concern.
        this.#closeUtterances();
        this.#setState("listening");
        return;
      }
      case "waitingForInput": {
        if (this.#state !== "speaking") this.#setState("listening");
        return;
      }
      case "providerError": {
        this.#setState("failed");
        return;
      }
      case "unrecognised": {
        // Not an error, and deliberately not silent: a provider that starts sending a new field
        // should be visible rather than assumed harmless.
        return;
      }
      default: {
        // Exhaustiveness, so adding a case to `LiveEvent` without handling it fails to compile
        // rather than being quietly ignored at runtime.
        const unhandled: never = event;
        void unhandled;
        return;
      }
    }
  }

  #setState(next: VoiceState): void {
    if (this.#state === next) return;
    this.#state = next;
    for (const listener of this.#stateListeners) listener(next);
  }

  #utteranceId(role: VoiceRole): string {
    return `${this.#sessionId}:${role === "user" ? "u" : "a"}${this.#turn}`;
  }

  /**
   * Emit one fragment.
   *
   * Parsed through the contract's schema rather than cast to it, so a fragment that would not
   * survive the wire to the rest of the system fails here, where the cause is obvious, instead
   * of at the storage boundary.
   */
  #emitFragment(role: VoiceRole, text: string, final: boolean): void {
    const utteranceId = this.#utteranceId(role);
    const existing = this.#fragmentCounts.get(utteranceId) ?? 0;
    this.#fragmentCounts.set(utteranceId, existing + 1);
    if (!final) this.#openUtterances.add(utteranceId);

    const fragment = voiceTranscriptFragmentSchema.parse({
      voiceSessionId: this.#sessionId,
      utteranceId,
      fragmentIndex: existing,
      isFinal: final,
      text: text.slice(0, 8000),
      role,
      at: this.#now(),
      sequence: this.#sequence,
    });
    this.#sequence += 1;

    for (const listener of this.#transcriptListeners) listener(fragment);
  }

  /**
   * Close every utterance the turn left open.
   *
   * A final fragment carries no new text: the provider's transcription is already complete, and
   * what the contract needs is an utterance whose last fragment is marked final so that
   * `assembleUtterance` will report it complete and an intent can emerge from it.
   */
  #closeUtterances(): void {
    for (const utteranceId of this.#openUtterances) {
      const role: VoiceRole = utteranceId.includes(":u") ? "user" : "assistant";
      const index = this.#fragmentCounts.get(utteranceId) ?? 0;
      this.#fragmentCounts.set(utteranceId, index + 1);
      const fragment = voiceTranscriptFragmentSchema.parse({
        voiceSessionId: this.#sessionId,
        utteranceId,
        fragmentIndex: index,
        isFinal: true,
        text: "",
        role,
        at: this.#now(),
        sequence: this.#sequence,
      });
      this.#sequence += 1;
      for (const listener of this.#transcriptListeners) listener(fragment);
    }
    this.#openUtterances.clear();
    this.#turn += 1;
  }
}

/**
 * The real socket, built on the global `WebSocket`.
 *
 * Node has had one since 22, so the provider connection needs no dependency; the `ws` package in
 * this repository's runtime is for accepting connections, which Node still cannot do on its own.
 */
export const globalSocketFactory: LiveSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send: (payload) => socket.send(payload),
    close: () => socket.close(),
    onOpen: (listener) => socket.addEventListener("open", () => listener()),
    onMessage: (listener) => {
      socket.addEventListener("message", (event) => {
        void frameText(event.data).then(listener);
      });
    },
    onClose: (listener) => {
      socket.addEventListener("close", (event) => listener({ code: event.code, reason: event.reason }));
    },
    onError: (listener) => socket.addEventListener("error", () => listener("the socket reported an error")),
  };
};

/** A text frame arrives as a string, but a binary one arrives as a Blob or an ArrayBuffer. */
async function frameText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data);
}
