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

import { type McpToolMetadata, mcpToolMetadataSchema, normalizeMcpToolResult, type McpToolResult, type McpTransport } from "./index.ts";

export interface StdioMcpTransportOptions {
  serverId: string;
  /** The Clark version this client introduces itself with in initialize; the host passes its own, never a literal. */
  clientVersion: string;
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  /**
   * Whether the server also gets this process's environment. Defaults to true, for a server a person configured by
   * hand; a host that runs code it did not write passes false and names in `env` exactly what the server may see.
   */
  inheritEnv?: boolean;
  /** Per-request ceiling. Defaults to 15 seconds. */
  requestTimeoutMs?: number;
  /**
   * Told once when the server goes away on its own, with the same reason every pending request was rejected with.
   * Not called for close(): a caller that closed the server already knows.
   */
  onExit?: (reason: Error) => void;
  /**
   * Requests the server may send to the host, and how they are answered.
   *
   * Absent, every server request is answered "method not found". Present, `experimental` is advertised in
   * `initialize` so a server knows what it may ask, and `handle` answers each request; it rejects with
   * `McpServerRequestError` to answer with a JSON-RPC error. Its signal aborts when the server goes away or is closed,
   * so whatever the host is doing for it stops too.
   */
  serverRequests?: {
    experimental: Record<string, unknown>;
    handle: (request: { method: string; params: unknown; signal: AbortSignal }) => Promise<unknown>;
  };
}

/** A JSON-RPC error the host answers a server's request with. */
export class McpServerRequestError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** JSON-RPC's own codes, for the answers the transport gives without asking the handler. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_SERVER_BUSY = -32000;

/** How many requests one server may have the host working on at once; more are refused, not queued. */
export const MAX_SERVER_REQUESTS = 8;

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
  /** Removes the abort listener a caller's signal holds, once the request has settled some other way. */
  release?: () => void;
  progressToken?: number;
  lastProgress?: number;
  onProgress?: (progress: { current: number; total?: number; message?: string }) => void;
}

/**
 * A request the server did not answer in time.
 *
 * Its own class, because a caller that sent something with an effect has to tell "the server said no" from "the server
 * never said": after a timeout the request may still have been carried out.
 */
export class McpRequestTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRequestTimeout";
  }
}

/**
 * A request its caller withdrew before the server answered.
 *
 * `sent` says whether it had been written to the server. One withdrawn while it ran was sent, the server was told, and
 * it may have acted already; one withdrawn before it was written reached nothing, and a caller must not report it as
 * something that may have happened.
 */
export class McpRequestCancelled extends Error {
  readonly sent: boolean;
  constructor(message: string, sent: boolean) {
    super(message);
    this.name = "McpRequestCancelled";
    this.sent = sent;
  }
}

/** A request that could not be written to the server at all — it is not running — so nothing reached it. */
export class McpRequestNotSent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRequestNotSent";
  }
}

/** How much stderr is kept for diagnostics. Enough to explain a crash, not a log sink. */
const STDERR_TAIL_BYTES = 4000;
/**
 * The longest message a server may send. A line is held until its newline arrives, so a server that never sends one
 * would otherwise grow the node's memory without bound; one that goes past this is stopped as out of protocol.
 */
export const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;

export class StdioMcpTransport implements McpTransport {
  readonly #options: StdioMcpTransportOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #stderr = "";
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #handshake: ServerHandshake | undefined;
  #closed = false;
  #exited = false;
  /** What the host is doing for the server right now, so a close or an exit stops it. */
  readonly #serving = new Map<string, AbortController>();

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
      env: { ...(this.#options.inheritEnv === false ? {} : process.env), ...(this.#options.env ?? {}) },
      // A server is a background process; on Windows it must not flash a console window at the person.
      windowsHide: true,
    });
    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-STDERR_TAIL_BYTES);
    });

    // A dead server cannot answer, so nothing may stay pending.
    child.on("exit", (code, signal) => this.#gone(this.#exitReason(code, signal)));
    child.on("error", (error) => this.#gone(new Error(`mcp server failed to start: ${error.message}`)));
    // Writing to a server that has just died raises on stdin rather than on the process; the exit reports it.
    child.stdin.on("error", () => undefined);

    const result = (await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities:
        this.#options.serverRequests === undefined ? {} : { experimental: this.#options.serverRequests.experimental },
      clientInfo: { name: "clarkcant", version: this.#options.clientVersion },
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

  /** Whether the server still answers. The protocol's own liveness check, bounded by the request ceiling. */
  async ping(): Promise<void> {
    await this.#request("ping", {});
  }

  /** Whether the process is still running and has not been closed. */
  get running(): boolean {
    return this.#child !== undefined && !this.#closed && !this.#exited;
  }

  /**
   * Call one tool.
   *
   * `signal` withdraws the request: the pending promise rejects at once with `McpRequestCancelled`, and the server is
   * sent the protocol's `notifications/cancelled` for it. A server may already have acted, and the protocol does not say
   * whether it did, which is why the caller is told "cancelled" and not "did not happen".
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal; onProgress?: (progress: { current: number; total?: number; message?: string }) => void } = {},
  ): Promise<McpToolResult> {
    const result = (await this.#request("tools/call", { name, arguments: args }, options.timeoutMs, options.signal, options.onProgress)) as {
      content?: unknown[];
      isError?: boolean;
    };

    const normalized = normalizeMcpToolResult(result);
    const text = normalized.content;

    if (result?.isError === true) {
      // A tool that reports failure has still answered. The caller gets the server's own words
      // rather than a generic error, because those words are the diagnosis.
      throw new Error(`mcp tool ${name} reported an error: ${text || "no detail given"}`);
    }

    return normalized;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    this.#failAll(new Error(`mcp server ${this.#options.serverId} was closed`));
    if (this.#exited) return;
    // End of input is the protocol's own way to ask a stdio server to stop, and the only one that reaches a server
    // behind a launcher such as a container engine's command line.
    child.stdin.end();
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

  #gone(reason: Error): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#failAll(reason);
    if (!this.#closed) this.#options.onExit?.(reason);
  }

  #failAll(error: Error): void {
    this.#stopServing(error);
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.release?.();
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  /** Tell the server a request is withdrawn. Best effort: a server that has gone cannot be told, and needs not be. */
  #cancelled(id: number, reason: string): void {
    try {
      this.#notify("notifications/cancelled", { requestId: id, reason });
    } catch {
      // The server is not running, so there is nothing left to tell.
    }
  }

  #onStdout(chunk: string): void {
    if (this.#exited || this.#closed) return;
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) this.#onMessage(line);
      index = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > MAX_MESSAGE_CHARS) {
      this.#buffer = "";
      const child = this.#child;
      this.#gone(
        new Error(
          `mcp server ${this.#options.serverId} sent a message longer than ${String(MAX_MESSAGE_CHARS / (1024 * 1024))} MB and was stopped`,
        ),
      );
      child?.kill("SIGKILL");
    }
  }

  #onMessage(line: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      // A server that prints a banner to stdout is out of spec. The line is dropped rather than
      // treated as a protocol error, because a chatty server is common and fatal-looking.
      return;
    }

    // The server withdrew a request it sent: whatever the host is doing for it stops.
    if (message.method === "notifications/cancelled") {
      const requestId = (message.params as { requestId?: unknown } | null | undefined)?.requestId;
      if (typeof requestId !== "number" && typeof requestId !== "string") return;
      const key = `${typeof requestId}:${String(requestId)}`;
      this.#serving.get(key)?.abort(new Error("the service withdrew its request"));
      return;
    }
    if (message.method === "notifications/progress") {
      if (message.params === null || typeof message.params !== "object") return;
      const params = message.params as Record<string, unknown>;
      if (typeof params.progressToken !== "number" || !Number.isSafeInteger(params.progressToken)) return;
      const pending = this.#pending.get(params.progressToken);
      if (pending === undefined || pending.progressToken !== params.progressToken || pending.onProgress === undefined) return;
      if (typeof params.progress !== "number" || !Number.isFinite(params.progress) || params.progress < 0) return;
      if (pending.lastProgress !== undefined && params.progress < pending.lastProgress) return;
      if (params.total !== undefined && (typeof params.total !== "number" || !Number.isFinite(params.total) || params.total <= 0 || params.progress > params.total)) return;
      if (params.message !== undefined && (typeof params.message !== "string" || params.message.length > 500)) return;
      pending.lastProgress = params.progress;
      pending.onProgress({
        current: params.progress,
        ...(typeof params.total === "number" ? { total: params.total } : {}),
        ...(typeof params.message === "string" ? { message: params.message } : {}),
      });
      return;
    }
    // A request from the server carries a method and an id; a response to one of ours carries neither a method nor
    // both. Told apart by the method, so a server request whose id matches one of ours never settles ours.
    if (typeof message.method === "string" && (typeof message.id === "number" || typeof message.id === "string")) {
      this.#serve(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id !== "number" || typeof message.method === "string") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.release?.();
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

  /** Answer one request the server sent. Every request is answered, with a result or a JSON-RPC error. */
  #serve(id: number | string, method: string, params: unknown): void {
    const answer = (payload: { result: unknown } | { error: { code: number; message: string } }): void => {
      try {
        this.#write({ jsonrpc: "2.0", id, ...payload });
      } catch {
        // The server went away while the host worked on its request; there is nobody left to answer.
      }
    };
    const handler = this.#options.serverRequests;
    if (handler === undefined) {
      answer({ error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `the host does not answer ${method.slice(0, 80)}` } });
      return;
    }
    const key = `${typeof id}:${String(id)}`;
    if (this.#serving.has(key)) {
      answer({ error: { code: JSON_RPC_INVALID_PARAMS, message: "a request with this id is already being answered" } });
      return;
    }
    if (this.#serving.size >= MAX_SERVER_REQUESTS) {
      answer({ error: { code: JSON_RPC_SERVER_BUSY, message: `the host is already working on ${String(MAX_SERVER_REQUESTS)} requests from this server` } });
      return;
    }
    const controller = new AbortController();
    this.#serving.set(key, controller);
    void handler
      .handle({ method, params, signal: controller.signal })
      .then(
        (result) => answer({ result: result ?? {} }),
        (cause: unknown) =>
          answer({
            error:
              cause instanceof McpServerRequestError
                ? { code: cause.code, message: cause.message.slice(0, 500) }
                : { code: JSON_RPC_SERVER_BUSY, message: "the host could not answer this request" },
          }),
      )
      .finally(() => {
        if (this.#serving.get(key) === controller) this.#serving.delete(key);
      });
  }

  /** Stop everything the host is doing for this server. */
  #stopServing(reason: Error): void {
    for (const controller of this.#serving.values()) controller.abort(reason);
    this.#serving.clear();
  }

  #write(payload: Record<string, unknown>): void {
    const child = this.#child;
    if (!child || this.#closed || this.#exited) {
      throw new Error(`mcp server ${this.#options.serverId} is not running`);
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #request(
    method: string,
    params: Record<string, unknown>,
    timeoutOverrideMs?: number,
    signal?: AbortSignal,
    onProgress?: (progress: { current: number; total?: number; message?: string }) => void,
  ): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = timeoutOverrideMs ?? this.#options.requestTimeoutMs ?? 15_000;

    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted === true) {
        // Withdrawn before it was sent: nothing reached the server, so there is nothing to tell it.
        reject(new McpRequestCancelled(`${method} to mcp server ${this.#options.serverId} was cancelled before it was sent`, false));
        return;
      }
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.release?.();
        // The server is told, so one that is merely slow can stop rather than finish work nobody is waiting for. Never
        // for `initialize`, which the protocol says a client must not cancel.
        if (method !== "initialize") this.#cancelled(id, `no answer within ${String(timeoutMs)} ms`);
        // A timeout settles the request. Leaving it pending is what turns a stalled server into
        // an application that appears to be thinking.
        reject(
          new McpRequestTimeout(
            `mcp server ${this.#options.serverId} did not answer ${method} within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);

      const onAbort = (): void => {
        if (!this.#pending.has(id)) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        this.#cancelled(id, "the caller withdrew the request");
        reject(new McpRequestCancelled(`${method} to mcp server ${this.#options.serverId} was cancelled while it ran`, true));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const release = signal === undefined ? undefined : (): void => signal.removeEventListener("abort", onAbort);

      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        ...(release === undefined ? {} : { release }),
        ...(onProgress === undefined ? {} : { progressToken: id, onProgress }),
      });
      try {
        const requestParams = onProgress === undefined ? params : { ...params, _meta: { progressToken: id } };
        this.#write({ jsonrpc: "2.0", id, method, params: requestParams });
      } catch (cause) {
        clearTimeout(timer);
        release?.();
        this.#pending.delete(id);
        // The write itself failed, so the request never reached the server.
        reject(new McpRequestNotSent(cause instanceof Error ? cause.message : String(cause)));
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
