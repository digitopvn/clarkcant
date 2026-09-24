import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type MessageBlock, messageBlocksAsText, parseSseChunk } from "@clarkcant/contracts";

/**
 * The `clarkcant` command.
 *
 * A client of a node's open gateway and nothing more: every command is a request to a route any other app could make
 * with the same token, so what the terminal can do is exactly what HTTP, MCP and the WebSocket can do. It never opens
 * the node's database or starts a node of its own.
 *
 * Kept free of `process` so a test can drive it: the entry point hands in the environment, the streams and `fetch`.
 */

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Lines from standard input, for `clarkcant mcp`. */
  stdinLines?: () => AsyncIterable<string>;
  fetch?: typeof fetch;
  readFile?: (path: string) => string;
}

export interface Connection {
  url: string;
  token: string | undefined;
}

export const DEFAULT_URL = "http://127.0.0.1:8765";

export const USAGE = `Usage: clarkcant <command> [options]

Commands:
  ask "<text>" [-c <conversationId>]   Ask Clark; the answer streams to stdout
  status                               Node health and identity
  conversations                        List conversations
  new [title]                          Create a conversation
  read <conversationId>                Print a conversation
  stop                                 Emergency stop: interrupt turns, kill running work
  api <METHOD> <path> [jsonBody]       Call any REST route
  mcp                                  Serve MCP over stdio, bridged to the node's /mcp
  discover                             Print the node's discovery document

Options:
  --url <url>          Node URL (CLARKCANT_URL, default ${DEFAULT_URL})
  --token <token>      Bearer token (CLARKCANT_TOKEN, else read from the data dir)
  --data-dir <dir>     Where identity.json is (CLARKCANT_DATA_DIR, default ~/.clarkcant)
  --json               Print raw JSON
  -h, --help           Show this help
`;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const takesValue = new Set(["url", "token", "data-dir", "c", "conversation"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    const name = arg.startsWith("--") ? arg.slice(2) : arg.startsWith("-") && arg.length === 2 ? arg.slice(1) : undefined;
    if (name === undefined) {
      positional.push(arg);
      continue;
    }
    if (takesValue.has(name)) {
      const value = argv[index + 1];
      if (value !== undefined) {
        flags.set(name, value);
        index += 1;
      }
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

/**
 * Where the node is and how to prove who is asking.
 *
 * A flag wins over the environment, and the environment over the node's own identity file, so a script can point
 * one command elsewhere without touching the shell. The token is only read from the file, never written anywhere.
 */
export function resolveConnection(flags: Map<string, string | true>, io: CliIo): Connection {
  const flag = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const url = (flag("url") ?? io.env.CLARKCANT_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  let token = flag("token") ?? io.env.CLARKCANT_TOKEN;
  if (token === undefined || token === "") {
    const dataDir = flag("data-dir") ?? io.env.CLARKCANT_DATA_DIR ?? join(homedir(), ".clarkcant");
    try {
      const read = io.readFile ?? ((path: string) => readFileSync(path, "utf8"));
      const identity = JSON.parse(read(join(dataDir, "identity.json"))) as { localToken?: unknown };
      token = typeof identity.localToken === "string" ? identity.localToken : undefined;
    } catch {
      token = undefined;
    }
  }
  return { url, token: token === "" ? undefined : token };
}

class CliError extends Error {}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  if (command === undefined || flags.has("h") || flags.has("help") || command === "help") {
    io.stdout(USAGE);
    return command === undefined && !flags.has("h") && !flags.has("help") ? 1 : 0;
  }

  const connection = resolveConnection(flags, io);
  const asJson = flags.has("json");
  const doFetch = io.fetch ?? fetch;

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    let response: Response;
    try {
      response = await doFetch(`${connection.url}${path}`, {
        method,
        headers: {
          ...(connection.token === undefined ? {} : { authorization: `Bearer ${connection.token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new CliError(
        `could not reach the node at ${connection.url} (${cause instanceof Error ? cause.message : String(cause)}). ` +
          "Is it running? Start one with `node apps/runtime/src/main.ts`, or pass --url.",
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed };
  };

  const expectOk = (result: { status: number; body: unknown }): unknown => {
    if (result.status < 400) return result.body;
    const refusal = (result.body ?? {}) as { code?: string; message?: string };
    const hint = result.status === 401 ? " Pass --token, set CLARKCANT_TOKEN, or point --data-dir at the node's data directory." : "";
    throw new CliError(`${refusal.code ?? `HTTP ${String(result.status)}`}: ${refusal.message ?? "the node refused the request"}.${hint}`);
  };

  const print = (value: unknown, text: () => string): void => {
    io.stdout(`${asJson ? JSON.stringify(value, null, 2) : text()}\n`);
  };

  try {
    switch (command) {
      case "status": {
        const health = expectOk(await call("GET", "/health"));
        const node = expectOk(await call("GET", "/node")) as { nodeId?: string; label?: string; model?: unknown };
        print({ health, node }, () => {
          const model = node.model as { provider?: string; id?: string } | null | undefined;
          return [
            `node     ${node.label ?? "?"} (${node.nodeId ?? "?"})`,
            `url      ${connection.url}`,
            `model    ${model == null ? "none configured" : `${model.provider ?? "?"}/${model.id ?? "?"}`}`,
          ].join("\n");
        });
        return 0;
      }
      case "discover": {
        const document = expectOk(await call("GET", "/.well-known/clarkcant.json"));
        io.stdout(`${JSON.stringify(document, null, 2)}\n`);
        return 0;
      }
      case "conversations": {
        const listed = expectOk(await call("GET", "/conversations")) as {
          conversations?: { conversationId: string; title?: string }[];
        };
        const conversations = listed.conversations ?? [];
        print(listed, () =>
          conversations.length === 0
            ? "No conversations yet. Start one with: clarkcant ask \"hello\""
            : conversations.map((item) => `${item.conversationId}  ${item.title ?? ""}`.trimEnd()).join("\n"),
        );
        return 0;
      }
      case "new": {
        const title = rest.join(" ").trim();
        const created = expectOk(await call("POST", "/conversations", title === "" ? {} : { title })) as {
          conversationId: string;
        };
        print(created, () => created.conversationId);
        return 0;
      }
      case "read": {
        const conversationId = rest[0];
        if (conversationId === undefined) throw new CliError("read needs a conversation id: clarkcant read <conversationId>");
        const timeline = expectOk(await call("GET", `/conversations/${encodeURIComponent(conversationId)}/timeline`)) as {
          messages?: { role?: string; blocks?: MessageBlock[] }[];
        };
        print(timeline, () =>
          (timeline.messages ?? [])
            .map((message) => `${message.role === "user" ? "you" : "clark"}: ${messageBlocksAsText(message.blocks ?? [])}`)
            .join("\n\n"),
        );
        return 0;
      }
      case "stop": {
        const stopped = expectOk(await call("POST", "/stop"));
        print(stopped, () => "Stopped. Running turns, commands and background work on the node were asked to end.");
        return 0;
      }
      case "api": {
        const [method, path, body] = rest;
        if (method === undefined || path === undefined || !path.startsWith("/")) {
          throw new CliError("api needs a method and a path: clarkcant api GET /node");
        }
        let payload: unknown;
        if (body !== undefined) {
          try {
            payload = JSON.parse(body);
          } catch {
            throw new CliError("the body must be JSON, e.g. '{\"text\":\"hi\"}'");
          }
        }
        const result = await call(method.toUpperCase(), path, payload);
        io.stdout(`${typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2)}\n`);
        return result.status < 400 ? 0 : 1;
      }
      case "ask":
        return await ask(rest, flags, { connection, io, call, expectOk, doFetch, asJson });
      case "mcp":
        return await bridgeMcp({ connection, io, doFetch });
      default:
        io.stderr(`unknown command: ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (cause) {
    if (cause instanceof CliError) {
      io.stderr(`clarkcant: ${cause.message}\n`);
      return 1;
    }
    throw cause;
  }
}

interface AskContext {
  connection: Connection;
  io: CliIo;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  expectOk: (result: { status: number; body: unknown }) => unknown;
  doFetch: typeof fetch;
  asJson: boolean;
}

/**
 * Ask Clark and write the answer as it is produced.
 *
 * The streaming route, so a long answer is readable while it is written. Text goes to stdout and everything about
 * the conversation — its id, the tools the turn ran — to stderr, which keeps `clarkcant ask ... > answer.md` clean.
 */
async function ask(rest: string[], flags: Map<string, string | true>, context: AskContext): Promise<number> {
  const { io, connection } = context;
  const text = rest.join(" ").trim();
  if (text === "") throw new CliError("ask needs something to say: clarkcant ask \"what can you do?\"");

  const given = flags.get("c") ?? flags.get("conversation");
  let conversationId = typeof given === "string" ? given : undefined;
  if (conversationId === undefined) {
    const created = context.expectOk(await context.call("POST", "/conversations", { title: text.slice(0, 60) })) as {
      conversationId: string;
    };
    conversationId = created.conversationId;
    io.stderr(`conversation ${conversationId} (continue with -c ${conversationId})\n`);
  }

  let response: Response;
  try {
    response = await context.doFetch(`${connection.url}/conversations/${encodeURIComponent(conversationId)}/messages/stream`, {
      method: "POST",
      headers: {
        ...(connection.token === undefined ? {} : { authorization: `Bearer ${connection.token}` }),
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ text }),
    });
  } catch (cause) {
    throw new CliError(`could not reach the node at ${connection.url} (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (!response.ok || response.body === null) {
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = null;
    }
    context.expectOk({ status: response.status, body });
    throw new CliError(`the node answered ${String(response.status)} without a stream`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let wrote = false;
  let failed = false;
  let done: Record<string, unknown> | undefined;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const parsed = parseSseChunk(buffer + decoder.decode(chunk, { stream: true }));
    buffer = parsed.rest;
    for (const event of parsed.events) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        data = { text: event.data };
      }
      if (event.event === "delta" && typeof data.text === "string") {
        if (!context.asJson) io.stdout(data.text);
        wrote = wrote || data.text !== "";
      } else if (event.event === "tool-start" && !context.asJson) {
        const label = typeof data.label === "string" ? data.label : typeof data.name === "string" ? data.name : "a tool";
        io.stderr(`[${label}]\n`);
      } else if (event.event === "error") {
        failed = true;
        io.stderr(`clarkcant: ${typeof data.message === "string" ? data.message : "the turn failed"}\n`);
      } else if (event.event === "done") {
        done = data;
      }
    }
  }

  if (context.asJson) {
    io.stdout(`${JSON.stringify({ conversationId, ...(done ?? {}) }, null, 2)}\n`);
    return failed ? 1 : 0;
  }
  // A turn that answered without streaming text — a task, a sample — still said something; print what it wrote.
  if (!wrote && done !== undefined) {
    const ids = new Set(Array.isArray(done.messageIds) ? (done.messageIds as string[]) : []);
    const messages = ((done.timeline as { messages?: unknown[] } | undefined)?.messages ?? []) as {
      messageId?: string;
      role?: string;
      blocks?: MessageBlock[];
    }[];
    const said = messages
      .filter((message) => message.role !== "user" && message.messageId !== undefined && ids.has(message.messageId))
      .map((message) => messageBlocksAsText(message.blocks ?? []))
      .filter((line) => line !== "")
      .join("\n\n");
    if (said !== "") {
      io.stdout(said);
      wrote = true;
    }
  }
  if (wrote) io.stdout("\n");
  return failed ? 1 : 0;
}

/**
 * MCP over stdio, for clients that launch a server as a process.
 *
 * Each line on stdin is one JSON-RPC message; it is posted to the node's `/mcp` and the answer, if there is one, is
 * written back as one line. The node does all the work, so this bridge holds no tools of its own and cannot drift
 * from the HTTP endpoint. Diagnostics go to stderr only, because stdout belongs to the protocol.
 */
async function bridgeMcp(context: { connection: Connection; io: CliIo; doFetch: typeof fetch }): Promise<number> {
  const { io, connection } = context;
  if (io.stdinLines === undefined) throw new CliError("mcp needs standard input");
  if (connection.token === undefined) {
    io.stderr("clarkcant mcp: no token found; every call will be refused. Set CLARKCANT_TOKEN or --data-dir.\n");
  }
  for await (const line of io.stdinLines()) {
    if (line.trim() === "") continue;
    let id: unknown;
    try {
      const message = JSON.parse(line) as { id?: unknown };
      id = message.id ?? null;
    } catch {
      io.stdout(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not valid JSON" } })}\n`);
      continue;
    }
    try {
      const response = await context.doFetch(`${connection.url}/mcp`, {
        method: "POST",
        headers: {
          ...(connection.token === undefined ? {} : { authorization: `Bearer ${connection.token}` }),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: line,
      });
      const text = await response.text();
      if (response.status === 202 || text.trim() === "") continue;
      if (response.ok) {
        io.stdout(`${JSON.stringify(JSON.parse(text))}\n`);
        continue;
      }
      // A refusal from the gateway itself (a wrong token, a node that is not there) becomes an error on this request.
      let message = `the node answered HTTP ${String(response.status)}`;
      try {
        const body = JSON.parse(text) as { message?: string; error?: { message?: string } };
        message = body.error?.message ?? body.message ?? message;
      } catch {
        // Keep the status line.
      }
      if (id !== null) io.stdout(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
      else io.stderr(`clarkcant mcp: ${message}\n`);
    } catch (cause) {
      const message = `could not reach the node at ${connection.url}: ${cause instanceof Error ? cause.message : String(cause)}`;
      if (id !== null) io.stdout(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
      else io.stderr(`clarkcant mcp: ${message}\n`);
    }
  }
  return 0;
}
