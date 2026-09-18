/**
 * The Gemini Live wire, in one file.
 *
 * Everything that knows the provider's message shapes lives here, so the rest of the system
 * deals in normalised events and a provider change is a change to this file rather than a hunt
 * through the codebase. The shapes below were established by probing the real endpoint rather
 * than by reading the reference, and the places where reality disagreed with the reference are
 * called out where they bite.
 *
 * One rule is enforced by construction rather than by convention: **no credential ever travels
 * in a message body.** The key belongs in the socket URL's query parameter and nowhere else, and
 * `containsCredential` exists so a test can assert that against every shape this module builds
 * instead of a reviewer taking it on trust.
 */

/** The Live endpoint. The key is appended by the adapter, never by a caller. */
export const GEMINI_LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * The model this repository pins.
 *
 * Measured, not remembered: `plans/reports/verification-260917-0957-gemini-live-handshake.md`
 * resolves it from the provider catalogue. Its extended-thinking sibling is a *different model
 * id* rather than a parameter, which is why no thinking field is ever sent.
 */
export const DEFAULT_LIVE_MODEL = "gemini-3.8-live";

/** What the provider accepts as input: raw PCM16, 16 kHz, mono, little-endian. */
export const LIVE_INPUT_MIME = "audio/pcm;rate=16000";
export const LIVE_INPUT_SAMPLE_RATE_HZ = 16000;

/**
 * What the provider returns. Measured at 24 kHz, and deliberately not assumed to equal the input
 * rate: playback at the wrong rate is audible at once and reads as the model sounding wrong
 * rather than as a buffer being wrong.
 */
export const LIVE_OUTPUT_SAMPLE_RATE_HZ = 24000;

export type VoiceRole = "user" | "assistant" | "system";

/**
 * One provider message can carry several things at once — audio parts, a transcription update,
 * and the end of a turn — so parsing returns a list. Collapsing to a single event would silently
 * drop whichever arrived second.
 */
export type LiveEvent =
  | { kind: "ready" }
  | { kind: "audio"; pcm16: Uint8Array; sampleRateHz: number }
  | { kind: "transcript"; role: VoiceRole; text: string; final: boolean }
  | { kind: "turnComplete" }
  | { kind: "interrupted" }
  | { kind: "waitingForInput" }
  | { kind: "providerError"; message: string }
  | { kind: "unrecognised"; keys: string[] };

export interface LiveSetupOptions {
  /** Model id without the `models/` prefix. */
  model?: string;
  /** System instruction, as plain text. */
  systemInstruction?: string;
}

/**
 * The first message on a session.
 *
 * Three details are deliberate:
 *
 * - `responseModalities: ["AUDIO"]` because this is a voice surface. A session configured for
 *   text answers in text, and the surface then looks broken rather than misconfigured.
 * - Both transcription configs are on, because the contract's intent routing consumes a
 *   transcript, and a transcript produced anywhere else would be a second, less accurate source.
 * - No thinking field. Extended thinking is chosen by model id, so a thinking parameter would
 *   either be ignored or contradict the pinned model.
 *
 * Automatic activity detection is left at its default, which is the measured-good configuration:
 * turn boundaries are the provider's job and the client streams continuously.
 */
export function buildSetupMessage(options: LiveSetupOptions = {}): Record<string, unknown> {
  const setup: Record<string, unknown> = {
    model: `models/${options.model ?? DEFAULT_LIVE_MODEL}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  if (options.systemInstruction !== undefined) {
    setup["systemInstruction"] = { parts: [{ text: options.systemInstruction }] };
  }
  return { setup };
}

/**
 * One chunk of microphone audio.
 *
 * The sample rate travels inside the MIME type because that is where the provider reads it, and
 * a mismatch is silently transcribed wrongly rather than rejected.
 */
export function buildAudioMessage(pcm16: Uint8Array): Record<string, unknown> {
  return { realtimeInput: { audio: { data: encodeBase64(pcm16), mimeType: LIVE_INPUT_MIME } } };
}

/**
 * A text turn.
 *
 * Two callers, for two reasons. Tests and scripted sessions use it to open a conversation without a
 * microphone, and the adapter itself uses it to read the agent's reply out loud: the session's voice
 * is the provider's, the words are not.
 */
export function buildTextMessage(text: string): Record<string, unknown> {
  return { clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } };
}

/** Parse the `rate` out of a MIME type like `audio/pcm;rate=24000`. */
export function sampleRateFromMime(mimeType: string | undefined): number {
  const rate = /rate=(\d+)/.exec(mimeType ?? "")?.[1];
  return rate === undefined ? LIVE_OUTPUT_SAMPLE_RATE_HZ : Number.parseInt(rate, 10);
}

/**
 * Turn one raw provider frame into zero or more normalised events.
 *
 * A frame that cannot be understood yields `unrecognised` with its top-level keys rather than
 * being dropped, because a provider that starts sending a new field should show up in the log:
 * that is the difference between noticing an upgrade and living through an outage.
 */
export function parseServerMessage(raw: string): LiveEvent[] {
  const frame = parseFrame(raw);
  if (frame === undefined) return [{ kind: "unrecognised", keys: ["unparseable"] }];

  const failure = asRecord(frame["error"]);
  if (failure !== undefined) {
    return [{ kind: "providerError", message: asString(failure["message"]) ?? JSON.stringify(failure) }];
  }

  const events: LiveEvent[] = [];
  if (frame["setupComplete"] !== undefined) events.push({ kind: "ready" });

  const server = asRecord(frame["serverContent"]);
  if (server !== undefined) {
    events.push(...audioFrom(server), ...transcriptsFrom(server));
    if (server["interrupted"] === true) events.push({ kind: "interrupted" });
    if (server["waitingForInput"] === true) events.push({ kind: "waitingForInput" });
    if (server["turnComplete"] === true) events.push({ kind: "turnComplete" });
  }

  if (events.length === 0) {
    // These two are understood and simply not events we act on. Everything else is reported, so
    // a new field is noticed rather than assumed harmless.
    const silent = ["sessionResumptionUpdate", "usageMetadata"];
    const unknown = Object.keys(frame).filter((key) => !silent.includes(key));
    if (unknown.length > 0) events.push({ kind: "unrecognised", keys: unknown });
  }

  return events;
}

/** Audio parts of a model turn, decoded and with their rate made explicit. */
function audioFrom(server: Record<string, unknown>): LiveEvent[] {
  const turn = asRecord(server["modelTurn"]);
  const parts = turn?.["parts"];
  if (!Array.isArray(parts)) return [];

  const events: LiveEvent[] = [];
  for (const part of parts) {
    const inline = asRecord(asRecord(part)?.["inlineData"]);
    const data = asString(inline?.["data"]);
    if (inline === undefined || data === undefined) continue;
    events.push({
      kind: "audio",
      pcm16: decodeBase64(data),
      sampleRateHz: sampleRateFromMime(asString(inline["mimeType"])),
    });
  }
  return events;
}

/**
 * Transcription fields of a server message.
 *
 * Interim and final are separate fields on the wire and both matter: the interim one is what
 * makes the surface update while the user is still speaking, and the final one is what can be
 * trusted after the turn. Interim input is emitted at the same index the final will arrive at,
 * so a caller that keeps every fragment sees the interim replaced rather than appended.
 */
function transcriptsFrom(server: Record<string, unknown>): LiveEvent[] {
  const fields: Array<[string, VoiceRole]> = [
    ["interimInputTranscription", "user"],
    ["inputTranscription", "user"],
    ["outputTranscription", "assistant"],
  ];

  const events: LiveEvent[] = [];
  for (const [field, role] of fields) {
    const text = asString(asRecord(server[field])?.["text"]);
    if (text === undefined || text === "") continue;
    events.push({ kind: "transcript", role, text, final: false });
  }
  return events;
}

/**
 * Whether a message body contains the credential.
 *
 * A property for a test to assert, not a runtime guard: it turns "the key never travels in a
 * message" into something checked against every shape this module can build.
 */
export function containsCredential(message: unknown, credential: string): boolean {
  return credential !== "" && JSON.stringify(message).includes(credential);
}

/**
 * Decode one frame to a record, or nothing.
 *
 * This is the boundary: it is the only place in the module that touches untyped parsed JSON, and
 * it returns a named shape so nothing downstream has to handle `unknown`.
 */
function parseFrame(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Narrow to a record, which is what every step of parsing JSON needs.
 *
 * The `typeof` checks here are the I/O boundary itself rather than a check that belongs
 * elsewhere: this function is where an untyped frame becomes a shape the rest of the module can
 * read, and it is deliberately the only place that touches raw parsed JSON.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Feature-detect a global rather than branching on the environment: this module is loaded by the
 * node, and `Buffer` is the fast path there, but reading it off `globalThis` keeps the module
 * usable somewhere `Buffer` does not exist instead of throwing a ReferenceError.
 */
function nodeBuffer(): typeof Buffer | undefined {
  return (globalThis as { Buffer?: typeof Buffer }).Buffer;
}

function decodeBase64(text: string): Uint8Array {
  const buffer = nodeBuffer();
  if (buffer !== undefined) return new Uint8Array(buffer.from(text, "base64"));
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const buffer = nodeBuffer();
  if (buffer !== undefined) return buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
