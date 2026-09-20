#!/usr/bin/env node
/**
 * Reference MCP server over streamable HTTP.
 *
 * Written for the transport tests, so the transport is verified against a real server on a real
 * port speaking the real protocol rather than against a mock that agrees with whatever the
 * transport does. It implements exactly enough to be a server: initialize, tools/list, tools/call,
 * a session id handed out at initialize and required afterwards, plus the failure modes a client
 * has to survive.
 *
 * Behaviour chosen by `MCP_FIXTURE_MODE`:
 *   (unset)     normal: JSON replies, session id handed out and required
 *   "sse"       answers with a server-sent event stream instead of JSON
 *   "malformed" returns a tool object that does not match the protocol shape
 *   "toolerror" makes the tool report failure through the protocol's isError
 *   "hang"      accepts initialize, then never answers tools/list
 *   "redirect"  answers every request with a redirect to another host
 *   "nosession" never sends a session id
 *
 * The port is written to stdout as one JSON line, so the test never has to guess one.
 */

import { createServer } from "node:http";

const MODE = process.env.MCP_FIXTURE_MODE ?? "normal";
const SESSION = "session_reference_1";

const TOOLS = [
  {
    name: "echo",
    description: "Returns the text it was given.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "write_note",
    description: "Writes a note to the server's own storage.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    // Deliberately claims nothing, so normalisation must treat it as a write.
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** The reply for a request, or "hang" when the mode says never to answer it. */
function handle(request) {
  const { id, method, params } = request;
  if (id === undefined) return undefined;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "clarkcant-reference-http-server", version: "1.0.0" },
        capabilities: { tools: { listChanged: false } },
      },
    };
  }

  if (method === "tools/list") {
    if (MODE === "hang") return "hang";
    if (MODE === "malformed") {
      return { jsonrpc: "2.0", id, result: { tools: [{ name: "broken", inputSchema: "not-an-object" }] } };
    }
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const name = params?.name;
    if (name === "echo") {
      const text = String(params?.arguments?.text ?? "");
      return {
        jsonrpc: "2.0",
        id,
        result: MODE === "toolerror" ? textResult(`echo failed on purpose: ${text}`, true) : textResult(text),
      };
    }
    if (name === "write_note") {
      return { jsonrpc: "2.0", id, result: textResult(`note stored: ${String(params?.arguments?.text ?? "")}`) };
    }
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `no such tool ${String(name)}` } };
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `no such method ${String(method)}` } };
}

let initialized = false;

const server = createServer((request, response) => {
  if (MODE === "redirect" && request.url !== "/followed") {
    // To this server's own other path, which answers the protocol normally. A client that followed
    // the redirect would therefore succeed, which is what lets the test tell "refused to follow"
    // apart from "followed and failed".
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    response.writeHead(302, { location: `http://127.0.0.1:${String(port)}/followed` });
    response.end();
    return;
  }

  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } }));
      return;
    }

    // After initialize the session is required, so a client that forgets to echo it is refused
    // rather than quietly served.
    const presented = request.headers["mcp-session-id"];
    if (MODE !== "nosession" && initialized && presented !== SESSION) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "unknown session" } }));
      return;
    }

    const reply = handle(message);
    if (message.method === "initialize") initialized = true;

    if (reply === "hang") return;

    const headers = {
      "content-type": "application/json",
      ...(MODE === "nosession" ? {} : { "mcp-session-id": SESSION }),
    };

    // A notification has no reply, and the protocol answers it with 202 and an empty body.
    if (reply === undefined) {
      response.writeHead(202, headers);
      response.end();
      return;
    }

    if (MODE === "sse") {
      response.writeHead(200, { ...headers, "content-type": "text/event-stream" });
      // A progress event before the answer, because a real stream may carry one and the client has
      // to skip what is not a message.
      response.write(`event: progress\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`);
      response.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      response.end();
      return;
    }

    response.writeHead(200, headers);
    response.end(JSON.stringify(reply));
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: typeof address === "object" && address !== null ? address.port : 0 })}\n`);
});
