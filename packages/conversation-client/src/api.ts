/**
 * Gateway client.
 *
 * The only place the UI talks to the runtime. Kept tiny and explicit so the authorization
 * story is visible: every call carries the bearer token, and nothing ever sends a
 * principal, because the gateway derives the caller from the channel rather than the body.
 */

import {
  type StartVoiceSessionOptions,
  type VoiceSession,
  type VoiceSessionEvents,
  startVoiceSession,
} from "./voice-session.ts";

export interface GatewayClientOptions {
  baseUrl: string;
  token: string;
  /** Injected so tests and the E2E harness can substitute a transport. */
  fetchImpl?: typeof fetch;
}
export interface TimelineMessage {
  messageId: string;
  role: "user" | "assistant" | "system" | "tool";
  blocks: Record<string, unknown>[];
  createdAt: string;
}

export interface TimelineInstance {
  instanceId: string;
  definitionId: string;
  definitionVersion: string;
  lifecycle: string;
  revision: number;
  props: Record<string, unknown>;
}

export interface Timeline {
  conversationId: string;
  cursor: number;
  messages: TimelineMessage[];
  pins: { pinId: string; instanceId: string; displayMode: string; position: number; refreshPolicy: string }[];
  instances: TimelineInstance[];
  metadata: { messageCount: number; taskCount: number; updatedAt: string };
  activeTaskIds: string[];
}

export interface ResolvedDataset {
  datasetId: string;
  rowCount: number;
  freshness: "live" | "cached" | "sample" | "unknown";
  updatedAt: string;
  document: { rows: Record<string, unknown>[] };
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
  }
}

export class GatewayClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Open a live voice session against this node.
   *
   * The token stays here rather than being handed to the surface. That is the point: the voice
   * socket authenticates in its first frame, and the only component that already holds the
   * credential is this one. A surface that had to ask for it would put the token into a prop,
   * and props end up in devtools, snapshots and logs.
   *
   * The injection points exist so this can be exercised without a microphone or an audio device.
   */
  openVoiceSession(
    options: {
      conversationId?: string;
      events: VoiceSessionEvents;
    } & Pick<
      StartVoiceSessionOptions,
      "mediaDevices" | "createAudioContext" | "createSocket" | "onSampleRateFallback"
    >,
  ): Promise<VoiceSession> {
    return startVoiceSession({ ...options, nodeBaseUrl: this.#baseUrl, token: this.#token });
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let parsed: unknown = {};
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GatewayError(
          response.status,
          "MALFORMED_RESPONSE",
          `the gateway returned a body that is not JSON (status ${response.status})`,
        );
      }
    }

    if (!response.ok) {
      const record = parsed as { code?: string; message?: string };
      throw new GatewayError(response.status, record.code ?? "UNKNOWN", record.message ?? "the request failed");
    }
    return parsed as T;
  }

  health(): Promise<{ status: string; runtime: { node: string; platform: string; arch: string } }> {
    return this.#call("GET", "/health");
  }

  /**
   * This node's identity and what it is configured to run on.
   *
   * `model` is null when the node has none, which the settings surface shows as a state rather
   * than as an absence — a node without a model is a perfectly good node, it just answers from
   * scripts and capabilities instead of calling a provider.
   */
  node(): Promise<{
    nodeId: string;
    label: string;
    createdAt: string;
    model: { provider: string; id: string; maxWallClockMs: number; maxTokens: number } | null;
  }> {
    return this.#call("GET", "/node");
  }

  createConversation(title?: string): Promise<{ conversationId: string }> {
    return this.#call("POST", "/conversations", title === undefined ? {} : { title });
  }

  listConversations(): Promise<{ conversations: { conversationId: string }[] }> {
    return this.#call("GET", "/conversations");
  }

  sendMessage(conversationId: string, text: string): Promise<{ resolution: string; taskId: string | null; timeline: Timeline }> {
    return this.#call("POST", `/conversations/${conversationId}/messages`, { text });
  }

  timeline(conversationId: string, after = 0): Promise<Timeline> {
    return this.#call("GET", `/conversations/${conversationId}/timeline?after=${after}`);
  }

  dataset(datasetId: string): Promise<ResolvedDataset> {
    return this.#call("GET", `/datasets/${datasetId}`);
  }

  pin(conversationId: string, instanceId: string, displayMode: "compact" | "expanded" = "compact"): Promise<{ pinId: string; timeline: Timeline }> {
    return this.#call("POST", `/conversations/${conversationId}/pins`, { instanceId, displayMode });
  }

  unpin(conversationId: string, pinId: string): Promise<{ removed: boolean; timeline: Timeline }> {
    return this.#call("DELETE", `/conversations/${conversationId}/pins/${pinId}`);
  }

  capabilities(): Promise<{ capabilities: { ref: string; summary: string; usable: boolean; blockedReason?: string }[] }> {    return this.#call("GET", "/capabilities");
  }
}
