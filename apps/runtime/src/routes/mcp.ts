import { type MessageBlock, messageBlocksAsText } from "@clarkcant/contracts";

import { MCP_PATH, MCP_PROTOCOL_VERSIONS } from "../open-interfaces.ts";
import { type GatewayRequest, type GatewayResponse, json } from "./http.ts";

/**
 * The node as an MCP server, over the Streamable HTTP transport.
 *
 * Any MCP client — an IDE, a desktop assistant, another agent — can talk to the same Clark a person talks to. The
 * tools are thin: each one is a request to a route the gateway already serves, sent with the caller's own
 * credential and answered by the same handler. There is no second implementation of "send a message" here, so an
 * MCP caller cannot reach a behaviour, or skip a check, that the HTTP caller could not.
 *
 * Answers are plain JSON rather than an SSE stream: every tool below finishes within its request, and the server
 * never needs to speak first, which the transport allows (`GET` is answered 405).
 *
 * Deliberately absent: deciding an approval. An approval is the person's decision about something an agent wants to
 * do, and handing it to an MCP client would let an AI tool approve its own guarded action. The REST route stays for
 * the person's own surfaces.
 */

export interface McpRouteDeps {
  request: GatewayRequest;
  /** The gateway itself, for the routes the tools reach. */
  dispatch: (request: GatewayRequest) => Promise<GatewayResponse>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Enough for any real client, few enough that one request cannot queue unbounded tool calls. */
const MAX_BATCH = 32;

const SERVER_INFO = { name: "clarkcant", title: "ClarkCant", version: "1.0.0" };

const INSTRUCTIONS =
  "ClarkCant is one conversational agent, Clark. Use ask_clark for anything you would ask a person-facing assistant " +
  "on this machine; pass the conversationId it returns to continue the same conversation. When Clark asks a " +
  "question, answer it with answer_question. stop_all_work is an emergency stop.";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

const TOOLS = [
  {
    name: "ask_clark",
    title: "Ask Clark",
    description:
      "Send a message to Clark and wait for the answer. Starts a new conversation unless conversationId is given.",
    inputSchema: objectSchema(
      {
        text: { type: "string", minLength: 1, maxLength: 20_000, description: "What to say to Clark" },
        conversationId: { type: "string", description: "Continue this conversation" },
        title: { type: "string", maxLength: 200, description: "Title for a new conversation" },
      },
      ["text"],
    ),
  },
  {
    name: "list_conversations",
    title: "List conversations",
    description: "The conversations on this node.",
    inputSchema: objectSchema({}),
  },
  {
    name: "create_conversation",
    title: "Create conversation",
    description: "Start an empty conversation and return its id.",
    inputSchema: objectSchema({ title: { type: "string", maxLength: 200 } }),
  },
  {
    name: "read_conversation",
    title: "Read conversation",
    description: "The messages of a conversation as text, including any question Clark is waiting on.",
    inputSchema: objectSchema(
      {
        conversationId: { type: "string" },
        after: { type: "integer", minimum: 0, description: "Only messages after this cursor" },
      },
      ["conversationId"],
    ),
  },
  {
    name: "answer_question",
    title: "Answer Clark's question",
    description: "Answer a question Clark asked: free text, the option ids it offered, or confirmed true/false for a yes/no question.",
    inputSchema: objectSchema(
      {
        conversationId: { type: "string" },
        questionId: { type: "string" },
        text: { type: "string" },
        optionIds: { type: "array", items: { type: "string" } },
        confirmed: { type: "boolean" },
      },
      ["conversationId", "questionId"],
    ),
  },
  {
    name: "stop_all_work",
    title: "Stop all work",
    description: "Emergency stop: interrupts turns, kills running commands and stops background work on this node.",
    inputSchema: objectSchema({}),
  },
  {
    name: "node_status",
    title: "Node status",
    description: "This node's label and configured model.",
    inputSchema: objectSchema({}),
  },
] as const;

export async function handleMcpRoute(deps: McpRouteDeps): Promise<GatewayResponse | undefined> {
  const { request } = deps;
  if (request.path !== MCP_PATH) return undefined;

  if (request.method !== "POST") {
    // No server-initiated stream and no session to delete: both are optional in the transport.
    return json(405, { code: "METHOD_NOT_ALLOWED", message: `${MCP_PATH} accepts POST only` });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return json(400, rpcError(null, -32700, "the body is not valid JSON"));
  }

  const batch = Array.isArray(parsed);
  if (batch && (parsed as unknown[]).length === 0) {
    return json(400, rpcError(null, -32600, "an empty batch is not a JSON-RPC request"));
  }
  if (batch && (parsed as unknown[]).length > MAX_BATCH) {
    return json(400, rpcError(null, -32600, `at most ${String(MAX_BATCH)} messages may be sent in one batch`));
  }
  const messages = batch ? (parsed as unknown[]) : [parsed];
  const answers: unknown[] = [];
  for (const message of messages) {
    const answer = await answerOne(deps, message);
    if (answer !== undefined) answers.push(answer);
  }

  // Notifications and responses carry nothing back; the transport says so with 202 and no body.
  if (answers.length === 0) return { status: 202, body: null };
  return json(200, batch ? answers : answers[0]);
}

async function answerOne(deps: McpRouteDeps, message: unknown): Promise<unknown> {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "each message must be a JSON-RPC object");
  }
  const rpc = message as Partial<JsonRpcRequest> & { result?: unknown; error?: unknown };
  const isRequest = typeof rpc.method === "string" && rpc.id !== undefined && rpc.id !== null;

  // A notification, or a client's response to something this server never asks: acknowledged, never answered.
  if (!isRequest) {
    if (rpc.jsonrpc !== "2.0" || (typeof rpc.method !== "string" && rpc.result === undefined && rpc.error === undefined)) {
      return rpcError(rpc.id ?? null, -32600, "not a JSON-RPC 2.0 message");
    }
    return undefined;
  }

  if (typeof rpc.id !== "string" && typeof rpc.id !== "number") {
    return rpcError(null, -32600, "id must be a string or a number");
  }
  const id = rpc.id;
  if (rpc.jsonrpc !== "2.0") return rpcError(id, -32600, "jsonrpc must be \"2.0\"");
  const params = rpc.params ?? {};

  switch (rpc.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      // The client's version when this server speaks it, otherwise the newest this server has: the client decides
      // whether it can continue, which is how the protocol negotiates.
      const protocolVersion =
        asked !== undefined && MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== "string" || !TOOLS.some((tool) => tool.name === name)) {
        return rpcError(id, -32602, `unknown tool: ${String(name)}`);
      }
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(id, -32602, "tool arguments must be an object");
      }
      return rpcResult(id, await callTool(deps, name, args as Record<string, unknown>));
    }
    default:
      return rpcError(id, -32601, `method not found: ${rpc.method}`);
  }
}

async function callTool(deps: McpRouteDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const call = (method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<GatewayResponse> =>
    deps.dispatch({
      method,
      path,
      query,
      // The caller's own credential, so the route checks it exactly as it would over HTTP.
      headers: { authorization: deps.request.headers.authorization },
      body: body === undefined ? "" : JSON.stringify(body),
    });

  switch (name) {
    case "ask_clark": {
      const text = args.text;
      if (typeof text !== "string" || text.trim() === "") return toolError("text must be a non-empty string");
      if (args.conversationId !== undefined && typeof args.conversationId !== "string") {
        return toolError("conversationId must be a string; leave it out to start a new conversation");
      }
      let conversationId = args.conversationId as string | undefined;
      if (conversationId === undefined) {
        const title = typeof args.title === "string" ? args.title : text.trim().slice(0, 60);
        const created = await call("POST", "/conversations", { title });
        if (created.status !== 201) return refused(created);
        conversationId = (created.body as { conversationId: string }).conversationId;
      }
      const sent = await call("POST", `/conversations/${encodeURIComponent(conversationId)}/messages`, { text });
      if (sent.status >= 400) return refused(sent);
      const body = sent.body as {
        resolution?: string;
        taskId?: string | null;
        messageIds?: string[];
        timeline?: { messages?: unknown[] };
      };
      const reply = replyText(body.timeline?.messages ?? [], body.messageIds ?? []);
      const resolution = body.resolution ?? "accepted";
      const said =
        reply !== ""
          ? reply
          : sent.status === 202
            ? `Clark accepted the message and is still working on it (${resolution}). Read the conversation later.`
            : "Clark answered without text.";
      return {
        content: [{ type: "text", text: said }],
        structuredContent: { conversationId, resolution, taskId: body.taskId ?? null, reply: said },
      };
    }
    case "list_conversations":
      return fromResponse(await call("GET", "/conversations"));
    case "create_conversation": {
      const created = await call("POST", "/conversations", typeof args.title === "string" ? { title: args.title } : {});
      return fromResponse(created);
    }
    case "read_conversation": {
      if (typeof args.conversationId !== "string") return toolError("conversationId is required");
      const after = typeof args.after === "number" ? { after: String(args.after) } : {};
      const read = await call("GET", `/conversations/${encodeURIComponent(args.conversationId)}/timeline`, undefined, after);
      if (read.status >= 400) return refused(read);
      const timeline = read.body as { cursor?: number; messages?: unknown[] };
      const text = (timeline.messages ?? [])
        .map((message) => {
          const record = message as { role?: string; blocks?: MessageBlock[] };
          return `${record.role ?? "message"}: ${messageBlocksAsText(record.blocks ?? [])}`;
        })
        .join("\n\n");
      return {
        content: [{ type: "text", text: text === "" ? "The conversation has no messages." : text }],
        structuredContent: { cursor: timeline.cursor ?? 0, messages: timeline.messages ?? [] },
      };
    }
    case "answer_question": {
      if (typeof args.conversationId !== "string" || typeof args.questionId !== "string") {
        return toolError("conversationId and questionId are required");
      }
      const answered = await call(
        "POST",
        `/conversations/${encodeURIComponent(args.conversationId)}/questions/${encodeURIComponent(args.questionId)}/answer`,
        {
          ...(typeof args.text === "string" ? { text: args.text } : {}),
          ...(Array.isArray(args.optionIds) ? { optionIds: args.optionIds } : {}),
          ...(typeof args.confirmed === "boolean" ? { confirmed: args.confirmed } : {}),
        },
      );
      if (answered.status >= 400) return refused(answered);
      return { content: [{ type: "text", text: "Answered. Clark continues in a new turn; read the conversation for the reply." }] };
    }
    case "stop_all_work":
      return fromResponse(await call("POST", "/stop"));
    case "node_status":
      return fromResponse(await call("GET", "/node"));
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

/** The assistant's words among the messages this request wrote. */
function replyText(messages: unknown[], messageIds: string[]): string {
  const wanted = new Set(messageIds);
  return messages
    .map((message) => message as { messageId?: string; role?: string; blocks?: MessageBlock[] })
    .filter((message) => message.role !== "user" && message.messageId !== undefined && wanted.has(message.messageId))
    .map((message) => messageBlocksAsText(message.blocks ?? []))
    .filter((text) => text !== "")
    .join("\n\n");
}

function fromResponse(response: GatewayResponse): ToolResult {
  if (response.status >= 400) return refused(response);
  const body = (response.body ?? {}) as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body };
}

/** A route's refusal, passed on in its own words: the code is what a caller can act on. */
function refused(response: GatewayResponse): ToolResult {
  const body = (response.body ?? {}) as { code?: string; message?: string };
  return toolError(`${body.code ?? `HTTP_${String(response.status)}`}: ${body.message ?? "the node refused the request"}`);
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function rpcResult(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
