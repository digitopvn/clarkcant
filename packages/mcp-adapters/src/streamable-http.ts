/**
 * MCP transport over streamable HTTP.
 *
 * The Model Context Protocol over HTTP, which is how a server that is not a local process is
 * reached. The two properties the stdio transport holds to apply here for the same reason: a
 * request always settles, and a session that has gone away fails everything in flight rather than
 * leaving a promise pending behind what looks like slowness.
 *
 * This is the protocol's "streamable HTTP" shape: one POST per message, an `Mcp-Session-Id` header
 * the server hands out at initialize and every later request echoes, and a reply that may arrive as
 * plain JSON or as a server-sent event stream. Both are read, because a server answering with SSE is
 * conforming and one answering with JSON is too - accepting only one of them is how a conforming
 * server ends up looking broken.
 *
 * Redirects are refused. A redirected MCP call would send the session id to whatever host the
 * redirect names, which is the whole reason `redirect: "error"` is set rather than left to default.
 */

import { type McpToolMetadata, mcpToolMetadataSchema, type McpTransport } from "./index.ts";
import type { ServerHandshake } from "./stdio.ts";

export interface StreamableHttpMcpTransportOptions {
  serverId: string;
  /** The MCP endpoint, not a base URL: the path is the server's to choose. */
  url: string;
  /** Extra headers, for a server behind an authorization scheme. */
  headers?: Record<string, string>;
  /** Per-request ceiling. Defaults to 15 seconds. */
  requestTimeoutMs?: number;
  /** Injected so a test can drive the transport without a network. */
  fetchImpl?: typeof fetch;
}

/** The version this client speaks. The server may answer with one it also supports. */
const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export class StreamableHttpMcpTransport implements McpTransport {
  readonly #options: StreamableHttpMcpTransportOptions;
  readonly #send: typeof fetch;
  #sessionId: string | undefined;
  #nextId = 1;
  #handshake: ServerHandshake | undefined;
  #closed = false;

  constructor(options: StreamableHttpMcpTransportOptions) {
    this.#options = options;
    this.#send = options.fetchImpl ?? fetch;
  }

  get serverId(): string {
    return this.#options.serverId;
  }

  get handshake(): ServerHandshake | undefined {
    return this.#handshake;
  }

  /** The session the server handed out, once it has. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  async start(): Promise<ServerHandshake> {
    if (this.#closed) throw new Error(`mcp server ${this.#options.serverId} was closed`);

    const result = (await this.#request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "clarkcant", version: "0.2.0" },
    })) as Partial<ServerHandshake>;

    if (typeof result?.protocolVersion !== "string") {
      throw new Error(`mcp server ${this.#options.serverId} answered initialize without a protocolVersion`);
    }

    this.#handshake = {
      protocolVersion: result.protocolVersion,
      serverInfo: result.serverInfo ?? { name: this.#options.serverId, version: "unknown" },
      capabilities: (result.capabilities as Record<string, unknown>) ?? {},
    };

    // A notification, not a request: the protocol has no reply for it, so waiting would hang.
    await this.#notify("notifications/initialized", {});
    return this.#handshake;
  }

  async listTools(): Promise<McpToolMetadata[]> {
    const result = (await this.#request("tools/list", {})) as { tools?: unknown };
    const raw = Array.isArray(result?.tools) ? result.tools : [];

    // Each tool is validated individually so one malformed entry does not discard the rest, and the
    // rejection says which one it was.
    const tools: McpToolMetadata[] = [];
    for (const entry of raw) {
      const parsed = mcpToolMetadataSchema.safeParse(entry);
      if (!parsed.success) {
        const name =
          entry !== null && typeof entry === "object" && "name" in entry
            ? String((entry as { name: unknown }).name)
            : "(unnamed)";
        throw new Error(
          `mcp server ${this.#options.serverId} returned tool ${name} that does not match the protocol shape: ${parsed.error.issues[0]?.message ?? "unknown problem"}`,
        );
      }
      tools.push(parsed.data);
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string }> {
    const result = (await this.#request("tools/call", { name, arguments: args })) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };

    const text = (result?.content ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");

    if (result?.isError === true) {
      // A tool that reports failure has still answered. The caller gets the server's own words
      // rather than a generic error, because those words are the diagnosis.
      throw new Error(`mcp tool ${name} reported an error: ${text || "no detail given"}`);
    }

    return { content: text };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#sessionId = undefined;
  }

  #headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.#sessionId === undefined ? {} : { "mcp-session-id": this.#sessionId }),
      ...(this.#options.headers ?? {}),
    };
  }

  async #notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.#post({ jsonrpc: "2.0", method, params }, false);
  }

  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const message = (await this.#post({ jsonrpc: "2.0", id, method, params }, true)) as JsonRpcMessage | undefined;

    if (message === undefined) {
      throw new Error(`mcp server ${this.#options.serverId} answered ${method} with no message`);
    }
    if (message.error !== undefined) {
      throw new Error(
        `mcp server ${this.#options.serverId} answered with an error: ${message.error.message ?? "no detail given"}`,
      );
    }
    return message.result;
  }

  /**
   * One POST, with a ceiling.
   *
   * The timeout settles the request rather than leaving it pending: a stalled server must not turn
   * into an application that appears to be thinking.
   */
  async #post(payload: Record<string, unknown>, expectReply: boolean): Promise<JsonRpcMessage | undefined> {
    if (this.#closed) throw new Error(`mcp server ${this.#options.serverId} was closed`);
    const timeoutMs = this.#options.requestTimeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#send(this.#options.url, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
        // Not "follow": a redirect would send the session id to whatever host it names.
        redirect: "error",
      });

      const session = response.headers.get("mcp-session-id");
      if (session !== null && session !== "") this.#sessionId = session;

      if (!response.ok) {
        throw new Error(`mcp server ${this.#options.serverId} answered ${String(response.status)}`);
      }
      if (!expectReply) return undefined;

      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      if (contentType.includes("text/event-stream")) {
        const message = firstEventMessage(body);
        if (message === undefined) {
          throw new Error(`mcp server ${this.#options.serverId} sent an event stream with no message in it`);
        }
        return message;
      }

      try {
        return JSON.parse(body) as JsonRpcMessage;
      } catch {
        throw new Error(`mcp server ${this.#options.serverId} answered with a body that is not JSON`);
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        // The abort is attached rather than replaced: the timeout is the symptom, and an error with
        // no cause is the kind nobody can act on.
        throw new Error(
          `mcp server ${this.#options.serverId} did not answer within ${String(timeoutMs)} ms`,
          { cause },
        );
      }
      throw cause instanceof Error ? cause : new Error(String(cause));
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The first JSON-RPC message in a server-sent event stream.
 *
 * The protocol allows a stream to carry progress events before the answer, and a server may hold the
 * connection open after it. Only `data:` lines are messages; everything else in the stream is
 * framing, and a line that is not JSON is skipped rather than treated as fatal.
 */
function firstEventMessage(body: string): JsonRpcMessage | undefined {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "") continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcMessage;
      if (parsed.id !== undefined || parsed.error !== undefined) return parsed;
    } catch {
      // Not a message. The stream's framing is not this function's business.
    }
  }
  return undefined;
}

/** Start a streamable-HTTP server and complete its handshake. */
export async function connectStreamableHttp(
  options: StreamableHttpMcpTransportOptions,
): Promise<StreamableHttpMcpTransport> {
  const transport = new StreamableHttpMcpTransport(options);
  await transport.start();
  return transport;
}

export const MCP_HTTP_TRANSPORT_STATUS = "implemented-streamable-http";
