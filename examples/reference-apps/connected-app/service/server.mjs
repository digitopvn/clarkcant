/*
 * The connected app's service: a Model Context Protocol server over standard streams that lists and renames tasks in
 * the person's account at the provider the package declares.
 *
 * It never holds the account. Its container has no network and it is given no token: it asks the node with
 * `clarkcant/egress.fetch`, naming a URL on one of the connection's declared endpoints, and the node adds the
 * connection's token itself, only while one of this service's calls is running, and only to those endpoints. When the
 * connection is missing, expired, revoked or lacks a scope, the node does not send the call at all and says why, so
 * nothing here decides whether the account may be used.
 *
 * It never retries a write: a rename whose answer did not come back may have happened, and that is the node's to
 * record as unknown, not this service's to send again.
 *
 * The endpoint is read from the package's own manifest, next to this folder, so the service asks for exactly what was
 * declared. No dependencies on purpose: the container mounts the package read-only.
 */

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../clarkcant.json", import.meta.url), "utf8"));
const connection = manifest.facets.find((facet) => facet.kind === "tools")?.connection;
const ENDPOINT = connection?.endpoints?.[0];

const TOOLS = [
  {
    name: "list-tasks",
    description: "List the tasks in the connected account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "update-task",
    description: "Rename one task in the connected account.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9-]+$" },
        title: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["id", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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

/** What the provider said, in words the person can act on. Never the response headers, which the node already cleaned. */
function providerProblem(status, body) {
  if (status === 401) return "The provider no longer accepts the connection; reconnect it in Settings.";
  if (status === 403) return `The connection was not granted ${String(body?.scope ?? "the access this needs")}; reconnect it in Settings and allow it.`;
  if (status === 404) return "The provider has no such task.";
  if (status === 422) return "The provider refused that title: it must be 1 to 200 characters.";
  return `The provider answered ${String(status)}.`;
}

/** One request to the provider through the node. Answers the parsed JSON body, or the words to show instead. */
async function provider(method, path, body) {
  if (!egressOffered || ENDPOINT === undefined) return { ok: false, message: "This node does not make requests for this service." };
  const answer = await askNode("clarkcant/egress.fetch", {
    version: 1,
    url: `${ENDPOINT}${path}`,
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: { encoding: "utf8", data: JSON.stringify(body) } }),
  });
  if (answer.error !== undefined) return { ok: false, message: `The request was not sent: ${String(answer.error.message)}` };
  const status = answer.result?.status;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(answer.result?.body?.data ?? "", "base64").toString("utf8") || "null");
  } catch {
    parsed = null;
  }
  if (status !== 200) return { ok: false, message: providerProblem(status, parsed) };
  return { ok: true, body: parsed };
}

async function listTasks(id) {
  const answer = await provider("GET", "/api/tasks");
  if (!answer.ok) return send({ jsonrpc: "2.0", id, result: text(answer.message, true) });
  const tasks = Array.isArray(answer.body?.tasks)
    ? answer.body.tasks.slice(0, 50).map((task) => ({ id: String(task.id), title: String(task.title).slice(0, 200), done: task.done === true }))
    : [];
  send({ jsonrpc: "2.0", id, result: text(JSON.stringify({ tasks })) });
}

async function updateTask(id, args) {
  const taskId = typeof args?.id === "string" ? args.id : "";
  const title = typeof args?.title === "string" ? args.title.trim() : "";
  if (!/^[A-Za-z0-9-]{1,40}$/.test(taskId) || title.length === 0 || title.length > 200) {
    return send({ jsonrpc: "2.0", id, result: text("A task needs its id and a title of 1 to 200 characters.", true) });
  }
  // Sent once. Whatever happens to the answer, this service does not send it again.
  const answer = await provider("PATCH", `/api/tasks/${encodeURIComponent(taskId)}`, { title });
  if (!answer.ok) return send({ jsonrpc: "2.0", id, result: text(answer.message, true) });
  const task = answer.body?.task;
  send({ jsonrpc: "2.0", id, result: text(JSON.stringify({ task: { id: String(task?.id ?? taskId), title: String(task?.title ?? title) } })) });
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
        serverInfo: { name: manifest.id, version: manifest.version },
        capabilities: { tools: { listChanged: false } },
      },
    });
    return;
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call" && params?.name === "list-tasks") return void listTasks(id);
  if (method === "tools/call" && params?.name === "update-task") return void updateTask(id, params?.arguments);
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
