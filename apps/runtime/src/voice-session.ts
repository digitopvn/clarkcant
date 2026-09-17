import type { IncomingMessage, Server } from "node:http";

import { type ConversationId, type Instant, nowInstant } from "@clarkcant/contracts";
import { recordVoiceTranscript } from "@clarkcant/core";
import { GeminiLiveAdapter, type VoiceProviderAdapter } from "@clarkcant/voice-adapters";
import { type RawData, WebSocketServer, type WebSocket } from "ws";

import { tokenMatches } from "./gateway.ts";
import type { NodeServices } from "./services.ts";

/**
 * The voice socket.
 *
 * ## Why the node is in the path at all
 *
 * The browser must never hold a provider credential. A node-side proxy is what makes that true
 * without an ephemeral-token flow: the key lives in this process, the browser sends audio and
 * receives audio, and no credential of any kind reaches the page. That property is the reason
 * this file exists, and it is asserted by a test rather than assumed.
 *
 * ## The wire, browser side
 *
 * Text frames are JSON control messages; binary frames are always raw PCM16 audio.
 *
 * Client to node:
 *   `{ type: "auth", token, conversationId? }` — must be the first frame, see below
 *   `{ type: "end" }`                          — end the session politely
 *   binary                                     — PCM16, 16 kHz, mono
 *
 * Node to client:
 *   `{ type: "ready", sessionId, inputSampleRateHz, outputSampleRateHz, willRecord }`
 *   `{ type: "denied", code, message, heldBy? }`
 *   `{ type: "state", state }`
 *   `{ type: "transcript", role, text, final }`
 *   `{ type: "ended", recordedMessages }`
 *   binary                                     — PCM16, 24 kHz, mono
 *
 * ## Why the token is not in the URL
 *
 * A browser `WebSocket` cannot set an `Authorization` header, so the credential has to travel
 * some other way, and the query string is the wrong answer: URLs are written to access logs, to
 * proxy logs, and to browser history. So the socket is accepted unauthenticated and **the first
 * frame must be the auth message**. Any binary frame that arrives before authentication is
 * refused and the socket is closed, because audio arriving from an unauthenticated peer is
 * either a bug or an attempt, and neither deserves a provider session.
 *
 * ## One session per node
 *
 * A second request is refused, naming the tab that holds the session, rather than being queued or
 * sharing. Two live sessions on one node would double the provider quota being spent with no way
 * for the operator to see it, and "who has the microphone" is a question the media-focus contract
 * already answers by naming the holder.
 */

export interface VoiceGatewayOptions {
  server: Server;
  services: NodeServices;
  /**
   * Reads the provider credential.
   *
   * Injected rather than read here, so this module never touches the environment and a test can
   * supply one without a real key existing.
   */
  credential: () => string | undefined;
  /** Model id, without the `models/` prefix. */
  model?: string;
  /** Injected by tests so the transport can be exercised without a provider. */
  createAdapter?: () => VoiceProviderAdapter;
  now?: () => Instant;
  /** Path the socket is served on. */
  path?: string;
}

export interface VoiceGateway {
  /** How many sessions are live right now. */
  activeSessionCount(): number;
  /** The holder of the session, for a caller that needs to report it. */
  activeSessionHolder(): string | undefined;
  close(): Promise<void>;
}

/** Close codes. 1008 is a policy refusal; 1013 is "try again when something changes". */
const CLOSE_POLICY = 1008;
const CLOSE_TRY_LATER = 1013;

export function attachVoiceGateway(options: VoiceGatewayOptions): VoiceGateway {
  const path = options.path ?? "/voice";
  const now = options.now ?? nowInstant;
  const createAdapter = options.createAdapter ?? ((): VoiceProviderAdapter => new GeminiLiveAdapter(defaultsFrom(options)));

  const wss = new WebSocketServer({ noServer: true });
  let active: { sessionId: string; holder: string } | undefined;
  let sessionCounter = 0;

  options.server.on("upgrade", (request, socket, head) => {
    // Paths this gateway does not own are left alone rather than swallowed, so adding another
    // socket later does not mean editing this branch.
    if (new URL(request.url ?? "/", "http://localhost").pathname !== path) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      void serve(ws, request);
    });
  });

  async function serve(ws: WebSocket, request: IncomingMessage): Promise<void> {
    sessionCounter += 1;
    const sessionId = `voice-${sessionCounter}`;
    const holder = `${request.socket.remoteAddress ?? "unknown"}#${sessionId}`;

    let authenticated = false;
    let conversationId: ConversationId | undefined;
    let adapter: VoiceProviderAdapter | undefined;
    let userText = "";
    let assistantText = "";
    let recorded = false;

    const send = (payload: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    const deny = (code: string, message: string, extra: Record<string, unknown> = {}, closeCode = CLOSE_POLICY): void => {
      send({ type: "denied", code, message, ...extra });
      ws.close(closeCode, code);
    };

    /**
     * Record the session once.
     *
     * Guarded by a flag rather than by the socket's state, because both a polite end and a dropped
     * connection can reach here and a session recorded twice is worse than one not recorded.
     */
    const record = (): number => {
      if (recorded || !authenticated) return 0;
      recorded = true;
      if (conversationId === undefined) return 0;
      if (userText.trim() === "" && assistantText.trim() === "") return 0;

      const messages = recordVoiceTranscript(options.services.conductor, {
        conversationId,
        userText,
        assistantText,
        at: now(),
      });
      return messages.length;
    };

    const finish = async (): Promise<void> => {
      const recordedMessages = record();
      // Only the socket that owns the slot may release it. A refused second socket closes too,
      // and clearing the slot unconditionally here would end a session that is still running —
      // which is how this was found.
      if (active?.sessionId === sessionId) active = undefined;
      await adapter?.disconnect().catch(() => undefined);
      send({ type: "ended", recordedMessages });
    };

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!authenticated) {
        if (isBinary) {
          // Audio before authentication never reaches the provider.
          deny("UNAUTHENTICATED", "the first frame must be an auth message, not audio");
          return;
        }
        void authenticate(data);
        return;
      }

      if (isBinary) {
        adapter?.sendAudio(new Uint8Array(data as Buffer));
        return;
      }

      const control = safeJson(data.toString());
      if (control?.["type"] === "end") {
        void finish().then(() => ws.close(1000, "ended by client"));
        return;
      }
      if (control?.["type"] === "mute") {
        // Mute is applied at the adapter as well as at the client's track. Two layers on purpose:
        // a mute that depends on one is a mute that fails silently when that one is broken.
        adapter?.setMuted(control["muted"] === true);
      }
    });

    async function authenticate(data: RawData): Promise<void> {
      const message = safeJson(data.toString());
      if (message?.["type"] !== "auth") {
        deny("UNAUTHENTICATED", "the first frame must be an auth message");
        return;
      }

      const presented = message["token"];
      if (typeof presented !== "string" || !tokenMatches(options.services.runtime.identity.localToken, presented)) {
        // Identical for a missing and a wrong token, as the HTTP gate is: distinguishing them
        // tells an attacker which half to work on.
        deny("UNAUTHENTICATED", "a valid bearer token is required to open a voice session");
        return;
      }

      if (active !== undefined) {
        deny(
          "VOICE_SESSION_BUSY",
          `this node already has a live voice session (${active.holder}); end it before starting another`,
          { heldBy: active.holder },
          CLOSE_TRY_LATER,
        );
        return;
      }

      const credential = options.credential();
      if (credential === undefined || credential === "") {
        deny("VOICE_NOT_CONFIGURED", "this node has no credential for the live voice provider", {}, CLOSE_TRY_LATER);
        return;
      }

      const requested = message["conversationId"];
      conversationId = typeof requested === "string" && requested !== "" ? (requested as ConversationId) : undefined;

      authenticated = true;
      active = { sessionId, holder };
      adapter = createAdapter();

      adapter.onStateChange((state) => send({ type: "state", state }));
      adapter.onAudio((pcm16) => {
        // Audio goes back as a binary frame, not as JSON: base64 inside a control message would
        // inflate every chunk by a third and put a string conversion on the latency path.
        if (ws.readyState === ws.OPEN) ws.send(pcm16, { binary: true });
      });
      adapter.onTranscript((fragment) => {
        if (fragment.role === "user") userText += fragment.text;
        else if (fragment.role === "assistant") assistantText += fragment.text;
        send({ type: "transcript", role: fragment.role, text: fragment.text, final: fragment.isFinal });
      });

      try {
        // The adapter asks for the credential rather than being handed one at construction, so
        // the window in which it exists is the length of this call.
        await adapter.connect({ sessionId, tokenProvider: async () => credential });
      } catch (cause) {
        authenticated = false;
        active = undefined;
        deny(
          "VOICE_CONNECT_FAILED",
          cause instanceof Error ? cause.message : "the live voice session could not be opened",
          {},
          CLOSE_TRY_LATER,
        );
        return;
      }

      send({
        type: "ready",
        sessionId,
        inputSampleRateHz: 16000,
        outputSampleRateHz: 24000,
        // Reported rather than assumed, so a client that opened voice without a conversation knows
        // the transcript will not be stored instead of finding out later.
        willRecord: conversationId !== undefined,
      });
    }

    ws.on("close", () => {
      void finish();
    });

    ws.on("error", () => {
      void finish();
    });
  }

  return {
    activeSessionCount: () => (active === undefined ? 0 : 1),
    activeSessionHolder: () => active?.holder,
    close: async () => {
      active = undefined;
      for (const client of wss.clients) client.close(1001, "the node is shutting down");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** Options for the real adapter, resolved once so every session is configured the same way. */
function defaultsFrom(options: VoiceGatewayOptions): ConstructorParameters<typeof GeminiLiveAdapter>[0] {
  return options.model === undefined ? {} : { model: options.model };
}

function safeJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
