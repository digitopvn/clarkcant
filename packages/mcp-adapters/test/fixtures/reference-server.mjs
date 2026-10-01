#!/usr/bin/env node
/**
 * Reference MCP server over stdio.
 *
 * Written for the transport tests, so the transport is verified against a real process speaking
 * the real protocol rather than against a mock that agrees with whatever the transport does. It
 * implements exactly enough to be a server: initialize, ping, tools/list, tools/call, plus the failure
 * modes a client has to survive.
 *
 * Behaviour chosen by `MCP_FIXTURE_MODE`:
 *   (unset)   normal
 *   "hang"    accepts initialize, then never answers tools/list or ping
 *   "crash"   accepts initialize, then exits when a tool is called
 *   "banner"  prints a non-JSON line to stdout before the protocol starts
 *   "malformed" returns a tool object that does not match the protocol shape
 *   "toolerror" makes the tool report failure through the protocol's isError
 *   "flood"   accepts initialize, then answers tools/list with output that never ends a line
 *   "asks"    a call to the tool "ask" sends the host the requests named in its arguments, and returns what the
 *             host answered, together with what the host advertised it would answer
 */

const MODE = process.env.MCP_FIXTURE_MODE ?? "normal";

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

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** The host's answers to requests this server sent, by request id. */
const awaiting = new Map();
let advertised = null;
let sent = 0;

/** Send the host the requests a call to "ask" names; answer the call with what came back. */
function ask(callId, args) {
  const requests = Array.isArray(args?.requests) ? args.requests : [];
  const answers = requests.map((entry) => {
    sent += 1;
    const requestId = entry.sameIdAsCall === true ? callId : `srv-${String(sent)}`;
    const answered = entry.cancel === true ? Promise.resolve({ cancelled: true }) : new Promise((resolve) => awaiting.set(requestId, resolve));
    send({ jsonrpc: "2.0", id: requestId, method: entry.method, ...(entry.params === undefined ? {} : { params: entry.params }) });
    if (entry.cancel === true) {
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "no longer needed" } });
    }
    return answered;
  });
  void Promise.all(answers).then((settled) => {
    send({ jsonrpc: "2.0", id: callId, result: textResult(JSON.stringify({ advertised, answers: settled })) });
  });
}

function handle(request) {
  const { id, method, params } = request;
  if (id === undefined) return;

  // An answer to a request this server sent: it has an id and no method.
  if (method === undefined) {
    const resolve = awaiting.get(id);
    if (resolve !== undefined) {
      awaiting.delete(id);
      resolve(request.error === undefined ? { result: request.result } : { error: request.error });
    }
    return;
  }

  if (method === "initialize") {
    advertised = params?.capabilities?.experimental ?? null;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "clarkcant-reference-server", version: "1.0.0" },
        capabilities: { tools: { listChanged: false } },
      },
    });
    return;
  }

  if (method === "ping") {
    if (MODE === "hang") return;
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    if (MODE === "hang") return;
    if (MODE === "flood") {
      // One line that never ends: a client that keeps reading it grows without bound.
      const chunk = "x".repeat(64 * 1024);
      const flood = () => {
        let more = true;
        while (more) more = process.stdout.write(chunk);
        process.stdout.once("drain", flood);
      };
      flood();
      return;
    }
    if (MODE === "malformed") {
      send({ jsonrpc: "2.0", id, result: { tools: [{ name: "broken", inputSchema: "not-an-object" }] } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    if (MODE === "crash") {
      process.stderr.write("reference server: crashing on purpose\n");
      process.exit(3);
    }
    const name = params?.name;
    if (name === "ask" && MODE === "asks") {
      ask(id, params?.arguments);
      return;
    }
    if (name === "echo") {
      send({ jsonrpc: "2.0", id, result: textResult(String(params?.arguments?.text ?? "")) });
      return;
    }
    if (name === "write_note") {
      if (MODE === "files") {
        send({ jsonrpc: "2.0", id, result: { content: [
          { type: "text", text: "result ready" },
          { type: "resource", resource: { uri: "file:///private/service/output.txt", mimeType: "text/plain", text: "real service bytes" } },
          { type: "resource", resource: { uri: "file:///private/service/blob.txt", mimeType: "text/plain", blob: Buffer.from("binary resource").toString("base64") } },
          { type: "image", mimeType: "image/png", data: "invalid base64!" },
          { type: "resource_link", uri: "file:///private/service/link.txt", name: "link.txt" },
        ] } });
        return;
      }
      if (MODE === "progress") {
        const token = params?._meta?.progressToken;
        send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token + 1, progress: 99, total: 100, message: "wrong request" } });
        send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 2, total: 3, message: "working" } });
        send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 3, message: "stale" } });
        send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 3, total: 3, message: "done" } });
      }
      if (MODE === "toolerror") {
        send({ jsonrpc: "2.0", id, result: textResult("the note store is read-only today", true) });
        return;
      }
      send({ jsonrpc: "2.0", id, result: textResult("note written") });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${String(name)}` } });
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } });
}

if (MODE === "banner") {
  // Out of spec, and common: a server that prints a startup line to stdout.
  process.stdout.write("clarkcant reference server starting\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch {
        // A malformed request is dropped rather than killing the server.
      }
    }
    index = buffer.indexOf("\n");
  }
});
