/**
 * Gateway client.
 *
 * The only place the UI talks to the runtime. Kept tiny and explicit so the authorization
 * story is visible: every call carries the bearer token, and nothing ever sends a
 * principal, because the gateway derives the caller from the channel rather than the body.
 */

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

  capabilities(): Promise<{ capabilities: { ref: string; summary: string; usable: boolean; blockedReason?: string }[] }> {
    return this.#call("GET", "/capabilities");
  }
}
