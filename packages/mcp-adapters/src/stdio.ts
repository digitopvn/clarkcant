/**
 * MCP transport over stdio.
 *
 * The Model Context Protocol over a child process's standard streams, which is how a locally
 * installed server is reached. Nothing here interprets what a server says beyond the JSON-RPC
 * envelope: a tool is normalised by `normalizeMcpTool`, and the caller decides what it is
 * allowed to do.
 *
 * Two properties are worth stating because they are the ones that make this usable rather than
 * merely working:
 *
 *   - **A request always settles.** A server that never answers, or that dies mid-request, leaves
 *     no promise pending. A hang that looks like slowness is the failure mode this avoids.
 *   - **A crash rejects everything in flight.** When the process exits, every outstanding request
 *     fails with the exit status and the tail of stderr, because "the server went away" is the
 *     most useful thing a caller can be told.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { type McpToolMetadata, mcpToolMetadataSchema, type McpTransport } from "./index.ts";

export interface StdioMcpTransportOptions {
  serverId: string;
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  /** Per-request ceiling. Defaults to 15 seconds. */
  requestTimeoutMs?: number;
}

export interface ServerHandshake {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  /** What the server says it can do, passed through unverified. */
  capabilities: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How much stderr is kept for diagnostics. Enough to explain a crash, not a log sink. */
const STDERR_TAIL_BYTES = 4000;

export class StdioMcpTransport implements McpTransport {
  readonly #options: StdioMcpTransportOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #stderr = "";
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #handshake: ServerHandshake | undefined;
  #closed = false;

  constructor(options: StdioMcpTransportOptions) {
    this.#options = options;
  }

  get serverId(): string {
    return this.#options.serverId;
  }

  /** The most recent stderr from the server, for when something goes wrong. */
  get stderrTail(): string {
    return this.#stderr;
  }

  get handshake(): ServerHandshake | undefined {
    return this.#handshake;
  }

  /**
   * Start the server and complete the MCP handshake.
   *
   * Separate from the constructor because starting a process is an action with a result, and a
   * constructor cannot report that the server refused to speak the protocol.
   */
  async start(): Promise<ServerHandshake> {
    if (this.#child) throw new Error(`mcp server ${this.#options.serverId} is already started`);

    const child = spawn(this.#options.command, [...(this.#options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.#options.env ?? {}) },
    });
    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-STDERR_TAIL_BYTES);
    });

    // A dead server cannot answer, so nothing may stay pending.
    child.on("exit", (code, signal) => this.#failAll(this.#exitReason(code, signal)));
    child.on("error", (error) => this.#failAll(new Error(`mcp server failed to start: ${error.message}`)));

    const result = (await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "clarkcant", version: "0.2.0" },
    })) as Partial<ServerHandshake>;

    if (typeof result?.protocolVersion !== "string") {
      throw new Error(
        `mcp server ${this.#options.serverId} answered initialize without a protocolVersion`,
      );
    }

    this.#handshake = {
      protocolVersion: result.protocolVersion,
      serverInfo: result.serverInfo ?? { name: this.#options.serverId, version: "unknown" },
      capabilities: (result.capabilities as Record<string, unknown>) ?? {},
    };

    // A notification, not a request: the protocol has no reply for it, so waiting would hang.
    this.#notify("notifications/initialized", {});
    return this.#handshake;
  }

  async listTools(): Promise<McpToolMetadata[]> {
    const result = (await this.#request("tools/list", {})) as { tools?: unknown };
    const raw = Array.isArray(result?.tools) ? result.tools : [];

    // Each tool is validated individually so one malformed entry does not discard the rest,
    // and the rejection says which one it was.
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
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    this.#failAll(new Error(`mcp server ${this.#options.serverId} was closed`));
    child.kill();
    // Give the process a moment to exit on its own before it is killed outright.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #exitReason(code: number | null, signal: NodeJS.Signals | null): Error {
    const detail = this.#stderr.trim();
    return new Error(
      `mcp server ${this.#options.serverId} exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`}${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) this.#onMessage(line);
      index = this.#buffer.indexOf("\n");
    }
  }

  #onMessage(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      // A server that prints a banner to stdout is out of spec. The line is dropped rather than
      // treated as a protocol error, because a chatty server is common and fatal-looking.
      return;
    }

    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);

    if (message.error !== undefined) {
      pending.reject(
        new Error(
          `mcp server ${this.#options.serverId} answered with an error: ${message.error.message ?? "no detail given"}`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #write(payload: Record<string, unknown>): void {
    const child = this.#child;
    if (!child || this.#closed) {
      throw new Error(`mcp server ${this.#options.serverId} is not running`);
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = this.#options.requestTimeoutMs ?? 15_000;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // A timeout settles the request. Leaving it pending is what turns a stalled server into
        // an application that appears to be thinking.
        reject(
          new Error(
            `mcp server ${this.#options.serverId} did not answer ${method} within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
}

/** Start a stdio server and complete its handshake. */
export async function connectStdio(options: StdioMcpTransportOptions): Promise<StdioMcpTransport> {
  const transport = new StdioMcpTransport(options);
  await transport.start();
  return transport;
}

export const MCP_TRANSPORT_STATUS = "implemented-stdio";
