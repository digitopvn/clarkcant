/*
 * The package's service: a Model Context Protocol server over standard streams that looks words up with a provider.
 *
 * Its container has no network, and it never holds the provider's key. It asks the node instead: it sends the node the
 * request `clarkcant/egress.fetch`, and the node makes the HTTP request to the origin this package declared, adding the
 * key the person stored for this package. What comes back has had the key removed, whatever the provider sent.
 *
 * The origin is read from the package's own manifest, next to this folder, so the service asks for exactly what was
 * declared. No dependencies on purpose: the container mounts the package read-only.
 */

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../clarkcant.json", import.meta.url), "utf8"));
const ORIGIN = manifest.facets.find((facet) => facet.kind === "tools")?.egress?.origins?.[0]?.origin;

const TOOLS = [
  {
    name: "define",
    description: "Look a word up with the provider.",
    inputSchema: {
      type: "object",
      properties: { word: { type: "string", minLength: 1, maxLength: 60, pattern: "^[A-Za-z-]+$" } },
      required: ["word"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

/** Whether the node said, in `initialize`, that it answers egress requests. */
let egressOffered = false;
/** Requests this service sent the node, by id, waiting for the node's answer. */
const asked = new Map();
let nextAsk = 0;

function askNode(method, params) {
  nextAsk += 1;
  const id = `egress-${String(nextAsk)}`;
  return new Promise((resolve) => {
    asked.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function define(id, word) {
  if (!egressOffered || ORIGIN === undefined) {
    send({ jsonrpc: "2.0", id, result: text("The node does not make requests for this service.", true) });
    return;
  }
  const answer = await askNode("clarkcant/egress.fetch", {
    version: 1,
    url: `${ORIGIN}/define?word=${encodeURIComponent(word)}`,
    headers: { accept: "application/json" },
  });
  if (answer.error !== undefined) {
    send({ jsonrpc: "2.0", id, result: text(`The lookup did not run: ${String(answer.error.message)}`, true) });
    return;
  }
  const body = Buffer.from(answer.result?.body?.data ?? "", "base64").toString("utf8");
  if (answer.result?.status !== 200) {
    send({ jsonrpc: "2.0", id, result: text(`The provider answered ${String(answer.result?.status)}.`, true) });
    return;
  }
  // The provider's whole answer is passed on, so what the node removed from it can be seen.
  send({ jsonrpc: "2.0", id, result: text(`Provider answer: ${body}`) });
}

function handle(message) {
  const { id, method, params } = message;
  // The node's answer to a request this service sent.
  if (method === undefined && id !== undefined) {
    const resolve = asked.get(id);
    if (resolve !== undefined) {
      asked.delete(id);
      resolve(message);
    }
    return;
  }
  if (id === undefined) return;
  if (method === "initialize") {
    egressOffered = params?.capabilities?.experimental?.["clarkcant/egress"]?.version === 1;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "com.example.lookup", version: "1.0.0" },
        capabilities: { tools: { listChanged: false } },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call" && params?.name === "define") {
    void define(id, String(params?.arguments?.word ?? ""));
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } });
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
        // A malformed message is dropped rather than ending the service.
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
