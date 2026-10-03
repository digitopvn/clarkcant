/*
 * The service version 1.1.0 adds: a Model Context Protocol server over standard streams that reads the week's forecast.
 *
 * Its container has no network. It asks the node with `clarkcant/egress.fetch`, and the node makes the request to the
 * origin this package declares, which is the reach the update journey (apps/web/e2e/update-reach.spec.ts) shows before
 * the update is applied. No dependencies on purpose: the container mounts the package read-only.
 */

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../clarkcant.json", import.meta.url), "utf8"));
const ORIGIN = manifest.facets.find((facet) => facet.kind === "tools")?.egress?.origins?.[0]?.origin;

const TOOLS = [
  {
    name: "week",
    description: "Read the week's forecast.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

let egressOffered = false;
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

async function week(id) {
  if (!egressOffered || ORIGIN === undefined) {
    send({ jsonrpc: "2.0", id, result: text("The node does not make requests for this service.", true) });
    return;
  }
  const answer = await askNode("clarkcant/egress.fetch", { version: 1, url: `${ORIGIN}/week`, headers: { accept: "application/json" } });
  if (answer.error !== undefined || answer.result?.status !== 200) {
    send({ jsonrpc: "2.0", id, result: text("The forecast could not be read.", true) });
    return;
  }
  send({ jsonrpc: "2.0", id, result: text(Buffer.from(answer.result.body?.data ?? "", "base64").toString("utf8")) });
}

function handle(message) {
  const { id, method, params } = message;
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
        serverInfo: { name: "com.acme.forecast", version: "1.1.0" },
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
  if (method === "tools/call" && params?.name === "week") {
    void week(id);
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
