import {
  type Instant,
  type RecognitionContext,
  type RecognitionTerm,
  type RecognizedUtterance,
  type SpeechRecognitionCapabilities,
  type VoiceState,
  nowInstant,
  recognizedUtteranceSchema,
} from "@clarkcant/contracts";

import { type LiveSocket, type LiveSocketFactory, globalSocketFactory } from "./gemini-live.ts";
import { GEMINI_LIVE_ENDPOINT, asRecord, asString, buildAudioMessage, parseFrame } from "./protocol.ts";
import type { SpeechRecognitionAdapter } from "./recognition.ts";
import { NEAR_MATCHABLE_KINDS } from "./transcript-normalizer.ts";

/**
 * Dedicated speech-to-text over Gemini's live transcription model.
 *
 * The live conversation model transcribes as a side effect of holding a conversation; this model does nothing else,
 * and its documentation states the two things ClarkCant needs from a recognizer: it detects the spoken language per
 * utterance, code-switching included, and it accepts a custom vocabulary. The wire is the same Live endpoint and the
 * same `realtimeInput` audio message, with a setup that asks for text and configures transcription, as documented at
 * https://ai.google.dev/gemini-api/docs/live-api/live-transcribe (checked 2026-10-06):
 *
 * - model `gemini-3.5-transcribe-live`, `responseModalities: ["TEXT"]`;
 * - `inputAudioTranscription.languageCodes` (empty means automatic detection), `customVocabulary` (an array of
 *   strings; up to 1,000, best results up to about 100) and `mode` (`VERBATIM` by default, `SMART` cleans up);
 * - `serverContent.interimInputTranscription.text` is a speculative hypothesis that replaces the one before it, and
 *   `serverContent.inputTranscription.text` is the finalized utterance;
 * - `realtimeInput.audioStreamEnd: true` finalizes what has been heard when the stream pauses;
 * - a session lasts at most ten minutes.
 *
 * Two choices are deliberate. The mode is `VERBATIM`, because `SMART` rewrites the sentence for readability and
 * rewriting is exactly what the canonical transcript must not suffer. And no language code is sent: the person's
 * interface language is a hint, and on this provider a code is a constraint, so automatic detection is what keeps
 * a Vietnamese sentence with English identifiers whole.
 *
 * The credential travels exactly as it does for the live session: in the socket URL's query parameter, asked for at
 * each connection through `tokenProvider`, never in a message body and never in a field.
 */

export const GEMINI_TRANSCRIBE_LIVE_MODEL = "gemini-3.5-transcribe-live";
/** Where the provider documents its best results; the provider accepts up to 1,000. */
export const GEMINI_TRANSCRIBE_MAX_VOCABULARY = 100;
/** The provider's documented session limit. A session that reaches it is reopened, not ended. */
export const GEMINI_TRANSCRIBE_SESSION_LIMIT_MS = 10 * 60_000;

const MAX_AUDIO_FRAME_BYTES = 512 * 1024;
/** Consecutive reopen attempts before the recognizer gives up and says so. */
const DEFAULT_MAX_REOPENS = 3;
/** How long a connection may take to complete setup before it counts as failed to open. */
export const DEFAULT_TRANSCRIBE_SETUP_TIMEOUT_MS = 5000;
/**
 * How long a reopened session has to continue a sentence the closed one was in.
 *
 * A session can end exactly as a sentence does. With nothing more said, the carried words would wait for the next
 * sentence and be joined to it; past this pause they are the whole sentence.
 */
export const DEFAULT_TRANSCRIBE_CARRY_TIMEOUT_MS = 1500;
/** Audio kept while a session reopens - ten seconds of PCM16 at 16 kHz mono - and sent once it is listening again. */
const RECONNECT_BACKLOG_BYTES = 10 * 32_000;
/** How long a connection must have worked before its close counts as the provider's limit rather than a fault. */
const STABLE_CONNECTION_MS = 30_000;

export interface TranscribeSetupOptions {
  model?: string;
  vocabulary?: readonly string[];
  languageCodes?: readonly string[];
}

/** The first message on a transcription session, in the shape the provider documents. */
export function buildTranscribeSetupMessage(options: TranscribeSetupOptions = {}): Record<string, unknown> {
  return {
    setup: {
      model: `models/${options.model ?? GEMINI_TRANSCRIBE_LIVE_MODEL}`,
      generationConfig: { responseModalities: ["TEXT"] },
      inputAudioTranscription: {
        languageCodes: [...(options.languageCodes ?? [])],
        customVocabulary: [...(options.vocabulary ?? [])].slice(0, GEMINI_TRANSCRIBE_MAX_VOCABULARY),
        mode: "VERBATIM",
      },
      realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
    },
  };
}

/** The pause signal: finalize what has been heard. */
export function buildAudioStreamEndMessage(): Record<string, unknown> {
  return { realtimeInput: { audioStreamEnd: true } };
}

/**
 * The provider's custom vocabulary, from the canonical context.
 *
 * Canonical spellings, or a model id's spoken family derived from one, most relevant first. Aliases stay local: an
 * alias is a known mis-hearing, and biasing a recognizer towards a mis-hearing is the opposite of the point. Terms that
 * agree up to case are sent once, as the higher-weighted one, so a model family (`gemini`) can stand in for a provider
 * (`Gemini`); the normaliser's casing rule restores the canonical case on the node.
 *
 * The vocabulary is a bias, not a hint the provider weighs against what it heard: measured on audio, it wrote a listed
 * term over a different word the person said ("Jeff" as `Jev`, "claude opus 3" as `claude-opus-4`, `setUser` as
 * `getUser`). The transcription model takes no instruction that could say "only when it was said" - the documented
 * setup has the vocabulary, the language codes and the mode, and nothing else - and it reports no alternatives or
 * confidence, so nothing after recognition can tell a substitution from what was said. What is sent is therefore
 * limited to terms with no close real twin; see `vocabularyBias`. Everything else stays on the node, where the
 * deterministic normaliser uses it only on evidence.
 */
export function transcribeVocabulary(context: RecognitionContext | undefined, max = GEMINI_TRANSCRIBE_MAX_VOCABULARY): string[] {
  if (context === undefined) return [];
  const seen = new Set<string>();
  const words: string[] = [];
  for (const term of [...context.terms].sort((left, right) => right.weight - left.weight)) {
    const text = vocabularyBias(term);
    if (text === undefined) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(text);
    if (words.length >= max) break;
  }
  return words;
}

/**
 * What of a term may bias the recognizer, or nothing.
 *
 * A bias is a near-match made without evidence, so it gets only what the normaliser would itself correct on a slip:
 * glossary words, providers and models (`NEAR_MATCHABLE_KINDS`).
 *
 * - Symbols, paths, branches, packages, tools, commands and issues are not sent. Their neighbours are other real names:
 *   measured on audio, a spoken `setUser` came back as a listed `getUser`, and with `getUser` withheld, as a listed
 *   `useState`. Their spelling is restored on the node instead, where the normaliser joins an exact spoken form ("use
 *   effect") and never a near one.
 * - A number is what a bias changes into another real reference, so a model id is sent as its spoken family before
 *   the first numbered part (`claude-opus-4` as `claude-opus`), which helps the spelling without choosing a version.
 *   The rule reads the term, not its kind: a glossary or provider term with a digit (none today) is cut the same way,
 *   so a hypothetical `utf-8` would go as `utf` and `S3` not at all.
 * - A short word that is not an acronym (`Jev`, `Pi`) is name-like: real words and names sound like it ("Jeff"), so it
 *   is not sent. Acronyms are spelled letter by letter and have no such twin.
 */
export function vocabularyBias(term: RecognitionTerm): string | undefined {
  if (!NEAR_MATCHABLE_KINDS.has(term.kind)) return undefined;
  const text = term.text;
  if (/\d/u.test(text)) {
    const family: string[] = [];
    for (const part of text.split("-")) {
      if (/\d/u.test(part)) break;
      family.push(part);
    }
    const spoken = family.join("-");
    return /\p{L}{2}/u.test(spoken) ? spoken : undefined;
  }
  if (/^\p{L}{1,3}$/u.test(text) && text !== text.toUpperCase()) return undefined;
  return text;
}

export type TranscribeEvent =
  | { kind: "ready" }
  | { kind: "interim"; text: string }
  | { kind: "final"; text: string }
  | { kind: "providerError"; message: string }
  | { kind: "unrecognised"; keys: string[] };

/** One provider frame as zero or more events. An unknown frame is reported by its keys, never dropped silently. */
export function parseTranscribeMessage(raw: string): TranscribeEvent[] {
  const frame = parseFrame(raw);
  if (frame === undefined) return [{ kind: "unrecognised", keys: ["unparseable"] }];

  const failure = asRecord(frame["error"]);
  if (failure !== undefined) {
    return [{ kind: "providerError", message: asString(failure["message"]) ?? "the transcription provider reported an error" }];
  }

  const events: TranscribeEvent[] = [];
  if (frame["setupComplete"] !== undefined) events.push({ kind: "ready" });
  const server = asRecord(frame["serverContent"]);
  if (server !== undefined) {
    const interim = asString(asRecord(server["interimInputTranscription"])?.["text"]);
    if (interim !== undefined && interim.trim() !== "") events.push({ kind: "interim", text: interim });
    const final = asString(asRecord(server["inputTranscription"])?.["text"]);
    if (final !== undefined && final.trim() !== "") events.push({ kind: "final", text: final });
    // A model turn, `turnComplete` or `generationComplete` carries nothing a transcriber needs.
    if (events.length === 0 && server["turnComplete"] === undefined && server["generationComplete"] === undefined && server["modelTurn"] === undefined) {
      events.push({ kind: "unrecognised", keys: Object.keys(server).map((key) => `serverContent.${key}`) });
    }
    return events;
  }
  if (events.length === 0) {
    const silent = ["sessionResumptionUpdate", "usageMetadata", "goAway"];
    const unknown = Object.keys(frame).filter((key) => !silent.includes(key));
    if (unknown.length > 0) events.push({ kind: "unrecognised", keys: unknown });
  }
  return events;
}

export interface GeminiTranscribeOptions {
  model?: string;
  endpoint?: string;
  createSocket?: LiveSocketFactory;
  now?: () => Instant;
  /** Consecutive reopen attempts after an unexpected close. */
  maxReopens?: number;
  /** How long one connection may take to complete setup. */
  setupTimeoutMs?: number;
  /** How long a reopened session has to continue the sentence the closed one was in, before that part is final. */
  carryTimeoutMs?: number;
}

export class GeminiTranscribeLiveAdapter implements SpeechRecognitionAdapter {
  readonly provider = "gemini-transcribe";
  readonly model: string;
  readonly capabilities: SpeechRecognitionCapabilities;

  readonly #endpoint: string;
  readonly #createSocket: LiveSocketFactory;
  readonly #now: () => Instant;
  readonly #maxReopens: number;
  readonly #setupTimeoutMs: number;
  readonly #carryTimeoutMs: number;

  #socket: LiveSocket | undefined;
  /** Ends the wait for a reopened session to continue the carried sentence. */
  #carryTimer: ReturnType<typeof setTimeout> | undefined;
  #setupTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The utterance a closed session was in the middle of.
   *
   * A reopen is not the end of a sentence: the provider ends every session at ten minutes, whatever the person is
   * saying. What the closed session had heard stays the start of the utterance, and the reopened session's reading of
   * the rest is joined to it, so one sentence is still one utterance - never half of it dispatched as if complete.
   */
  #carry: string | undefined;
  /** Audio heard while reopening, sent to the new session once it listens, so the words said meanwhile are not lost. */
  #backlog: Uint8Array[] = [];
  #backlogBytes = 0;
  #sessionId = "";
  #tokenProvider: (() => Promise<string>) | undefined;
  #context: RecognitionContext | undefined;
  #contextApplied = false;
  #state: VoiceState = "idle";
  #stopped = false;
  #muted = false;
  #reopens = 0;
  /** Whether the current connection completed setup, and when: a close before it is a failure to open. */
  #readyAtMs: number | undefined;
  #sequence = 0;
  #utterance = 0;
  #revision = 0;
  #interim: string | undefined;
  #pendingReady: { resolve: () => void; reject: (cause: Error) => void } | undefined;
  #framesSent = 0;
  #framesDropped = 0;

  readonly #utteranceListeners = new Set<(utterance: RecognizedUtterance) => void>();
  readonly #stateListeners = new Set<(state: VoiceState) => void>();

  constructor(options: GeminiTranscribeOptions = {}) {
    this.model = options.model ?? GEMINI_TRANSCRIBE_LIVE_MODEL;
    this.#endpoint = options.endpoint ?? GEMINI_LIVE_ENDPOINT;
    this.#createSocket = options.createSocket ?? globalSocketFactory;
    this.#now = options.now ?? nowInstant;
    this.#maxReopens = options.maxReopens ?? DEFAULT_MAX_REOPENS;
    this.#setupTimeoutMs = options.setupTimeoutMs ?? DEFAULT_TRANSCRIBE_SETUP_TIMEOUT_MS;
    this.#carryTimeoutMs = options.carryTimeoutMs ?? DEFAULT_TRANSCRIBE_CARRY_TIMEOUT_MS;
    this.capabilities = {
      provider: this.provider,
      model: this.model,
      interimResults: true,
      // Detected per utterance by the provider, but not reported back on the wire: nothing here claims a language.
      languageDetection: false,
      confidence: "none",
      vocabulary: true,
      maxVocabularyTerms: GEMINI_TRANSCRIBE_MAX_VOCABULARY,
      contextUpdate: "next-connection",
      utteranceRetry: true,
    };
  }

  get state(): VoiceState {
    return this.#state;
  }

  /** Frames forwarded and frames refused, so "it heard nothing" can be told apart from "nothing was sent". */
  get audioFrameCounts(): { sent: number; dropped: number } {
    return { sent: this.#framesSent, dropped: this.#framesDropped };
  }

  async start(input: { sessionId: string; tokenProvider: () => Promise<string>; context?: RecognitionContext }): Promise<void> {
    if (this.#tokenProvider !== undefined) {
      throw new Error("this recognizer is already started; create a new one for a new session");
    }
    this.#sessionId = input.sessionId;
    this.#tokenProvider = input.tokenProvider;
    this.#context = input.context;
    await this.#open();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#clearSetupTimer();
    this.#clearCarryTimer();
    this.#backlog = [];
    this.#backlogBytes = 0;
    // A `start` still waiting for setup is released rather than left pending for ever: stopping is how a caller that
    // stopped waiting gets its connection closed.
    const pending = this.#pendingReady;
    this.#pendingReady = undefined;
    socket?.close();
    if (this.#state !== "failed") this.#setState("ended");
    pending?.reject(new Error("the recognizer was stopped before it was listening"));
  }

  sendAudio(frame: Uint8Array): void {
    if (this.#muted || frame.byteLength === 0 || frame.byteLength > MAX_AUDIO_FRAME_BYTES) {
      this.#framesDropped += 1;
      return;
    }
    if (this.#state === "reconnecting" && !this.#stopped) {
      this.#holdForReconnect(frame);
      return;
    }
    const socket = this.#socket;
    if (socket === undefined || this.#state !== "listening") {
      this.#framesDropped += 1;
      return;
    }
    socket.send(JSON.stringify(buildAudioMessage(frame)));
    this.#framesSent += 1;
  }

  endAudio(): void {
    if (this.#socket === undefined || this.#state !== "listening") return;
    this.#socket.send(JSON.stringify(buildAudioStreamEndMessage()));
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  updateContext(context: RecognitionContext): void {
    // Applied at the next connection, which `capabilities.contextUpdate` says: the provider reads vocabulary at setup.
    this.#context = context;
  }

  onUtterance(listener: (utterance: RecognizedUtterance) => void): () => void {
    this.#utteranceListeners.add(listener);
    return () => this.#utteranceListeners.delete(listener);
  }

  onStateChange(listener: (state: VoiceState) => void): () => void {
    this.#stateListeners.add(listener);
    listener(this.#state);
    return () => this.#stateListeners.delete(listener);
  }

  async #open(): Promise<void> {
    const tokenProvider = this.#tokenProvider;
    if (tokenProvider === undefined) throw new Error("the recognizer was never started");
    this.#setState(this.#reopens > 0 ? "reconnecting" : "connecting");

    const credential = await tokenProvider();
    if (credential === "") {
      this.#setState("failed");
      throw new Error("no credential was provided for the transcription session");
    }
    if (this.#stopped) throw new Error("the recognizer was stopped before it was listening");
    const vocabulary = transcribeVocabulary(this.#context);
    this.#readyAtMs = undefined;
    const ready = new Promise<void>((resolve, reject) => {
      this.#pendingReady = { resolve, reject };
    });
    const socket = this.#createSocket(`${this.#endpoint}?key=${encodeURIComponent(credential)}`);
    this.#socket = socket;
    // A provider that accepts the connection and never completes setup must not hold the session open: past the
    // bound it is a failure to open, which the caller can fall back from.
    this.#clearSetupTimer();
    this.#setupTimer = setTimeout(() => {
      this.#setupTimer = undefined;
      if (this.#socket !== socket || this.#readyAtMs !== undefined) return;
      this.#socket = undefined;
      socket.close();
      this.#rejectPending(new Error(`transcription setup did not complete within ${this.#setupTimeoutMs} ms`));
    }, this.#setupTimeoutMs);

    socket.onOpen(() => {
      socket.send(JSON.stringify(buildTranscribeSetupMessage({ model: this.model, vocabulary })));
      this.#contextApplied = vocabulary.length > 0;
    });
    socket.onMessage((payload) => {
      if (this.#socket !== socket) return;
      for (const event of parseTranscribeMessage(payload)) this.#apply(event);
    });
    socket.onError((message) => {
      if (this.#socket !== socket) return;
      this.#rejectPending(new Error(`transcription transport failed: ${message}`));
    });
    socket.onClose((info) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#closed(info);
    });

    await ready;
  }

  /**
   * An unexpected close.
   *
   * The provider ends every session at ten minutes, so a close after a working session is reopened rather than
   * reported as the end of recognition; the newest context is applied on the way. A hypothesis the closed session never
   * finalized is not dispatched as if complete: it is carried into the reopened session as the start of the same
   * utterance. If recognition cannot continue, it stays the last interim, which the caller keeps or hands to another
   * source.
   */
  #closed(info: { code: number; reason: string }): void {
    this.#clearSetupTimer();
    this.#clearCarryTimer();
    if (this.#readyAtMs === undefined) {
      this.#setState("failed");
      this.#rejectPending(new Error(`transcription socket closed before setup (${info.code}${info.reason === "" ? "" : `: ${info.reason}`})`));
      return;
    }
    if (this.#stopped || this.#state === "ended" || this.#state === "failed") return;
    // A connection that lived a while earns a fresh budget; one that keeps dying at once does not loop forever.
    if (Date.now() - this.#readyAtMs >= STABLE_CONNECTION_MS) this.#reopens = 0;
    if (this.#reopens >= this.#maxReopens) {
      this.#setState("failed");
      return;
    }
    this.#reopens += 1;
    this.#carry = this.#interim;
    this.#open().catch(() => {
      this.#backlog = [];
      this.#backlogBytes = 0;
      this.#setState("failed");
    });
  }

  #holdForReconnect(frame: Uint8Array): void {
    this.#backlog.push(frame.slice());
    this.#backlogBytes += frame.byteLength;
    while (this.#backlogBytes > RECONNECT_BACKLOG_BYTES) {
      const dropped = this.#backlog.shift();
      this.#backlogBytes -= dropped?.byteLength ?? 0;
      this.#framesDropped += 1;
    }
  }

  #sendBacklog(): void {
    const socket = this.#socket;
    const held = this.#backlog;
    this.#backlog = [];
    this.#backlogBytes = 0;
    if (socket === undefined) return;
    for (const frame of held) {
      socket.send(JSON.stringify(buildAudioMessage(frame)));
      this.#framesSent += 1;
    }
  }

  #clearSetupTimer(): void {
    if (this.#setupTimer === undefined) return;
    clearTimeout(this.#setupTimer);
    this.#setupTimer = undefined;
  }

  /** Give the reopened session a short while to continue the carried sentence; past it, the carried words are final. */
  #armCarry(): void {
    this.#clearCarryTimer();
    if (this.#carry === undefined || this.#carry.trim() === "") return;
    this.#carryTimer = setTimeout(() => {
      this.#carryTimer = undefined;
      const carry = this.#carry?.trim();
      this.#carry = undefined;
      if (carry === undefined || carry === "" || this.#stopped) return;
      this.#interim = undefined;
      this.#emit(carry, true, "session-end");
      this.#utterance += 1;
      this.#revision = 0;
    }, this.#carryTimeoutMs);
  }

  #clearCarryTimer(): void {
    if (this.#carryTimer === undefined) return;
    clearTimeout(this.#carryTimer);
    this.#carryTimer = undefined;
  }

  /** A reading of the current utterance, after whatever a closed session had already heard of it. */
  #withCarry(text: string): string {
    const carry = this.#carry?.trim();
    return carry === undefined || carry === "" ? text : `${carry} ${text.trim()}`;
  }

  #rejectPending(cause: Error): void {
    const pending = this.#pendingReady;
    this.#pendingReady = undefined;
    if (pending === undefined) return;
    this.#setState("failed");
    pending.reject(cause);
  }

  #apply(event: TranscribeEvent): void {
    switch (event.kind) {
      case "ready": {
        this.#clearSetupTimer();
        this.#readyAtMs = Date.now();
        this.#setState("listening");
        this.#sendBacklog();
        this.#armCarry();
        const pending = this.#pendingReady;
        this.#pendingReady = undefined;
        pending?.resolve();
        return;
      }
      case "interim": {
        // The reopened session is still in the carried sentence.
        this.#clearCarryTimer();
        const text = this.#withCarry(event.text);
        this.#interim = text;
        this.#emit(text, false);
        return;
      }
      case "final": {
        this.#clearCarryTimer();
        const text = this.#withCarry(event.text);
        this.#carry = undefined;
        this.#interim = undefined;
        this.#emit(text, true);
        this.#utterance += 1;
        this.#revision = 0;
        return;
      }
      case "providerError": {
        this.#setState("failed");
        this.#rejectPending(new Error(event.message));
        return;
      }
      case "unrecognised":
        return;
      default: {
        const unhandled: never = event;
        void unhandled;
      }
    }
  }

  #emit(text: string, isFinal: boolean, settledBy: "provider" | "session-end" = "provider"): void {
    const utterance = recognizedUtteranceSchema.parse({
      voiceSessionId: this.#sessionId,
      utteranceId: `${this.#sessionId}:s${this.#utterance}`,
      revision: this.#revision,
      isFinal,
      text: text.slice(0, 8000),
      ...(isFinal ? { settledBy } : {}),
      provider: this.provider,
      model: this.model,
      contextApplied: this.#contextApplied,
      at: this.#now(),
      sequence: this.#sequence,
    });
    this.#revision += 1;
    this.#sequence += 1;
    for (const listener of this.#utteranceListeners) listener(utterance);
  }

  #setState(next: VoiceState): void {
    if (this.#state === next) return;
    this.#state = next;
    for (const listener of this.#stateListeners) listener(next);
  }
}
