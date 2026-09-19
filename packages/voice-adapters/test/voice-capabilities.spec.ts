import { describe, expect, it } from "vitest";
import { voiceCapabilitiesSchema } from "@clarkcant/contracts";

import { GEMINI_PREBUILT_VOICES, GeminiLiveAdapter, type LiveSocket } from "../src/gemini-live.ts";
import { buildSetupMessage } from "../src/protocol.ts";

/**
 * Voice selection, and the capability report that decides whether the surface offers it.
 *
 * Two claims, and they are the two halves of the same mistake. The provider must put the chosen voice into
 * the session it opens, and it must tell the surface what it can actually do — because a picker hard-coded
 * with one provider's voice names would offer them to a provider that has never heard of them, and the
 * failure would arrive as a session that connects and then says nothing.
 */

/** A socket that records what was sent, so the setup message can be read back. */
class FakeSocket implements LiveSocket {
  readonly sent: string[] = [];
  #onOpen: (() => void) | undefined;
  send(payload: string): void {
    this.sent.push(payload);
  }
  close(): void {}
  onOpen(listener: () => void): void {
    this.#onOpen = listener;
  }
  onMessage(): void {}
  onClose(): void {}
  onError(): void {}
  open(): void {
    this.#onOpen?.();
  }
}

/**
 * Connect far enough to read the setup message.
 *
 * The socket is created asynchronously — after the credential is resolved — so the test waits for the factory to
 * be called rather than assuming it already has been. Reading an empty `sent` array because the test got there
 * first is the race that made the first version of this file fail intermittently.
 */
async function setupFor(options: { voiceName?: string; model?: string } = {}): Promise<Record<string, unknown>> {
  let socket: FakeSocket | undefined;
  let announce: () => void = () => {};
  const created = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const adapter = new GeminiLiveAdapter({
    ...options,
    createSocket: () => {
      socket = new FakeSocket();
      announce();
      return socket;
    },
  });
  void adapter.connect({ sessionId: "s1", tokenProvider: async () => "token" }).catch(() => undefined);
  await created;
  if (socket === undefined) throw new Error("the adapter never created a socket");
  socket.open();
  return JSON.parse(socket.sent[0] ?? "{}") as Record<string, unknown>;
}

describe("the chosen voice reaches the session the provider opens", () => {
  it("names it in the speech config, in the shape the provider documents", async () => {
    const setup = await setupFor({ voiceName: "Kore" });
    expect(setup).toMatchObject({
      setup: {
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
        },
      },
    });
  });

  it("sends no speech config at all when nobody chose a voice", async () => {
    /*
     * The message is what it always was, rather than one naming a default this application picked. A default
     * written here would be a voice choice the user never made, and it would silently override the provider's
     * own default.
     */
    const setup = (await setupFor()) as { setup?: { generationConfig?: Record<string, unknown> } };
    expect(setup.setup?.generationConfig).toEqual({ responseModalities: ["AUDIO"] });
    expect(JSON.stringify(setup)).not.toContain("speechConfig");
  });

  it("does not validate the name itself, so the provider stays the authority", () => {
    // A name this module does not know is passed through. Refusing it here would mean a second, stale copy of
    // the provider's voice list living in the protocol builder.
    const built = buildSetupMessage({ voiceName: "NotARealVoice" });
    expect(JSON.stringify(built)).toContain("NotARealVoice");
  });

  it("leaves the model and the audio modality exactly as they were", () => {
    const built = buildSetupMessage({ model: "gemini-live-2.5-flash-preview", voiceName: "Puck" }) as {
      setup?: { model?: string; generationConfig?: Record<string, unknown> };
    };
    expect(built.setup?.model).toBe("models/gemini-live-2.5-flash-preview");
    expect(built.setup?.generationConfig).toMatchObject({ responseModalities: ["AUDIO"] });
  });
});

describe("the provider reports what it can do", () => {
  it("answers a shape the contract accepts", () => {
    const adapter = new GeminiLiveAdapter();
    // Parsed rather than merely read, so a field added here without being declared fails in this test.
    const parsed = voiceCapabilitiesSchema.safeParse(adapter.capabilities);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("says it supports selecting a voice, and offers the provider's own list", () => {
    const { capabilities } = new GeminiLiveAdapter();
    expect(capabilities.provider).toBe("gemini-live");
    expect(capabilities.supportsVoiceSelection).toBe(true);
    expect(capabilities.voices.length).toBeGreaterThan(0);
    // Every option has an id and a label, which is what a surface needs to render one.
    for (const voice of capabilities.voices) {
      expect(voice.id.length).toBeGreaterThan(0);
      expect(voice.label.length).toBeGreaterThan(0);
    }
    expect(capabilities.voices.map((voice) => voice.id)).toEqual(
      GEMINI_PREBUILT_VOICES.map((voice) => voice.id),
    );
  });

  it("says it cannot preview, and gives the reason rather than leaving it to be discovered", () => {
    /*
     * Honest rather than aspirational. A spoken sample would open a second live session, and this adapter has
     * no path that produces one sentence without the full interactive setup — so the surface shows a disabled
     * control with this note instead of a button whose action does not exist.
     */
    const { capabilities } = new GeminiLiveAdapter();
    expect(capabilities.supportsPreview).toBe(false);
    expect(capabilities.note ?? "").not.toBe("");
  });

  it("offers no voice description it did not get from the provider", () => {
    // An invented description would read as fact on a settings screen.
    for (const voice of GEMINI_PREBUILT_VOICES) {
      expect(voice.description).toBeUndefined();
      expect(voice.locale).toBeUndefined();
    }
  });

  it("carries no credential, however it is constructed", () => {
    const adapter = new GeminiLiveAdapter({ createSocket: () => new FakeSocket() });
    const serialised = JSON.stringify(adapter.capabilities);
    expect(serialised).not.toContain("token");
    expect(serialised).not.toContain("key");
    expect(serialised).not.toContain("Bearer");
  });
});
