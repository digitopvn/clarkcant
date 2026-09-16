#!/usr/bin/env node
/**
 * Reference MCP server over stdio.
 *
 * Written for the transport tests, so the transport is verified against a real process speaking
 * the real protocol rather than against a mock that agrees with whatever the transport does. It
 * implements exactly enough to be a server: initialize, tools/list, tools/call, plus two failure
 * modes a client has to survive.
 *
 * Behaviour chosen by `MCP_FIXTURE_MODE`:
 *   (unset)   normal
 *   "hang"    accepts initialize, then never answers tools/list
 *   "crash"   accepts initialize, then exits when a tool is called
 *   "banner"  prints a non-JSON line to stdout before the protocol starts
 *   "malformed" returns a tool object that does not match the protocol shape
 *   "toolerror" makes the tool report failure through the protocol's isError
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

function handle(request) {
  const { id, method, params } = request;
  if (id === undefined) return;

  if (method === "initialize") {
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

  if (method === "tools/list") {
    if (MODE === "hang") return;
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
    if (name === "echo") {
      send({ jsonrpc: "2.0", id, result: textResult(String(params?.arguments?.text ?? "")) });
      return;
    }
    if (name === "write_note") {
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
