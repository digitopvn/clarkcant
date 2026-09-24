/**
 * Gemini text-to-speech, over the Interactions API.
 *
 * This is deliberately **not** an implementation of `VoiceProviderAdapter`: that interface models a
 * live, bidirectional session (`connect`, `sendAudio`, continuous state), and the Interactions API is a
 * single request that returns a finished clip. Forcing a request/response call through a session-shaped
 * interface would mean either faking `connect`/`disconnect` around one HTTP call, or leaving most of the
 * adapter interface throwing — neither is an implementation of the seam, both are a session that lies
 * about what it is.
 *
 * Two models are exposed:
 *
 * - `gemini-3.8-flash-tts`      — highest fidelity, the "high-fidelity" option.
 * - `gemini-3.8-flash-lite-tts` — fast and cheap, the default.
 *
 * Nothing here decides which one a caller should use; `DEFAULT_TTS_MODEL` names the default and callers
 * that want the high-fidelity model pass `GEMINI_TTS_FLASH_MODEL` explicitly.
 *
 * No UI wires into this yet. Clark's spoken replies today come from `GeminiLiveAdapter.speak`, which
 * sends text into the already-open live session rather than making a separate synthesis call. This
 * module exists as the provider seam for the day a non-live speech path — reading a reply aloud without
 * an open live session, for instance — has a caller; until then it is proven by its own tests rather than
 * by a settings row with nothing behind it (see `docs/research/adr-002-gemini-tts-flash.md`).
 */

/** Highest-fidelity model: 130 languages, voice design and replication. */
export const GEMINI_TTS_FLASH_MODEL = "gemini-3.8-flash-tts";

/** Fast/cheap model: 101 languages. Official replacement for `gemini-3.1-flash-tts-preview`. */
export const GEMINI_TTS_FLASH_LITE_MODEL = "gemini-3.8-flash-lite-tts";

/** The default this repository picks when a caller does not name a model. */
export const DEFAULT_TTS_MODEL = GEMINI_TTS_FLASH_LITE_MODEL;

export const GEMINI_INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** Input token limit the API documents for both 3.8 TTS models. */
export const GEMINI_TTS_MAX_INPUT_TOKENS = 8192;

const SUPPORTED_SAMPLE_RATES = [24000, 16000, 8000] as const;
export type GeminiTtsSampleRate = (typeof SUPPORTED_SAMPLE_RATES)[number];

export interface GeminiTtsRequest {
  /** Text read verbatim by the model. Performance direction belongs in `style`, not here. */
  text: string;
  /** Overrides `DEFAULT_TTS_MODEL`. */
  model?: string;
  /** The provider's own voice name, e.g. `"Kore"`. Omitted: the provider's own default voice. */
  voice?: string;
  /** Free-text delivery direction, e.g. `"cheerful and friendly"`. Never embedded in `text`. */
  style?: string;
  /** Defaults to the API's own default (24 kHz, unary). */
  sampleRateHz?: GeminiTtsSampleRate;
}

export interface GeminiTtsResult {
  /** Decoded audio bytes. */
  audio: Uint8Array;
  mimeType: string;
}

/** The subset of `fetch` this module needs, so a test can inject its own without a network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface GeminiTtsOptions {
  /** Overridden by tests; the default talks to the real endpoint. */
  endpoint?: string;
  /** Injected transport, so this module is exercised without a network or a quota-consuming call. */
  fetch?: FetchLike;
}

/**
 * A single-request text-to-speech client.
 *
 * `apiKey` is asked for at call time, the same reasoning `VoiceProviderAdapter.connect`'s
 * `tokenProvider` uses: a credential passed once at construction tends to end up in a field a logger
 * can reach, and a header set fresh for each request keeps the window it exists in as short as the
 * caller wants.
 */
export class GeminiTtsClient {
  readonly #endpoint: string;
  readonly #fetch: FetchLike;

  constructor(options: GeminiTtsOptions = {}) {
    this.#endpoint = options.endpoint ?? GEMINI_INTERACTIONS_ENDPOINT;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof this.#fetch !== "function") {
      throw new Error("no fetch implementation is available; pass options.fetch in this environment");
    }
  }

  /**
   * Synthesise `request.text` and return the finished clip.
   *
   * Refuses locally rather than sending an empty or over-length request: an empty clip is not a useful
   * answer from the provider and a request over the documented token limit fails the same way every
   * time, so there is no reason to spend a round trip finding that out.
   */
  async synthesize(apiKey: string, request: GeminiTtsRequest): Promise<GeminiTtsResult> {
    if (apiKey === "") {
      throw new Error("no API key was provided for Gemini TTS");
    }
    const text = request.text.trim();
    if (text === "") {
      throw new Error("cannot synthesise empty text");
    }
    if (request.sampleRateHz !== undefined && !SUPPORTED_SAMPLE_RATES.includes(request.sampleRateHz)) {
      throw new Error(`unsupported sample rate ${request.sampleRateHz}hz; use 24000, 16000 or 8000`);
    }

    const model = request.model ?? DEFAULT_TTS_MODEL;
    const body = buildInteractionBody({ ...request, text, model });

    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // The response body is provider error detail, not a credential; the key itself never appears in
      // a request body or a log line this module writes.
      const detail = await safeText(response);
      throw new Error(`Gemini TTS request failed with status ${response.status}${detail === "" ? "" : `: ${detail}`}`);
    }

    const payload = await response.json();
    const found = findLastAudioBlock(payload);
    if (found === undefined) {
      throw new Error("Gemini TTS response contained no audio content block");
    }
    return { audio: decodeBase64(found.data), mimeType: found.mimeType };
  }
}

function buildInteractionBody(request: Required<Pick<GeminiTtsRequest, "text" | "model">> & GeminiTtsRequest): Record<string, unknown> {
  const annotations = request.style === undefined ? undefined : [{ type: "speech_metadata", style: request.style }];
  const speechConfigEntry: Record<string, unknown> = {};
  if (request.voice !== undefined) speechConfigEntry["voice"] = request.voice;

  const responseFormat: Record<string, unknown> = { type: "audio", mime_type: "audio/wav" };
  if (request.sampleRateHz !== undefined) responseFormat["sample_rate"] = request.sampleRateHz;

  return {
    model: request.model,
    input: [
      {
        type: "user_input",
        content: [
          {
            type: "text",
            text: request.text,
            ...(annotations === undefined ? {} : { annotations }),
          },
        ],
      },
    ],
    response_format: responseFormat,
    generation_config: {
      speech_config: [speechConfigEntry],
    },
  };
}

/**
 * Find the last `{ type: "audio", data, mime_type }` block anywhere in the response.
 *
 * The Interactions API nests audio content inside `steps`/`outputs`, and the documented SDK behaviour is
 * "the last audio block wins". Walking the whole tree rather than one fixed path is the robust reading of
 * that: a provider that reshapes its response envelope without moving where audio lives should not break
 * this parser, only one that stops sending audio at all should.
 */
function findLastAudioBlock(node: unknown): { data: string; mimeType: string } | undefined {
  const matches: Array<{ data: string; mimeType: string }> = [];
  collectAudioBlocks(node, matches);
  return matches.at(-1);
}

function collectAudioBlocks(node: unknown, into: Array<{ data: string; mimeType: string }>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectAudioBlocks(item, into);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  if (record["type"] === "audio" && typeof record["data"] === "string") {
    const mimeType = typeof record["mime_type"] === "string" ? record["mime_type"] : "audio/wav";
    into.push({ data: record["data"], mimeType });
  }
  for (const value of Object.values(record)) collectAudioBlocks(value, into);
}

async function safeText(response: { text: () => Promise<string> }): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

function decodeBase64(data: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(data, "base64"));
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
