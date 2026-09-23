import { describe, expect, it } from "vitest";

import { startVoiceSession } from "../src/voice-session.ts";

/**
 * T68: mute and end stop capture on the real transport.
 *
 * The client is the side that holds the microphone, so this is where "mute" and "end" either stop the track or do
 * not. The other two halves are asserted where they belong: the node's half - the frames arriving and the adapter
 * being told - in `apps/runtime/test/voice-gateway.spec.ts`, and the same path against a real socket in
 * `apps/web/e2e/voice.spec.ts`. What was missing was this one, and it is the one that fails if the client keeps
 * sending audio while muted or leaves the microphone open after the session ends.
 */

/** The session reads this off the global, so it has to exist before the module is exercised. */
(globalThis as { WebSocket?: unknown }).WebSocket = { OPEN: 1 };

/** The node's capture worklet is a real class in a browser; here it only has to accept a port and connect. */
(globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = class {
  port = { onmessage: null as unknown };
  connect(): { connect: (destination: unknown) => void } {
    return { connect: () => undefined };
  }
  disconnect(): void {
    return undefined;
  }
};

interface Frame {
  readonly type?: string;
  readonly muted?: boolean;
}

/**
 * A socket, an audio context and a microphone, each reduced to what the session touches.
 *
 * The socket opens as soon as somebody listens for it and answers the frames this test is about, which is what a
 * node does - and it means `end` does not sit through its two-second fallback waiting for an acknowledgement that
 * a stub never sends.
 */
function harness(): {
  sent: Frame[];
  tracks: { enabled: boolean; stopped: number; stop(): void }[];
  socket: unknown;
  context: unknown;
  contextClosed: () => boolean;
} {
  const sent: Frame[] = [];
  const tracks = [
    {
      enabled: true,
      stopped: 0,
      stop(): void {
        this.stopped += 1;
      },
    },
  ];
  let closed = false;
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const emit = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };

  const socket = {
    readyState: 1,
    send(payload: string | ArrayBuffer): void {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload) as Frame;
      sent.push(frame);
      if (frame.type === "end") {
        emit("message", { data: JSON.stringify({ type: "ended", recordedMessages: 0 }) });
      }
    },
    close(): void {
      socket.readyState = 3;
    },
    addEventListener(type: string, listener: (event: unknown) => void): void {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
      if (type === "open") {
        // Opening sends the credential, which is what a real socket does when the handshake completes.
        listener({});
      }
      if (type === "message") {
        // Answered on a microtask rather than here: the session registers this listener after the open one, so a
        // frame sent during registration would arrive before anybody was listening for it - which is exactly what
        // made the first version of this harness hang.
        queueMicrotask(() => {
          emit("message", { data: JSON.stringify({ type: "ready", willRecord: false }) });
        });
      }
    },
  };

  const context = {
    state: "running",
    sampleRate: 16000,
    currentTime: 0,
    destination: {},
    resume: () => Promise.resolve(),
    close: async (): Promise<void> => {
      closed = true;
    },
    createMediaStreamSource: () => ({ connect: () => undefined }),
    createGain: () => ({ gain: { value: 0 }, connect: () => ({ connect: () => undefined }) }),
    createBuffer: () => ({ duration: 0, getChannelData: () => new Float32Array(0) }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      onended: null,
    }),
    audioWorklet: { addModule: () => Promise.resolve() },
  };

  return { sent, tracks, socket, context, contextClosed: () => closed };
}

async function open(h: ReturnType<typeof harness>): Promise<Awaited<ReturnType<typeof startVoiceSession>>> {
  return startVoiceSession({
    nodeBaseUrl: "http://127.0.0.1:9",
    token: "a-token",
    // The four the session calls unconditionally. The optional ones are left out on purpose: a session must not
    // depend on a surface that wants to hear about every frame.
    events: {
      onState: () => undefined,
      onTranscript: () => undefined,
      onError: () => undefined,
      onEnded: () => undefined,
    },
    createSocket: () => h.socket as unknown as WebSocket,
    createAudioContext: () => h.context as unknown as AudioContext,
    mediaDevices: {
      getUserMedia: () => Promise.resolve({ getTracks: () => h.tracks } as unknown as MediaStream),
    },
  });
}

describe("mute and end on the transport", () => {
  it("mute stops the track producing and tells the node", async () => {
    const h = harness();
    const session = await open(h);

    session.setMuted(true);
    expect(h.tracks[0]?.enabled).toBe(false);
    expect(h.sent.some((frame) => frame.type === "mute" && frame.muted === true)).toBe(true);

    // And it is a mute rather than a stop: the microphone is usable again without a new session.
    session.setMuted(false);
    expect(h.tracks[0]?.enabled).toBe(true);
    expect(h.sent.some((frame) => frame.type === "mute" && frame.muted === false)).toBe(true);
  });

  it("end tells the node, stops every capture track, and closes the audio context", async () => {
    const h = harness();
    const session = await open(h);
    expect(h.tracks[0]?.stopped).toBe(0);

    await session.end();

    expect(h.sent.some((frame) => frame.type === "end")).toBe(true);
    expect(h.tracks[0]?.stopped).toBe(1);
    expect(h.contextClosed()).toBe(true);
  });

  it("a muted session still ends, rather than being left open because it was silent", async () => {
    const h = harness();
    const session = await open(h);

    session.setMuted(true);
    await session.end();

    expect(h.tracks[0]?.stopped).toBe(1);
    expect(h.contextClosed()).toBe(true);
  });
});
