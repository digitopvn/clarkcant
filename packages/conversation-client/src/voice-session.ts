import type { VoiceState } from "@clarkcant/contracts";

/**
 * The browser's half of a live voice session.
 *
 * Responsibilities, and deliberately only these: capture microphone audio, get it to the node as
 * PCM16 at 16 kHz, play what comes back, and report state. It knows nothing about the provider —
 * no key, no model id, no protocol beyond this repository's own control frames — which is the
 * whole reason the node sits in the middle.
 *
 * ## Why the sample rate is requested from the browser rather than converted here
 *
 * Resampling 48 kHz to 16 kHz by hand means aliasing unless a filter is written, and a hand-rolled
 * filter is a worse resampler than the one already in the browser. Asking for an `AudioContext` at
 * 16 kHz makes the browser do it properly. The rate is checked afterwards rather than trusted,
 * because an engine is allowed to ignore the request; when that happens a linear resampler runs
 * as a fallback and the caller is told, so a quality problem is visible instead of mysterious.
 *
 * ## Why the worklet is built from a string
 *
 * An `AudioWorklet` needs a module URL. A separate file would have to be emitted by whatever
 * bundles this package, and `?url` imports are bundler-specific; a blob URL is not, works
 * unchanged under `vite preview` and under test, and keeps the processor beside the code that
 * loads it. The cost is that this one string is not type-checked, which is why it is kept as small
 * as it is: it accumulates frames and posts them.
 */

/** Provider-facing formats, mirrored from the adapter. The node re-checks them. */
const INPUT_SAMPLE_RATE_HZ = 16000;
const OUTPUT_SAMPLE_RATE_HZ = 24000;

export interface VoiceTranscriptUpdate {
  role: "user" | "assistant" | "system";
  text: string;
  final: boolean;
}

export interface VoiceSessionEvents {
  onState(state: VoiceState): void;
  onTranscript(update: VoiceTranscriptUpdate): void;
  /**
   * Called once per audio frame received and scheduled for playback.
   *
   * Reported because "audio came back" is otherwise invisible: a session that receives nothing
   * and a session that receives silence look identical on screen, and this is what tells them
   * apart. A surface can show it as a level or a count.
   */
  onAudioFrame?(received: number): void;
  /**
   * A sentence the agent could not answer.
   *
   * Deliberately not `onError`: the session is still open and the microphone still works, so this is
   * one sentence that did not get through rather than a session that failed. The next sentence is
   * already being listened for.
   */
  onAnswerFailed?(input: { code: string; message: string }): void;
  /**
   * Called once per capture frame handed to the socket.
   *
   * The counterpart of `onAudioFrame`, and needed for the same reason: "the microphone is open"
   * and "audio is leaving" are different claims, and only the second one makes a voice session
   * work. A surface can show it; a test asserts it.
   */
  onCaptureFrame?(sent: number): void;
  /**
   * The loudness of each frame, in each direction, from 0 to 1.
   *
   * A voice interface with no reaction to the voice is a picture of a microphone. This is what lets a
   * surface show two facts a caller otherwise cannot see: that the microphone is hearing something, and
   * that the model is speaking. Reported per frame in both directions, and never derived from the frame
   * counts, which only say that audio is moving.
   */
  onLevel?(update: { source: "microphone" | "agent"; level: number }): void;
  /** A refusal or transport failure, already worded for a person. */
  onError(message: string): void;
  /**
   * The node refused to open the session, with what it refused for.
   *
   * Separate from `onError` because a refusal is a thing the interface can act on rather than a failure: a node
   * with no credential for the live provider says which one it needs, and the person can supply it and try again.
   */
  onRefused?: (input: { code: string; message: string; reason?: string; credentialName?: string }) => void;
  onEnded(recordedMessages: number): void;
}

export interface StartVoiceSessionOptions {
  /** The node's base URL, as the client already uses it for HTTP. */
  nodeBaseUrl: string;
  token: string;
  /** Omitted when the user has not started a conversation yet; the node then records nothing. */
  conversationId?: string;
  events: VoiceSessionEvents;
  /** Injection points, so this module is testable without a browser. */
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  createAudioContext?: (sampleRate: number) => AudioContext;
  createSocket?: (url: string) => WebSocket;
  /** Reports that the requested rate was refused and audio is being resampled in the client. */
  onSampleRateFallback?: (actualHz: number) => void;
}

export interface VoiceSession {
  readonly state: VoiceState;
  /** Whether the transcript of this session will be stored by the node. */
  readonly willRecord: boolean;
  setMuted(muted: boolean): void;
  end(): Promise<void>;
}

/**
 * Open a voice session.
 *
 * Resolves once the node has accepted the session and capture has started, so a caller that gets a
 * session back knows audio is flowing. Anything that goes wrong before that rejects: a voice
 * button that appears to work while nothing is captured is the failure mode this avoids.
 */
export async function startVoiceSession(options: StartVoiceSessionOptions): Promise<VoiceSession> {
  const events = options.events;
  const mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
  const createAudioContext =
    options.createAudioContext ?? ((sampleRate: number): AudioContext => new AudioContext({ sampleRate }));
  const createSocket = options.createSocket ?? ((url: string): WebSocket => new WebSocket(url));

  let state: VoiceState = "connecting";
  let muted = false;
  let closed = false;

  const setState = (next: VoiceState): void => {
    if (state === next) return;
    state = next;
    events.onState(next);
  };

  const socket = createSocket(voiceSocketUrl(options.nodeBaseUrl));

  /**
   * The audio context is created here, synchronously, before anything is awaited.
   *
   * This is load-bearing rather than tidy. A browser ties the permission to start audio to the
   * user gesture that asked for it, and a context created after an `await` — after a socket
   * handshake, say — can be left suspended. A suspended context produces no audio and raises no
   * error, so the session looks connected, reports "listening", and captures nothing. That is
   * exactly what happened the first time this was run; see the session report.
   */
  const context = createAudioContext(INPUT_SAMPLE_RATE_HZ);
  const resumption = context.state === "running" ? Promise.resolve() : context.resume();

  let stream: MediaStream | undefined;
  let capture: AudioWorkletNode | undefined;
  let ended: (() => void) | undefined;
  /** Sending is gated on this, so nothing is transmitted before the node has accepted the session. */
  let capturing = false;

  /** Scheduled playback, kept so barge-in can silence the queue rather than talk over the user. */
  const playing = new Set<AudioBufferSourceNode>();
  let nextPlaybackAt = 0;
  let framesReceived = 0;

  const stopPlayback = (): void => {
    for (const source of playing) {
      try {
        source.stop();
      } catch {
        // A source that already finished cannot be stopped, which is not a problem worth
        // reporting: the outcome the caller wanted has already happened.
      }
    }
    playing.clear();
    nextPlaybackAt = 0;
  };

  const play = (pcm: Int16Array): void => {
    const buffer = context.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE_HZ);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) channel[index] = pcm[index]! / 32768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    // Scheduled back to back rather than started immediately, so chunks play as one stream
    // instead of overlapping into noise.
    const startAt = Math.max(context.currentTime, nextPlaybackAt);
    source.start(startAt);
    nextPlaybackAt = startAt + buffer.duration;
    playing.add(source);
    source.onended = () => playing.delete(source);
    framesReceived += 1;
    events.onAudioFrame?.(framesReceived);
    events.onLevel?.({ source: "agent", level: rmsLevel(pcm) });
  };

  const finish = async (recordedMessages: number): Promise<void> => {
    if (closed) return;
    closed = true;
    capturing = false;
    stopPlayback();
    capture?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    await context.close().catch(() => undefined);
    events.onEnded(recordedMessages);
    ended?.();
  };

  const opened = new Promise<void>((resolve, reject) => {
    const fail = (message: string): void => {
      events.onError(message);
      reject(new Error(message));
    };

    socket.addEventListener("open", () => {
      // The first frame is the credential. It is not in the URL: URLs land in access logs, proxy
      // logs and browser history.
      socket.send(
        JSON.stringify({
          type: "auth",
          token: options.token,
          ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        void audioFrom(event.data).then((pcm) => play(pcm));
        return;
      }

      const control = safeJson(event.data);
      switch (control?.["type"]) {
        case "ready": {
          willRecord = control["willRecord"] === true;
          setState("listening");
          void beginCapture().then(resolve).catch((cause: unknown) => {
            fail(cause instanceof Error ? cause.message : "the microphone could not be opened");
          });
          return;
        }
        case "denied": {
          // Reported with what the node refused for, because a refusal is something the interface can act on: a node
          // with no credential for the live provider says which one it needs, and the person can supply it and try
          // again. The session still fails, so the failure path below runs unchanged.
          events.onRefused?.({
            code: typeof control["code"] === "string" ? control["code"] : "VOICE_REFUSED",
            message: typeof control["message"] === "string" ? control["message"] : "node từ chối mở phiên thoại",
            ...(typeof control["reason"] === "string" ? { reason: control["reason"] } : {}),
            ...(typeof control["credentialName"] === "string" ? { credentialName: control["credentialName"] } : {}),
          });
          fail(typeof control["message"] === "string" ? control["message"] : "the node refused the voice session");
          socket.close();
          return;
        }
        case "state": {
          const reported = control["state"];
          if (typeof reported === "string") setState(reported as VoiceState);
          return;
        }
        case "transcript": {
          events.onTranscript({
            role: (control["role"] as VoiceTranscriptUpdate["role"]) ?? "user",
            text: typeof control["text"] === "string" ? control["text"] : "",
            final: control["final"] === true,
          });
          return;
        }
        case "ended": {
          void finish(typeof control["recordedMessages"] === "number" ? control["recordedMessages"] : 0);
          return;
        }
        case "error": {
          events.onAnswerFailed?.({
            code: typeof control["code"] === "string" ? control["code"] : "VOICE_ERROR",
            message: typeof control["message"] === "string" ? control["message"] : "node báo một lỗi không rõ",
          });
          return;
        }
        default:
          return;
      }
    });

    socket.addEventListener("close", () => {
      if (!closed) {
        setState("failed");
        void finish(0);
      }
    });

    socket.addEventListener("error", () => {
      if (!closed) events.onError("the voice connection to the node failed");
    });
  });

  let willRecord = false;

  async function beginCapture(): Promise<void> {
    stream = await mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Speech, not music: the browser's own filters are better than anything written here, and
        // echo cancellation is what stops the model's voice being captured as the user's.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    await resumption;
    // Asked again, because the first request may have been made before the node answered and a
    // context that stayed suspended would capture nothing while reporting that it was listening.
    if (context.state !== "running") await context.resume().catch(() => undefined);
    if (context.state !== "running") {
      throw new Error(
        "the browser would not start audio for this page, so the microphone cannot be captured; click the page and try again",
      );
    }
    if (context.sampleRate !== INPUT_SAMPLE_RATE_HZ) {
      options.onSampleRateFallback?.(context.sampleRate);
    }

    await context.audioWorklet.addModule(CAPTURE_WORKLET_URL);
    capture = new AudioWorkletNode(context, "cc-capture");
    let captureFrames = 0;
    capture.port.onmessage = (event: MessageEvent<{ frame: Float32Array }>) => {
      if (!capturing || muted || socket.readyState !== WebSocket.OPEN) return;
      const pcm = toPcm16(event.data.frame, context.sampleRate);
      if (pcm.length === 0) return;
      socket.send(pcm);
      captureFrames += 1;
      events.onCaptureFrame?.(captureFrames);
      events.onLevel?.({ source: "microphone", level: rmsLevel(event.data.frame) });
    };

    const sourceNode = context.createMediaStreamSource(stream);
    sourceNode.connect(capture);
    // A worklet connected to nothing may never be pulled, so it is routed through a silent gain
    // into the destination. The gain is zero: this is a pump, not an output.
    const silent = context.createGain();
    silent.gain.value = 0;
    capture.connect(silent).connect(context.destination);
    capturing = true;
  }

  await opened;

  return {
    get state() {
      return state;
    },
    get willRecord() {
      return willRecord;
    },
    setMuted(next: boolean): void {
      muted = next;
      // Both layers: the track stops producing and the sender stops sending. A mute that depends
      // on one of them is a mute that fails when that one is the broken one.
      for (const track of stream?.getTracks() ?? []) track.enabled = !next;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "mute", muted: next }));
    },
    async end(): Promise<void> {
      if (!closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "end" }));
      // Resolved by the node's acknowledgement, or by the socket closing. A wait with no timeout
      // would hang the UI on a node that has gone away.
      await Promise.race([
        new Promise<void>((resolve) => {
          ended = resolve;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      socket.close();
      await finish(0);
    },
  };
}

/**
 * `http://host:port` becomes `ws://host:port/voice`, and https becomes wss.
 *
 * Plain `ws` is allowed **only** to a loopback node, mirroring the node's own rule that a public
 * listener requires an explicit acknowledgement. The token travels in the first frame, so an
 * unencrypted socket to a remote host would put it on the wire in clear text; refusing here means
 * that mistake is caught where it is made rather than by a reviewer noticing the scheme.
 */
export function voiceSocketUrl(nodeBaseUrl: string): string {
  const url = new URL("/voice", nodeBaseUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
    return url.toString();
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(
      `a voice session to ${host} needs https: the credential travels on this socket, and an unencrypted one would expose it`,
    );
  }

  url.protocol = "ws:";
  return url.toString();
}

/**
 * Float samples to little-endian PCM16.
 *
 * Clamped rather than wrapped: an out-of-range sample that wraps becomes a loud click, and a click
 * in a speech stream is exactly the kind of artefact that makes a recogniser produce nonsense.
 */
/**
 * The loudness of one frame, from 0 to 1.
 *
 * Root mean square rather than peak: a peak meter jumps to full on a single click, so a table being set
down reads as loud as speech. Normalised by the sample format's full scale, then scaled up, because the
 * RMS of ordinary speech is around 0.05 — on a bar chart that is indistinguishable from silence, and a
 * waveform nobody can see is worse than no waveform.
 */
export function rmsLevel(frame: Float32Array | Int16Array): number {
  if (frame.length === 0) return 0;
  // Scaled once rather than per sample: an `instanceof` inside the loop is a megabyte of comparisons a
  // second at this frame rate.
  const scale = frame instanceof Int16Array ? 1 / 32768 : 1;
  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const sample = (frame[index] ?? 0) * scale;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / frame.length) * 4);
}

export function toPcm16(frame: Float32Array, actualSampleRateHz: number): Int16Array {
  const samples =
    actualSampleRateHz === INPUT_SAMPLE_RATE_HZ ? frame : resample(frame, actualSampleRateHz, INPUT_SAMPLE_RATE_HZ);
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    pcm[index] = Math.round(clamped * 32767);
  }
  return pcm;
}

/**
 * Linear interpolation, used only when the browser refuses the requested rate.
 *
 * Deliberately the simplest thing that works and honestly labelled: it has no anti-aliasing
 * filter, so it is not what should be used when the requested rate is honoured — which is why the
 * caller is told when this path is taken.
 */
function resample(frame: Float32Array, fromHz: number, toHz: number): Float32Array {
  const ratio = fromHz / toHz;
  const length = Math.floor(frame.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, frame.length - 1);
    const weight = position - lower;
    output[index] = (frame[lower] ?? 0) * (1 - weight) + (frame[upper] ?? 0) * weight;
  }
  return output;
}

/** A received frame is PCM16 at 24 kHz; the socket delivers it as bytes. */
async function audioFrom(data: unknown): Promise<Int16Array> {
  const bytes = await binaryFrom(data);
  // A copy rather than a view: the buffer length is not guaranteed to be even, and Int16Array
  // throws on a misaligned view rather than truncating.
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength - (bytes.byteLength % 2))));
}

async function binaryFrom(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());

  // The socket is opened without `binaryType`, so a browser may hand back a Blob; anything else is
  // a transport this code does not understand and is refused rather than guessed at.
  throw new Error("the voice socket delivered a frame this client cannot read");
}

/**
 * Where the capture processor lives.
 *
 * A same-origin module, resolved by the bundler from this file's own location. It is deliberately
 * not a blob URL: the app's policy is `script-src 'self'`, a blob is not `'self'`, and the first
 * attempt at this failed for exactly that reason. Loosening the policy to let a worklet be built
 * from a string would trade a real protection for a convenience.
 */
const CAPTURE_WORKLET_URL = new URL("./voice-capture-worklet.js", import.meta.url).href;

function safeJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
